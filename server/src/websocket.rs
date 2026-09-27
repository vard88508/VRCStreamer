use std::{
    net::{IpAddr, SocketAddr},
    sync::{Arc, atomic::Ordering},
    time::{Duration, Instant},
};

use axum::{
    extract::{
        ConnectInfo, Query, State,
        ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade, close_code},
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use futures_util::SinkExt;
use serde::Deserialize;
use tokio::time::{Instant as TokioInstant, sleep_until, timeout};
use tracing::{debug, info, warn};

use super::limits::{
    ConnectionGuard, StreamerIpGuard, TokenBucket, try_acquire_connection, try_acquire_streamer_ip,
};
use super::media::{
    AudioMessage, StreamerMediaFrame, VideoFrame, VideoMessage, h264_sdp_fmtp,
    parse_streamer_media_frame,
};
use super::{
    AAC_ABUSE_BURST_SECS, AAC_ABUSE_MAX_FRAMES_PER_SECOND, AAC_ABUSE_MAX_INGEST_BYTES_PER_SECOND,
    AAC_INGEST_BURST_SECS, AAC_MAX_FRAMES_PER_SECOND, AAC_MAX_INGEST_BYTES_PER_SECOND,
    AAC_SAMPLE_RATE, AppState, Channel, Config, DEFAULT_TOKEN_BUCKET_BURST_SECS, H264_CLOCK_RATE,
    MEDIA_CLOCK_RATE, STREAMER_CONTROL_MESSAGES_PER_SECOND, STREAMER_LISTENER_UPDATE_INTERVAL,
    StreamMode, VideoQuality, advance_stream_generation, block_streamer_ip_if_blacklisted,
    cleanup_channel, hash_code, limit_allows, max_ws_message_bytes, origin_allowed,
    password_allowed, peer_id, reserve_channel, stream_id_for_log, streamer_ip_is_blocked,
    text_response, text_response_with_cors, validate_code, wake_media_listeners,
};

const START_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_START_BYTES: usize = 512;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StreamStart {
    mode: StreamMode,
    video_quality: Option<String>,
}

pub(crate) fn parse_stream_start(
    text: &str,
    config: &Config,
) -> Result<(StreamMode, Option<VideoQuality>), &'static str> {
    if text.len() > MAX_START_BYTES {
        return Err("stream configuration is too large");
    }
    let start: StreamStart =
        serde_json::from_str(text).map_err(|_| "invalid stream configuration")?;
    let quality = match start.mode {
        StreamMode::Audio if start.video_quality.is_none() => None,
        StreamMode::Audio => return Err("audio mode cannot select video quality"),
        StreamMode::Video if !config.video_enabled => return Err("video is disabled"),
        StreamMode::Video => Some(
            *config
                .video_qualities
                .iter()
                .find(|quality| {
                    start.video_quality.as_deref() == Some(quality.to_string().as_str())
                })
                .ok_or("invalid video quality")?,
        ),
    };
    Ok((start.mode, quality))
}

#[derive(Deserialize)]
pub(crate) struct StreamQuery {
    code: String,
    password: Option<String>,
}

pub(crate) struct MediaTimestampNormalizer {
    source_clock_rate: u32,
    previous: Option<u32>,
    wrap_offset: u64,
}

async fn close_for_policy(socket: &mut WebSocket, reason: &'static str) {
    let _ = timeout(
        Duration::from_secs(2),
        socket.send(Message::Close(Some(CloseFrame {
            code: close_code::POLICY,
            reason: reason.into(),
        }))),
    )
    .await;
}

impl MediaTimestampNormalizer {
    pub(crate) fn new(source_clock_rate: u32) -> Self {
        Self {
            source_clock_rate,
            previous: None,
            wrap_offset: 0,
        }
    }

    pub(crate) fn normalize(&mut self, source_timestamp: u32) -> u64 {
        if let Some(previous) = self.previous
            && source_timestamp < previous
            && previous - source_timestamp > u32::MAX / 2
        {
            self.wrap_offset = self.wrap_offset.saturating_add(1_u64 << 32);
        }
        self.previous = Some(source_timestamp);

        let unwrapped = self.wrap_offset.saturating_add(source_timestamp as u64);
        (unwrapped as u128 * MEDIA_CLOCK_RATE as u128 / self.source_clock_rate as u128) as u64
    }
}

struct StreamerGuard {
    state: Arc<AppState>,
    key: String,
    channel: Arc<Channel>,
    peer: String,
    ip: IpAddr,
    mode: Option<StreamMode>,
    _ip_guard: Option<StreamerIpGuard>,
    _connection_guard: ConnectionGuard,
}

impl Drop for StreamerGuard {
    fn drop(&mut self) {
        // A reload must not notify this session after its final blacklist check.
        block_streamer_ip_if_blacklisted(&self.state, &self.key, self.ip);
        self.channel.mode.store(0, Ordering::Release);
        self.channel.set_video_fmtp(None);
        advance_stream_generation(&self.channel);
        wake_media_listeners(&self.channel);
        if let Some(mode) = self.mode {
            self.state
                .streams
                .counter(mode)
                .fetch_sub(1, Ordering::AcqRel);
        }
        self.state.active_streamers.fetch_sub(1, Ordering::AcqRel);
        // Release the reservation only after the old session has cleared its state.
        self.channel.streamer.store(false, Ordering::Release);
        cleanup_channel(&self.state, &self.key, &self.channel);
    }
}

pub(crate) async fn stream_ws(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    Query(query): Query<StreamQuery>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> Response {
    let ip = addr.ip();
    let peer = peer_id(&state, ip);
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

    let key = hash_code(&query.code);
    let stream_id = stream_id_for_log(&key);
    if block_streamer_ip_if_blacklisted(&state, &key, ip) {
        warn!(%peer, %stream_id, "rejected blacklisted stream");
        return text_response_with_cors(
            StatusCode::FORBIDDEN,
            "stream is blacklisted\n",
            &headers,
            &state.config,
        );
    }
    if streamer_ip_is_blocked(&state, ip) {
        warn!(%peer, "rejected blocked streamer");
        return text_response_with_cors(
            StatusCode::FORBIDDEN,
            "streamer is blocked\n",
            &headers,
            &state.config,
        );
    }

    let ip_guard = match try_acquire_streamer_ip(&state, ip) {
        Ok(guard) => guard,
        Err(reason) => {
            return text_response(StatusCode::TOO_MANY_REQUESTS, reason);
        }
    };
    let connection_guard = match try_acquire_connection(&state) {
        Ok(guard) => guard,
        Err(reason) => {
            return text_response(StatusCode::TOO_MANY_REQUESTS, reason);
        }
    };

    let (channel, reserved) = reserve_channel(&state, &key, |channel| {
        channel
            .streamer
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    });
    if !reserved {
        return text_response(
            StatusCode::CONFLICT,
            "stream already has an active streamer\n",
        );
    }
    if state
        .active_streamers
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
            limit_allows(state.config.max_streamers, current).then_some(current.saturating_add(1))
        })
        .is_err()
    {
        channel.streamer.store(false, Ordering::Release);
        cleanup_channel(&state, &key, &channel);
        return text_response(StatusCode::TOO_MANY_REQUESTS, "too many active streamers\n");
    }

    info!(%peer, %stream_id, "streamer connected");
    let max_message_size = max_ws_message_bytes(&state.config);
    let guard = StreamerGuard {
        state,
        key,
        channel,
        peer,
        ip,
        mode: None,
        _ip_guard: ip_guard,
        _connection_guard: connection_guard,
    };
    ws.max_message_size(max_message_size)
        .max_frame_size(max_message_size)
        .read_buffer_size(16 * 1024)
        .on_upgrade(move |socket| streamer_session(socket, guard))
        .into_response()
}

async fn streamer_session(mut socket: WebSocket, mut guard: StreamerGuard) {
    let start = match timeout(START_TIMEOUT, socket.recv()).await {
        Ok(Some(Ok(Message::Text(text)))) => parse_stream_start(&text, &guard.state.config),
        Err(_) => Err("stream configuration timeout"),
        _ => Err("expected stream configuration"),
    };
    let (mode, video_quality) = match start {
        Ok(start) => start,
        Err(reason) => {
            close_for_policy(&mut socket, reason).await;
            return;
        }
    };
    let state = guard.state.as_ref();
    let key = guard.key.as_str();
    let channel = guard.channel.as_ref();
    let peer = guard.peer.as_str();
    let ip = guard.ip;
    let stream_id = stream_id_for_log(key);
    if block_streamer_ip_if_blacklisted(state, key, ip) {
        warn!(%peer, %stream_id, "disconnected blacklisted streamer during startup");
        close_for_policy(&mut socket, "stream is blacklisted").await;
        return;
    }
    if streamer_ip_is_blocked(state, ip) {
        warn!(%peer, "disconnected blocked streamer during startup");
        close_for_policy(&mut socket, "streamer is blocked").await;
        return;
    }
    channel.set_video_fmtp(None);

    let mut video_configured = false;
    let mut audio_ingest = TokenBucket::new();
    let mut audio_frames_ingest = TokenBucket::new();
    let mut audio_abuse_ingest = TokenBucket::new();
    let mut audio_abuse_frames_ingest = TokenBucket::new();
    let mut video_ingest = TokenBucket::new();
    let mut video_frames_ingest = TokenBucket::new();
    let mut control_ingest = TokenBucket::new();
    let mut audio_timestamps = MediaTimestampNormalizer::new(AAC_SAMPLE_RATE);
    let mut video_timestamps = MediaTimestampNormalizer::new(H264_CLOCK_RATE);
    let mut frames = 0usize;
    let mut video_frames = 0usize;
    let mut bytes = 0usize;
    let mut audio_rate_drops = 0usize;
    let mut video_bytes = 0usize;
    let started_at = Instant::now();
    let mut last_report = Instant::now();
    let mut last_listeners = channel.listeners.load(Ordering::Acquire);
    guard.mode = Some(mode);
    state.streams.counter(mode).fetch_add(1, Ordering::AcqRel);
    advance_stream_generation(channel);
    channel.mode.store(mode as u8, Ordering::Release);
    wake_media_listeners(channel);
    if !send_listener_count(&mut socket, "ready", last_listeners).await {
        return;
    }

    let mut idle_sleep = Box::pin(sleep_until(
        TokioInstant::now() + state.config.streamer_idle_timeout,
    ));
    let mut listener_sleep = Box::pin(sleep_until(
        TokioInstant::now() + STREAMER_LISTENER_UPDATE_INTERVAL,
    ));
    let blacklist_notification = channel.blacklist_notify.notified();
    tokio::pin!(blacklist_notification);

    loop {
        let message = tokio::select! {
            _ = &mut blacklist_notification => {
                if block_streamer_ip_if_blacklisted(state, key, ip) {
                    warn!(%peer, %stream_id, "disconnected blacklisted streamer");
                    close_for_policy(&mut socket, "stream is blacklisted").await;
                    break;
                }
                blacklist_notification
                    .as_mut()
                    .set(channel.blacklist_notify.notified());
                continue;
            }
            message = socket.recv() => {
                match message {
                    Some(Ok(message)) => message,
                    Some(Err(error)) => {
                        if is_websocket_disconnect_noise(&error) {
                            debug!(%peer, %stream_id, %error, "streamer websocket disconnected");
                        } else {
                            warn!(%peer, %stream_id, %error, "streamer websocket error");
                        }
                        break;
                    }
                    None => break,
                }
            }
            _ = &mut idle_sleep => {
                warn!(%peer, %stream_id, "streamer idle timeout");
                close_for_policy(&mut socket, "streamer idle timeout").await;
                break;
            }
            _ = &mut listener_sleep => {
                let listeners = channel.listeners.load(Ordering::Acquire);
                if listeners != last_listeners {
                    if !send_listener_count(&mut socket, "listeners", listeners).await {
                        break;
                    }
                    last_listeners = listeners;
                }
                listener_sleep.as_mut().reset(
                    TokioInstant::now() + STREAMER_LISTENER_UPDATE_INTERVAL,
                );
                continue;
            }
        };

        if matches!(
            &message,
            Message::Ping(_) | Message::Pong(_) | Message::Text(_)
        ) && !control_ingest.allow(
            1,
            STREAMER_CONTROL_MESSAGES_PER_SECOND,
            DEFAULT_TOKEN_BUCKET_BURST_SECS,
        ) {
            warn!(%peer, %stream_id, "streamer exceeded control message rate");
            close_for_policy(&mut socket, "control message rate exceeded").await;
            break;
        }

        match message {
            Message::Binary(frame) => {
                let received_at = Instant::now();
                match frame.first().copied() {
                    Some(0x00) => {
                        let within_abuse_frame_rate = audio_abuse_frames_ingest.allow_at(
                            received_at,
                            1,
                            AAC_ABUSE_MAX_FRAMES_PER_SECOND,
                            AAC_ABUSE_BURST_SECS,
                        );
                        let within_abuse_byte_rate = audio_abuse_ingest.allow_at(
                            received_at,
                            frame.len(),
                            AAC_ABUSE_MAX_INGEST_BYTES_PER_SECOND,
                            AAC_ABUSE_BURST_SECS,
                        );
                        if !within_abuse_frame_rate || !within_abuse_byte_rate {
                            warn!(
                                %peer,
                                %stream_id,
                                frame_bytes = frame.len(),
                                "streamer exceeded hard aac ingest limit"
                            );
                            close_for_policy(&mut socket, "AAC abuse rate exceeded").await;
                            break;
                        }

                        let within_frame_rate = audio_frames_ingest.allow_at(
                            received_at,
                            1,
                            AAC_MAX_FRAMES_PER_SECOND,
                            AAC_INGEST_BURST_SECS,
                        );
                        let within_byte_rate = audio_ingest.allow_at(
                            received_at,
                            frame.len(),
                            AAC_MAX_INGEST_BYTES_PER_SECOND,
                            AAC_INGEST_BURST_SECS,
                        );
                        if !within_frame_rate || !within_byte_rate {
                            audio_rate_drops = audio_rate_drops.saturating_add(1);
                            if audio_rate_drops == 1 {
                                warn!(
                                    %peer,
                                    %stream_id,
                                    frame_bytes = frame.len(),
                                    "dropping excess aac frames to keep streamer connected"
                                );
                            }
                            continue;
                        }
                    }
                    Some(0x01 | 0x02) => {
                        let Some(quality) = video_quality else {
                            close_for_policy(&mut socket, "video is disabled for this stream")
                                .await;
                            break;
                        };
                        if !video_frames_ingest.allow_at(
                            received_at,
                            1,
                            quality.max_ingest_frames_per_second(),
                            state.config.video_ingest_burst_secs,
                        ) {
                            warn!(%peer, %stream_id, "streamer exceeded selected video frame rate");
                            close_for_policy(&mut socket, "video frame rate exceeded").await;
                            break;
                        }
                        if !video_ingest.allow_at(
                            received_at,
                            frame.len(),
                            quality.video_bytes_per_second(),
                            state.config.video_ingest_burst_secs,
                        ) {
                            warn!(%peer, %stream_id, frame_bytes = frame.len(),
                                available_bytes = video_ingest.available_units(),
                                target_kbps = quality.bitrate_kbps,
                                burst_secs = state.config.video_ingest_burst_secs,
                                "streamer exceeded selected video ingest rate");
                            close_for_policy(&mut socket, "video ingest rate exceeded").await;
                            break;
                        }
                    }
                    _ => {}
                }
                match parse_streamer_media_frame(frame, &state.config) {
                    Ok(StreamerMediaFrame::Audio {
                        access_unit,
                        source_timestamp,
                    }) => {
                        let frame_len = access_unit.len();
                        let _ = channel.audio_tx.send(AudioMessage::Frame {
                            access_unit,
                            media_timestamp: audio_timestamps.normalize(source_timestamp),
                            published_at: received_at,
                        });
                        frames += 1;
                        bytes = bytes.saturating_add(frame_len);
                        if frames == 1 {
                            info!(%peer, %stream_id, "streamer sent first aac frame");
                        }
                    }
                    Ok(StreamerMediaFrame::Video {
                        access_unit,
                        keyframe,
                        single_nal,
                        source_timestamp,
                    }) => {
                        if keyframe && !video_configured {
                            match h264_sdp_fmtp(&access_unit) {
                                Ok(fmtp) => {
                                    channel.set_video_fmtp(Some(Arc::from(fmtp)));
                                    video_configured = true;
                                }
                                Err(reason) => {
                                    warn!(%peer, %stream_id, %reason, "h264 keyframe has no SDP parameter sets");
                                    close_for_policy(
                                        &mut socket,
                                        "initial video keyframe needs SPS/PPS",
                                    )
                                    .await;
                                    break;
                                }
                            }
                        }
                        if !video_configured {
                            close_for_policy(&mut socket, "video must start with a keyframe").await;
                            break;
                        }
                        let frame_len = access_unit.len();
                        let frame = VideoFrame {
                            access_unit,
                            keyframe,
                            single_nal,
                            media_timestamp: video_timestamps.normalize(source_timestamp),
                            published_at: received_at,
                        };
                        let _ = channel.video_tx.send(VideoMessage::Frame(frame));
                        video_frames += 1;
                        video_bytes = video_bytes.saturating_add(frame_len);
                        if video_frames == 1 {
                            info!(%peer, %stream_id, keyframe, "streamer sent first h264 frame");
                        }
                    }
                    Err(reason) => {
                        warn!(%peer, %stream_id, %reason, "streamer sent invalid media frame");
                        close_for_policy(&mut socket, "invalid media frame").await;
                        break;
                    }
                }

                idle_sleep
                    .as_mut()
                    .reset(TokioInstant::now() + state.config.streamer_idle_timeout);

                if (frames + video_frames).is_multiple_of(250)
                    || received_at.saturating_duration_since(last_report) >= Duration::from_secs(5)
                {
                    let elapsed = received_at
                        .saturating_duration_since(started_at)
                        .as_secs_f64()
                        .max(0.001);
                    info!(
                        %peer,
                        %stream_id,
                        audio_frames = frames,
                        audio_bytes = bytes,
                        audio_fps = frames as f64 / elapsed,
                        audio_kbps = (bytes as f64 * 8.0 / 1000.0) / elapsed,
                        audio_rate_drops,
                        video_frames,
                        video_bytes,
                        video_fps = video_frames as f64 / elapsed,
                        video_kbps = (video_bytes as f64 * 8.0 / 1000.0) / elapsed,
                        "streamer media rate"
                    );
                    last_report = received_at;
                }
            }
            Message::Ping(_) => {
                if !matches!(
                    timeout(Duration::from_secs(5), socket.flush()).await,
                    Ok(Ok(()))
                ) {
                    break;
                }
            }
            Message::Pong(_) => {}
            Message::Close(frame) => {
                if let Some(frame) = &frame {
                    debug!(%peer, %stream_id, code = frame.code, reason = %frame.reason, "streamer requested websocket close");
                } else {
                    debug!(%peer, %stream_id, "streamer requested websocket close");
                }
                // Tungstenite has already queued the close acknowledgement.
                let _ = timeout(Duration::from_secs(2), socket.flush()).await;
                break;
            }
            Message::Text(_) => {
                close_for_policy(
                    &mut socket,
                    "stream configuration is fixed until disconnect",
                )
                .await;
                break;
            }
        }
    }

    info!(
        %peer,
        %stream_id,
        audio_frames = frames,
        audio_rate_drops,
        video_frames,
        "streamer disconnected"
    );
}

async fn send_listener_count(socket: &mut WebSocket, kind: &str, listeners: usize) -> bool {
    let message = format!("{{\"type\":\"{kind}\",\"listeners\":{listeners}}}");
    matches!(
        timeout(
            Duration::from_secs(5),
            socket.send(Message::Text(message.into()))
        )
        .await,
        Ok(Ok(()))
    )
}

pub(crate) fn is_websocket_disconnect_noise(error: &dyn std::fmt::Display) -> bool {
    let text = error.to_string().to_ascii_lowercase();
    text.contains("connection reset without closing handshake")
        || text.contains("connection reset by peer")
        || text.contains("broken pipe")
}
