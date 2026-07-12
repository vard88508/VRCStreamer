use std::{
    net::SocketAddr,
    sync::{Arc, atomic::Ordering},
    time::{Duration, Instant},
};

use axum::{
    extract::{
        ConnectInfo, Query, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use tokio::time::{Instant as TokioInstant, sleep_until};
use tracing::{debug, info, warn};

use super::limits::{StreamerIpGuard, TokenBucket, try_acquire_streamer_ip};
use super::media::{
    AudioMessage, StreamerMediaFrame, VideoMessage, h264_sdp_fmtp, parse_streamer_media_frame,
};
use super::{
    AAC_MAX_INGEST_BYTES_PER_SECOND, AppState, Channel, DEFAULT_TOKEN_BUCKET_BURST_SECS,
    KEYFRAME_REQUEST_MESSAGE, STREAMER_CONTROL_MESSAGES_PER_SECOND,
    STREAMER_LISTENER_UPDATE_INTERVAL, active_listeners, allow_http_request, cleanup_channel,
    connection_limit_allows, force_resync_channel, get_or_create_channel, hash_code, limit_allows,
    max_ws_message_bytes, origin_allowed, password_allowed, peer_id, public_rtsp_base,
    streamer_hello_message, streamer_listeners_message, text_response, text_response_with_cors,
    validate_code, wake_media_listeners, wake_video_listeners,
};

pub(crate) enum StreamerTextCommand {
    ForceResync,
    VideoStart,
    VideoStop,
    VideoReset,
    VideoQuality(usize),
}

#[derive(Deserialize)]
pub(crate) struct IngestQuery {
    code: String,
    password: Option<String>,
}

pub(crate) async fn ingest_ws(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    Query(query): Query<IngestQuery>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> Response {
    let peer = peer_id(&state, addr.ip());
    if !allow_http_request(&state, addr.ip()) {
        warn!(%peer, "rejected streamer over http request rate limit");
        return text_response_with_cors(
            StatusCode::TOO_MANY_REQUESTS,
            "too many requests\n",
            &headers,
            &state.config,
        );
    }

    if !origin_allowed(&headers, &state.config) {
        warn!(%peer, "rejected streamer with invalid origin");
        return text_response(StatusCode::FORBIDDEN, "origin is not allowed\n");
    }

    if !password_allowed(query.password.as_deref(), &state.config) {
        warn!(%peer, "rejected streamer with invalid password");
        return text_response_with_cors(
            StatusCode::UNAUTHORIZED,
            "invalid stream password\n",
            &headers,
            &state.config,
        );
    }

    if let Err(reason) = validate_code(&query.code) {
        return text_response(StatusCode::BAD_REQUEST, reason);
    }

    let ip_guard = match try_acquire_streamer_ip(&state, addr.ip()) {
        Ok(guard) => guard,
        Err(reason) => {
            return text_response(StatusCode::TOO_MANY_REQUESTS, reason);
        }
    };

    let key = hash_code(&query.code);
    let channel = get_or_create_channel(&state, &key).await;
    if channel
        .streamer
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return text_response(
            StatusCode::CONFLICT,
            "stream already has an active streamer\n",
        );
    }
    if state
        .active_streamers
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
            (limit_allows(state.config.max_streamers, current)
                && connection_limit_allows(
                    state.as_ref(),
                    current,
                    active_listeners(state.as_ref()),
                ))
            .then_some(current + 1)
        })
        .is_err()
    {
        channel.streamer.store(false, Ordering::Release);
        cleanup_channel(&state, &key, &channel).await;
        return text_response(StatusCode::TOO_MANY_REQUESTS, "too many active streamers\n");
    }

    info!(%peer, %key, "aac streamer connected");
    let rtsp_base = public_rtsp_base(&state.config, &headers);
    ws.max_message_size(max_ws_message_bytes(&state.config))
        .on_upgrade(move |socket| {
            streamer_session(socket, state, key, channel, peer, ip_guard, rtsp_base)
        })
        .into_response()
}

async fn streamer_session(
    mut socket: WebSocket,
    state: Arc<AppState>,
    key: String,
    channel: Arc<Channel>,
    peer: String,
    _ip_guard: Option<StreamerIpGuard>,
    rtsp_base: String,
) {
    channel.set_video_fmtp(None);

    let mut video_configured = false;
    let mut audio_ingest = TokenBucket::new();
    let mut video_ingest = TokenBucket::new();
    let mut control_ingest = TokenBucket::new();
    let mut video_quality = 0usize;
    let mut frames = 0usize;
    let mut video_frames = 0usize;
    let mut bytes = 0usize;
    let mut video_bytes = 0usize;
    let started_at = Instant::now();
    let mut last_report = Instant::now();
    let mut last_listeners = channel.listeners.load(Ordering::Acquire);
    if socket
        .send(Message::Text(
            streamer_hello_message(&state.config, last_listeners, &rtsp_base).into(),
        ))
        .await
        .is_err()
    {
        finish_streamer(&state, &key, &channel, &peer, frames).await;
        return;
    }
    wake_media_listeners(&channel);

    let mut idle_sleep = Box::pin(sleep_until(
        TokioInstant::now() + state.config.streamer_idle_timeout,
    ));
    let mut listener_sleep = Box::pin(sleep_until(
        TokioInstant::now() + STREAMER_LISTENER_UPDATE_INTERVAL,
    ));

    loop {
        let message = tokio::select! {
            message = socket.recv() => {
                idle_sleep.as_mut().reset(TokioInstant::now() + state.config.streamer_idle_timeout);
                match message {
                    Some(Ok(message)) => message,
                    Some(Err(error)) => {
                        if is_websocket_disconnect_noise(&error) {
                            debug!(%peer, %key, %error, "streamer websocket disconnected");
                        } else {
                            warn!(%peer, %key, %error, "streamer websocket error");
                        }
                        break;
                    }
                    None => break,
                }
            }
            _ = &mut idle_sleep => {
                warn!(%peer, %key, "streamer idle timeout");
                let _ = socket.send(Message::Close(None)).await;
                break;
            }
            _ = &mut listener_sleep => {
                let listeners = channel.listeners.load(Ordering::Acquire);
                if listeners != last_listeners {
                    if socket
                        .send(Message::Text(streamer_listeners_message(listeners).into()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                    last_listeners = listeners;
                }
                listener_sleep.as_mut().reset(
                    TokioInstant::now() + STREAMER_LISTENER_UPDATE_INTERVAL,
                );
                continue;
            }
            _ = channel.keyframe_notify.notified() => {
                if channel.keyframe_pending.swap(false, Ordering::AcqRel)
                    && channel.video_active.load(Ordering::Acquire)
                    && socket
                        .send(Message::Text(KEYFRAME_REQUEST_MESSAGE.into()))
                        .await
                        .is_err()
                {
                    break;
                }
                continue;
            }
        };

        match message {
            Message::Binary(frame) => {
                match frame.first().copied() {
                    Some(0x00)
                        if !audio_ingest.allow(
                            frame.len(),
                            AAC_MAX_INGEST_BYTES_PER_SECOND,
                            DEFAULT_TOKEN_BUCKET_BURST_SECS,
                        ) =>
                    {
                        warn!(%peer, %key, "streamer exceeded aac ingest rate");
                        let _ = socket.send(Message::Close(None)).await;
                        break;
                    }
                    Some(0x01 | 0x02)
                        if state.config.video_enabled
                            && !video_ingest.allow(
                                frame.len(),
                                state.config.video_qualities[video_quality]
                                    .video_bytes_per_second(),
                                state.config.video_ingest_burst_secs,
                            ) =>
                    {
                        let bytes_per_second =
                            state.config.video_qualities[video_quality].video_bytes_per_second();
                        warn!(
                            %peer,
                            %key,
                            video_quality,
                            frame_bytes = frame.len(),
                            available_bytes = video_ingest.available_units(),
                            capacity_bytes = bytes_per_second
                                .saturating_mul(state.config.video_ingest_burst_secs),
                            target_kbps = state.config.video_qualities[video_quality].bitrate_kbps,
                            burst_secs = state.config.video_ingest_burst_secs,
                            "streamer exceeded selected video ingest rate"
                        );
                        let _ = socket.send(Message::Close(None)).await;
                        break;
                    }
                    _ => {}
                }
                match parse_streamer_media_frame(frame, &state.config) {
                    Ok(StreamerMediaFrame::Audio {
                        access_unit,
                        rtp_timestamp,
                    }) => {
                        let frame_len = access_unit.len();
                        if frames == 0 {
                            wake_video_listeners(&channel);
                        }
                        let _ = channel.audio_tx.send(AudioMessage::Frame {
                            access_unit,
                            rtp_timestamp,
                        });
                        frames += 1;
                        bytes = bytes.saturating_add(frame_len);
                        if frames == 1 {
                            info!(%peer, %key, "streamer sent first aac frame");
                        }
                    }
                    Ok(StreamerMediaFrame::Video {
                        access_unit,
                        keyframe,
                        rtp_timestamp,
                    }) => {
                        if !channel.video_active.swap(true, Ordering::AcqRel) {
                            wake_video_listeners(&channel);
                        }
                        if keyframe && !video_configured {
                            match h264_sdp_fmtp(&access_unit) {
                                Ok(fmtp) => {
                                    channel.set_video_fmtp(Some(Arc::from(fmtp)));
                                    video_configured = true;
                                }
                                Err(reason) => {
                                    debug!(%peer, %key, %reason, "h264 keyframe has no SDP parameter sets");
                                }
                            }
                        }
                        let frame_len = access_unit.len();
                        let _ = channel.video_tx.send(VideoMessage::Frame {
                            access_unit,
                            keyframe,
                            rtp_timestamp,
                        });
                        video_frames += 1;
                        video_bytes = video_bytes.saturating_add(frame_len);
                        if video_frames == 1 {
                            info!(%peer, %key, keyframe, "streamer sent first h264 frame");
                        }
                    }
                    Err(reason) => {
                        warn!(%peer, %key, %reason, "streamer sent invalid media frame");
                        let _ = socket.send(Message::Close(None)).await;
                        break;
                    }
                }

                if (frames + video_frames).is_multiple_of(250)
                    || last_report.elapsed() >= Duration::from_secs(5)
                {
                    let elapsed = started_at.elapsed().as_secs_f64().max(0.001);
                    info!(
                        %peer,
                        %key,
                        audio_frames = frames,
                        audio_bytes = bytes,
                        audio_fps = frames as f64 / elapsed,
                        audio_kbps = (bytes as f64 * 8.0 / 1000.0) / elapsed,
                        video_frames,
                        video_bytes,
                        video_fps = video_frames as f64 / elapsed,
                        video_kbps = (video_bytes as f64 * 8.0 / 1000.0) / elapsed,
                        "streamer media rate"
                    );
                    last_report = Instant::now();
                }
            }
            Message::Ping(payload) => {
                if !control_ingest.allow(
                    1,
                    STREAMER_CONTROL_MESSAGES_PER_SECOND,
                    DEFAULT_TOKEN_BUCKET_BURST_SECS,
                ) {
                    warn!(%peer, %key, "streamer exceeded control message rate");
                    let _ = socket.send(Message::Close(None)).await;
                    break;
                }
                let _ = socket.send(Message::Pong(payload)).await;
            }
            Message::Pong(_) => {
                if !control_ingest.allow(
                    1,
                    STREAMER_CONTROL_MESSAGES_PER_SECOND,
                    DEFAULT_TOKEN_BUCKET_BURST_SECS,
                ) {
                    warn!(%peer, %key, "streamer exceeded control message rate");
                    let _ = socket.send(Message::Close(None)).await;
                    break;
                }
            }
            Message::Close(frame) => {
                let _ = socket.send(Message::Close(frame)).await;
                break;
            }
            Message::Text(text) => {
                if !control_ingest.allow(
                    1,
                    STREAMER_CONTROL_MESSAGES_PER_SECOND,
                    DEFAULT_TOKEN_BUCKET_BURST_SECS,
                ) {
                    warn!(%peer, %key, "streamer exceeded control message rate");
                    let _ = socket.send(Message::Close(None)).await;
                    break;
                }
                let command = streamer_text_command(text.as_str());
                if !state.config.video_enabled
                    && matches!(
                        command,
                        Some(
                            StreamerTextCommand::VideoStart
                                | StreamerTextCommand::VideoStop
                                | StreamerTextCommand::VideoReset
                                | StreamerTextCommand::VideoQuality(_)
                        )
                    )
                {
                    warn!(%peer, %key, "streamer sent video command while video is disabled");
                    let _ = socket.send(Message::Close(None)).await;
                    break;
                }
                match command {
                    Some(StreamerTextCommand::ForceResync) => {
                        let epoch = force_resync_channel(&channel);
                        let listeners = channel.listeners.load(Ordering::Acquire);
                        info!(%peer, %key, epoch, listeners, "streamer forced rtsp resync");
                    }
                    Some(StreamerTextCommand::VideoStart) => {
                        video_configured = false;
                        channel.set_video_fmtp(None);
                        channel.video_active.store(true, Ordering::Release);
                        wake_video_listeners(&channel);
                        debug!(%peer, %key, "streamer started h264 video");
                    }
                    Some(StreamerTextCommand::VideoStop) => {
                        video_configured = false;
                        channel.set_video_fmtp(None);
                        channel.video_active.store(false, Ordering::Release);
                        channel.keyframe_pending.store(false, Ordering::Release);
                        let epoch = force_resync_channel(&channel);
                        wake_video_listeners(&channel);
                        debug!(%peer, %key, epoch, "streamer stopped h264 video");
                    }
                    Some(StreamerTextCommand::VideoReset) => {
                        video_configured = false;
                        channel.set_video_fmtp(None);
                        let epoch = force_resync_channel(&channel);
                        wake_video_listeners(&channel);
                        debug!(%peer, %key, epoch, "streamer reset h264 video configuration");
                    }
                    Some(StreamerTextCommand::VideoQuality(index)) => {
                        if index >= state.config.video_qualities.len() {
                            warn!(%peer, %key, index, "streamer selected invalid video quality");
                            let _ = socket.send(Message::Close(None)).await;
                            break;
                        }
                        video_quality = index;
                        debug!(%peer, %key, index, "streamer selected video quality");
                    }
                    None => {
                        warn!(%peer, %key, "streamer sent text message");
                        let _ = socket.send(Message::Close(None)).await;
                        break;
                    }
                }
            }
        }
    }

    finish_streamer(&state, &key, &channel, &peer, frames).await;
}

async fn finish_streamer(
    state: &Arc<AppState>,
    key: &str,
    channel: &Arc<Channel>,
    peer: &str,
    frames: usize,
) {
    channel.streamer.store(false, Ordering::Release);
    channel.video_active.store(false, Ordering::Release);
    channel.keyframe_pending.store(false, Ordering::Release);
    channel.set_video_fmtp(None);
    wake_media_listeners(channel);
    state.active_streamers.fetch_sub(1, Ordering::AcqRel);
    cleanup_channel(state, key, channel).await;
    info!(%peer, %key, frames, "aac streamer disconnected");
}

pub(crate) fn streamer_text_command(text: &str) -> Option<StreamerTextCommand> {
    let text = text.trim();
    if text.eq_ignore_ascii_case("force_resync") {
        return Some(StreamerTextCommand::ForceResync);
    }
    if text.eq_ignore_ascii_case("video_start") {
        return Some(StreamerTextCommand::VideoStart);
    }
    if text.eq_ignore_ascii_case("video_stop") {
        return Some(StreamerTextCommand::VideoStop);
    }
    if text.eq_ignore_ascii_case("video_reset") {
        return Some(StreamerTextCommand::VideoReset);
    }
    text.strip_prefix("video_quality:")
        .and_then(|index| index.parse().ok())
        .map(StreamerTextCommand::VideoQuality)
}

pub(crate) fn is_websocket_disconnect_noise(error: &dyn std::fmt::Display) -> bool {
    let text = error.to_string().to_ascii_lowercase();
    text.contains("connection reset without closing handshake")
        || text.contains("connection reset by peer")
        || text.contains("broken pipe")
}
