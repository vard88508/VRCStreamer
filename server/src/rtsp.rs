use std::{
    fmt::Write as _,
    io::ErrorKind,
    net::{IpAddr, SocketAddr},
    sync::{Arc, atomic::Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use bytes::Bytes;
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, tcp::OwnedWriteHalf},
    sync::{Mutex, broadcast},
    task::JoinHandle,
    time::{Instant as TokioInstant, sleep_until, timeout},
};
use tracing::{debug, info, warn};

use super::limits::{ListenerIpGuard, try_acquire_listener_ip};
use super::media::{AudioMessage, VideoMessage, find_h264_start_code, start_h264_payload};
use super::{
    AAC_AUDIO_SPECIFIC_CONFIG, AAC_CHANNELS, AAC_FRAME_DURATION, AAC_MAX_ACCESS_UNIT_BYTES,
    AAC_SAMPLE_RATE, AAC_SAMPLES_PER_FRAME, AAC_SILENCE_ACCESS_UNIT, AppState, Channel,
    H264_CLOCK_RATE, Placeholders, RTCP_REPORT_INTERVAL, RTP_AUDIO_PAYLOAD_TYPE, RTP_AUDIO_SSRC,
    RTP_MAX_PAYLOAD_BYTES, RTP_VIDEO_PAYLOAD_TYPE, RTP_VIDEO_SSRC, RTSP_DISCARD_BUFFER_BYTES,
    RTSP_MAX_BODY_BYTES, RTSP_MAX_HEADER_BYTES, RTSP_MAX_HEADERS, RTSP_MAX_LINE_BYTES,
    active_streamers, cleanup_channel, connection_limit_allows, limit_allows, peer_id,
    request_video_keyframe, valid_hash,
};

type SharedRtspWriter = Arc<Mutex<OwnedWriteHalf>>;
const RTCP_MAX_FEEDBACK_BYTES: usize = 4096;
const RTCP_SENDER_REPORT: u8 = 200;
const RTCP_SOURCE_DESCRIPTION: u8 = 202;
const RTCP_PAYLOAD_SPECIFIC_FEEDBACK: u8 = 206;
const RTCP_PLI: u8 = 1;
const RTCP_FIR: u8 = 4;
const NTP_UNIX_EPOCH_OFFSET: u64 = 2_208_988_800;
const MAX_AUDIO_BACKLOG_FRAMES: usize = 12;
const MAX_VIDEO_BACKLOG_FRAMES: usize = 6;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum RtspTrack {
    Audio,
    Video,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum VideoStreamState {
    Offline,
    AudioOnly,
    Video,
}

pub(crate) async fn rtsp_server(state: Arc<AppState>, bind_addr: SocketAddr) {
    let listener = match TcpListener::bind(bind_addr).await {
        Ok(listener) => listener,
        Err(error) => {
            warn!(%error, port = bind_addr.port(), "failed to bind rtsp listener");
            return;
        }
    };

    info!(port = bind_addr.port(), "listening on rtsp");

    loop {
        match listener.accept().await {
            Ok((stream, addr)) => {
                let state = state.clone();
                let peer = peer_id(&state, addr.ip());
                tokio::spawn(async move {
                    if let Err(error) =
                        handle_rtsp_client(stream, peer.clone(), addr.ip(), state).await
                    {
                        warn!(%peer, %error, "rtsp client error");
                    }
                });
            }
            Err(error) => warn!(%error, "rtsp accept error"),
        }
    }
}

async fn handle_rtsp_client(
    stream: tokio::net::TcpStream,
    peer: String,
    ip: IpAddr,
    state: Arc<AppState>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    stream.set_nodelay(true)?;
    let (read_half, write_half) = stream.into_split();
    let writer = Arc::new(Mutex::new(write_half));
    let mut reader = BufReader::new(read_half);
    let listener_ip_guard = match try_acquire_listener_ip(&state, ip) {
        Ok(guard) => guard,
        Err(error) => return Err(error.into()),
    };
    let mut session = RtspSession {
        _listener_ip_guard: listener_ip_guard,
        ..RtspSession::default()
    };
    let handshake_deadline = TokioInstant::now() + state.config.rtsp_handshake_timeout;
    let mut requests = 0usize;
    let mut interleaved_buffer = Vec::new();

    loop {
        let input = if session.guard.is_none() {
            let now = TokioInstant::now();
            if now >= handshake_deadline {
                return Err("rtsp handshake timeout".into());
            }
            match timeout(
                handshake_deadline - now,
                read_rtsp_input(&mut reader, &mut interleaved_buffer),
            )
            .await
            {
                Ok(result) => result?,
                Err(_) => return Err("rtsp handshake timeout".into()),
            }
        } else {
            read_rtsp_input(&mut reader, &mut interleaved_buffer).await?
        };
        let Some(input) = input else {
            break;
        };
        let request = match input {
            RtspInput::Request(request) => request,
            RtspInput::Interleaved {
                channel,
                requests_keyframe,
            } => {
                if requests_keyframe
                    && session.video_setup
                    && channel == session.video_channel.saturating_add(1)
                    && let Some(guard) = session.guard.as_ref()
                {
                    request_video_keyframe(&guard.channel);
                }
                continue;
            }
        };
        requests = requests.saturating_add(1);
        if state.config.max_rtsp_requests_per_connection != 0
            && requests > state.config.max_rtsp_requests_per_connection
        {
            return Err("too many rtsp requests on one connection".into());
        }
        if handle_rtsp_request(&request, &writer, &state, &mut session, &peer).await? {
            break;
        }
    }

    session.stop();
    info!(%peer, "rtsp client disconnected");
    Ok(())
}

async fn handle_rtsp_request(
    request: &RtspRequest,
    writer: &SharedRtspWriter,
    state: &Arc<AppState>,
    session: &mut RtspSession,
    peer: &str,
) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
    let cseq = request.header("cseq").unwrap_or("0");
    info!(%peer, method = %request.method, uri = %request.uri, "rtsp request");

    match request.method.as_str() {
        "OPTIONS" => {
            write_rtsp_response(
                writer,
                "200 OK",
                cseq,
                &[(
                    "Public",
                    "OPTIONS, DESCRIBE, SETUP, PLAY, GET_PARAMETER, TEARDOWN",
                )],
                None,
            )
            .await?;
        }
        "DESCRIBE" => {
            let Some(key) = key_from_rtsp_uri(&request.uri) else {
                write_rtsp_response(writer, "400 Bad Request", cseq, &[], None).await?;
                return Ok(false);
            };
            if !valid_hash(key) {
                write_rtsp_response(writer, "400 Bad Request", cseq, &[], None).await?;
                return Ok(false);
            }

            session.key = Some(key.to_owned());
            let content_base = rtsp_content_base(&request.uri);
            let video_fmtp = rtsp_video_fmtp(state, key).await;
            let sdp = rtsp_sdp(&video_fmtp);
            write_rtsp_response(
                writer,
                "200 OK",
                cseq,
                &[
                    ("Content-Type", "application/sdp"),
                    ("Content-Base", content_base.as_str()),
                ],
                Some(sdp.as_bytes()),
            )
            .await?;
        }
        "SETUP" => {
            let Some(key) = key_from_rtsp_uri(&request.uri)
                .map(str::to_owned)
                .or_else(|| session.key.clone())
            else {
                write_rtsp_response(writer, "400 Bad Request", cseq, &[], None).await?;
                return Ok(false);
            };
            if !valid_hash(&key) {
                write_rtsp_response(writer, "400 Bad Request", cseq, &[], None).await?;
                return Ok(false);
            }

            let transport = request.header("transport").unwrap_or_default();
            if !transport.to_ascii_lowercase().contains("rtp/avp/tcp") {
                write_rtsp_response(writer, "461 Unsupported Transport", cseq, &[], None).await?;
                return Ok(false);
            }

            if session.guard.is_none() {
                match subscribe_listener(state, &key).await {
                    Ok(subscription) => {
                        session.audio_rx = Some(subscription.audio_rx);
                        session.video_rx = Some(subscription.video_rx);
                        session.guard = Some(subscription.guard);
                    }
                    Err(status) => {
                        write_rtsp_response(writer, status, cseq, &[], None).await?;
                        return Ok(false);
                    }
                }
            } else if session.key.as_deref() != Some(key.as_str()) {
                write_rtsp_response(
                    writer,
                    "455 Method Not Valid In This State",
                    cseq,
                    &[],
                    None,
                )
                .await?;
                return Ok(false);
            }

            if session.id.is_none() {
                let id = state.next_rtsp_session.fetch_add(1, Ordering::AcqRel);
                session.id = Some(format!("{id:016x}"));
            }

            let track = rtsp_track_from_uri(&request.uri);
            let rtp_channel = select_rtsp_interleaved_channel(
                session,
                track,
                parse_interleaved_channel(transport),
            );
            session.key = Some(key.clone());
            let (track_name, ssrc) = match track {
                RtspTrack::Audio => {
                    session.audio_setup = true;
                    session.audio_channel = rtp_channel;
                    ("audio", RTP_AUDIO_SSRC)
                }
                RtspTrack::Video => {
                    session.video_setup = true;
                    session.video_channel = rtp_channel;
                    ("video", RTP_VIDEO_SSRC)
                }
            };

            let transport_header = format!(
                "RTP/AVP/TCP;unicast;interleaved={rtp_channel}-{};ssrc={ssrc:08X}",
                rtp_channel + 1,
            );
            write_rtsp_response(
                writer,
                "200 OK",
                cseq,
                &[
                    ("Transport", transport_header.as_str()),
                    ("Session", session.id.as_deref().unwrap_or("1")),
                ],
                None,
            )
            .await?;
            info!(%peer, %key, track = track_name, rtp_channel, "rtsp media setup");
        }
        "PLAY" => {
            if !session.audio_setup && !session.video_setup {
                write_rtsp_response(
                    writer,
                    "455 Method Not Valid In This State",
                    cseq,
                    &[],
                    None,
                )
                .await?;
                return Ok(false);
            }

            let start_audio = if session.audio_setup && session.audio_rtp_task.is_none() {
                let Some(rx) = session.audio_rx.take() else {
                    write_rtsp_response(writer, "454 Session Not Found", cseq, &[], None).await?;
                    return Ok(false);
                };
                let key = session.key.clone().unwrap_or_default();
                let rtp = session.audio_rtp;
                let channel = session.audio_channel;
                Some((rx, key, channel, rtp))
            } else {
                None
            };
            let start_video = if session.video_setup && session.video_rtp_task.is_none() {
                let Some(rx) = session.video_rx.take() else {
                    write_rtsp_response(writer, "454 Session Not Found", cseq, &[], None).await?;
                    return Ok(false);
                };
                let key = session.key.clone().unwrap_or_default();
                let rtp = session.video_rtp;
                let channel = session.video_channel;
                Some((rx, key, channel, rtp))
            } else {
                None
            };

            let Some(guard) = session.guard.take() else {
                write_rtsp_response(writer, "454 Session Not Found", cseq, &[], None).await?;
                return Ok(false);
            };
            let stream = guard.channel.clone();
            session.guard = Some(guard);

            let rtp_info = rtsp_rtp_info(&request.uri, session);
            write_rtsp_response(
                writer,
                "200 OK",
                cseq,
                &[
                    ("Range", "npt=0.000-"),
                    ("RTP-Info", rtp_info.as_str()),
                    ("Session", session.id.as_deref().unwrap_or("1")),
                ],
                None,
            )
            .await?;

            let play_started_at = TokioInstant::now();
            if let Some((rx, key, channel, rtp)) = start_audio {
                session.audio_rtp_task = Some(tokio::spawn(rtsp_audio_rtp_task(RtspAudioTask {
                    writer: writer.clone(),
                    rx,
                    stream: stream.clone(),
                    key,
                    peer: peer.to_owned(),
                    channel,
                    rtp,
                    play_started_at,
                })));
            }
            if let Some((rx, key, channel, rtp)) = start_video {
                session.video_rtp_task = Some(tokio::spawn(rtsp_video_rtp_task(RtspVideoTask {
                    writer: writer.clone(),
                    rx,
                    state: state.clone(),
                    stream,
                    key,
                    peer: peer.to_owned(),
                    channel,
                    rtp,
                    play_started_at,
                })));
            }
        }
        "GET_PARAMETER" => {
            write_rtsp_response(
                writer,
                "200 OK",
                cseq,
                &[("Session", session.id.as_deref().unwrap_or("1"))],
                None,
            )
            .await?;
        }
        "TEARDOWN" => {
            write_rtsp_response(
                writer,
                "200 OK",
                cseq,
                &[("Session", session.id.as_deref().unwrap_or("1"))],
                None,
            )
            .await?;
            return Ok(true);
        }
        _ => {
            write_rtsp_response(writer, "405 Method Not Allowed", cseq, &[], None).await?;
        }
    }

    Ok(false)
}

async fn subscribe_listener(
    state: &Arc<AppState>,
    key: &str,
) -> Result<ListenerSubscription, &'static str> {
    let channel = {
        let mut channels = state.channels.lock().await;
        channels
            .entry(key.to_owned())
            .or_insert_with(|| Arc::new(Channel::new(state.config.channel_buffer)))
            .clone()
    };

    if state
        .active_listeners
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
            (limit_allows(state.config.max_listeners_total, current)
                && connection_limit_allows(state, active_streamers(state), current))
            .then_some(current.saturating_add(1))
        })
        .is_err()
    {
        cleanup_channel(state, key, &channel).await;
        return Err("453 Not Enough Bandwidth");
    }

    if channel
        .listeners
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
            limit_allows(state.config.max_listeners_per_stream, current)
                .then_some(current.saturating_add(1))
        })
        .is_err()
    {
        state.active_listeners.fetch_sub(1, Ordering::AcqRel);
        cleanup_channel(state, key, &channel).await;
        return Err("453 Not Enough Bandwidth");
    }

    let audio_rx = channel.audio_tx.subscribe();
    let video_rx = channel.video_tx.subscribe();
    let guard = ListenerGuard {
        state: state.clone(),
        key: key.to_owned(),
        channel,
    };
    Ok(ListenerSubscription {
        audio_rx,
        video_rx,
        guard,
    })
}

struct ListenerSubscription {
    pub(crate) audio_rx: broadcast::Receiver<AudioMessage>,
    pub(crate) video_rx: broadcast::Receiver<VideoMessage>,
    pub(crate) guard: ListenerGuard,
}

struct RtspAudioTask {
    writer: SharedRtspWriter,
    rx: broadcast::Receiver<AudioMessage>,
    stream: Arc<Channel>,
    key: String,
    peer: String,
    channel: u8,
    rtp: RtpState,
    play_started_at: TokioInstant,
}

async fn rtsp_audio_rtp_task(task: RtspAudioTask) {
    let RtspAudioTask {
        writer,
        mut rx,
        stream,
        key,
        peer,
        channel,
        mut rtp,
        play_started_at,
    } = task;
    let mut resync_epoch = stream.resync_epoch.load(Ordering::Acquire);
    let clock = RtpClock::new(rtp.timestamp, AAC_SAMPLE_RATE, play_started_at);
    let mut timestamps = RtpTimestampMapper::default();
    let mut next_send_at = TokioInstant::now();
    let mut sleep = Box::pin(sleep_until(next_send_at));
    let mut rtcp_sleep = Box::pin(sleep_until(TokioInstant::now()));
    let mut packets = 0usize;
    let mut silence_packets = 0usize;
    let mut dropped = 0usize;
    let mut sender = RtpPacketWriter::new(channel, 4 + 12 + 2 + 2 + AAC_MAX_ACCESS_UNIT_BYTES);

    loop {
        let current_resync_epoch = stream.resync_epoch.load(Ordering::Acquire);
        if current_resync_epoch != resync_epoch {
            rx = stream.audio_tx.subscribe();
            timestamps.reset();
            next_send_at = TokioInstant::now();
            sleep.as_mut().reset(next_send_at);
            resync_epoch = current_resync_epoch;
            debug!(%peer, %key, epoch = current_resync_epoch, "rtsp listener force resynced");
        }
        let queued = rx.len();
        if queued > MAX_AUDIO_BACKLOG_FRAMES {
            rx = stream.audio_tx.subscribe();
            timestamps.reset();
            next_send_at = TokioInstant::now();
            sleep.as_mut().reset(next_send_at);
            dropped = dropped.saturating_add(queued);
            debug!(%peer, %key, queued, "rtsp audio backlog dropped");
        }

        tokio::select! {
            message = rx.recv() => {
                match message {
                    Ok(AudioMessage::Wake) => {
                        timestamps.reset();
                        next_send_at = TokioInstant::now();
                        sleep.as_mut().reset(next_send_at);
                    }
                    Ok(AudioMessage::Frame { access_unit, rtp_timestamp }) => {
                        if !stream.streamer.load(Ordering::Acquire) {
                            continue;
                        }
                        rtp.timestamp = if let Some(timestamp) = timestamps.map(rtp_timestamp) {
                            timestamp
                        } else {
                            let timestamp = clock.timestamp();
                            timestamps.start(rtp_timestamp, timestamp);
                            timestamp
                        };
                        if let Err(error) = sender.send_aac(&writer, &access_unit, &mut rtp).await {
                            warn!(%peer, %key, %error, "rtsp rtp writer failed");
                            break;
                        }
                        packets += 1;
                    }
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        rx = stream.audio_tx.subscribe();
                        timestamps.reset();
                        dropped = dropped.saturating_add(skipped as usize);
                        warn!(%peer, %key, skipped, "rtsp client lagged behind streamer");
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            _ = &mut sleep, if !stream.streamer.load(Ordering::Acquire) => {
                if let Err(error) = sender.send_aac(&writer, AAC_SILENCE_ACCESS_UNIT, &mut rtp).await {
                    warn!(%peer, %key, %error, "rtsp rtp writer failed");
                    break;
                }

                packets += 1;
                silence_packets += 1;
                next_send_at += AAC_FRAME_DURATION;
                let now = TokioInstant::now();
                if now.saturating_duration_since(next_send_at) > Duration::from_millis(250) {
                    next_send_at = now + AAC_FRAME_DURATION;
                }
                sleep.as_mut().reset(next_send_at);
            }
            _ = &mut rtcp_sleep => {
                if let Err(error) = sender
                    .send_sender_report(
                        &writer,
                        RTP_AUDIO_SSRC,
                        clock.timestamp(),
                        &rtp,
                        &key,
                    )
                    .await
                {
                    warn!(%peer, %key, %error, "rtsp audio rtcp writer failed");
                    break;
                }
                rtcp_sleep
                    .as_mut()
                    .reset(TokioInstant::now() + RTCP_REPORT_INTERVAL);
            }
        }
    }

    info!(%peer, %key, packets, silence_packets, dropped, "rtsp rtp ended");
}

struct RtspVideoTask {
    writer: SharedRtspWriter,
    rx: broadcast::Receiver<VideoMessage>,
    state: Arc<AppState>,
    stream: Arc<Channel>,
    key: String,
    peer: String,
    channel: u8,
    rtp: RtpState,
    play_started_at: TokioInstant,
}

async fn rtsp_video_rtp_task(task: RtspVideoTask) {
    let RtspVideoTask {
        writer,
        mut rx,
        state,
        stream,
        key,
        peer,
        channel,
        mut rtp,
        play_started_at,
    } = task;
    let mut seen_keyframe = false;
    let mut last_state = None;
    let mut resync_epoch = stream.resync_epoch.load(Ordering::Acquire);
    let video_clock = RtpClock::new(rtp.timestamp, H264_CLOCK_RATE, play_started_at);
    let mut timestamps = RtpTimestampMapper::default();
    let mut packets = 0usize;
    let mut dropped = 0usize;
    let mut sender = RtpPacketWriter::new(channel, 4 + 12 + RTP_MAX_PAYLOAD_BYTES);
    let mut rtcp_sleep = Box::pin(sleep_until(TokioInstant::now()));

    if channel_video_state(&stream) == VideoStreamState::Video {
        request_video_keyframe(&stream);
    }

    loop {
        let current_resync_epoch = stream.resync_epoch.load(Ordering::Acquire);
        if current_resync_epoch != resync_epoch {
            rx = stream.video_tx.subscribe();
            seen_keyframe = false;
            last_state = None;
            timestamps.reset();
            request_video_keyframe(&stream);
            resync_epoch = current_resync_epoch;
            debug!(%peer, %key, epoch = current_resync_epoch, "rtsp video listener force resynced");
        }
        let queued = rx.len();
        if queued > MAX_VIDEO_BACKLOG_FRAMES {
            rx = stream.video_tx.subscribe();
            seen_keyframe = false;
            timestamps.reset();
            request_video_keyframe(&stream);
            dropped = dropped.saturating_add(queued);
            debug!(%peer, %key, queued, "rtsp video backlog dropped");
        }

        let current_state = channel_video_state(&stream);
        if last_state != Some(current_state) {
            seen_keyframe = false;
            last_state = Some(current_state);
            timestamps.reset();
            if current_state == VideoStreamState::Video {
                request_video_keyframe(&stream);
            }
            if let Some(frame) = placeholder_access_unit(&state.placeholders, current_state) {
                rtp.timestamp = video_clock.timestamp();
                if let Err(error) = sender.send_h264_access_unit(&writer, frame, &mut rtp).await {
                    warn!(%peer, %key, %error, "rtsp video placeholder writer failed");
                    break;
                }
                packets += 1;
            }
        }

        tokio::select! {
            message = rx.recv() => match message {
                Ok(VideoMessage::Wake) => {
                    seen_keyframe = false;
                    last_state = None;
                    timestamps.reset();
                    request_video_keyframe(&stream);
                }
                Ok(VideoMessage::Frame {
                    access_unit,
                    keyframe,
                    rtp_timestamp,
                }) => {
                    if channel_video_state(&stream) != VideoStreamState::Video {
                        continue;
                    }
                    if keyframe {
                        seen_keyframe = true;
                    }
                    if !seen_keyframe {
                        continue;
                    }
                    rtp.timestamp = if let Some(timestamp) = timestamps.map(rtp_timestamp) {
                        timestamp
                    } else {
                        let timestamp = video_clock.timestamp();
                        timestamps.start(rtp_timestamp, timestamp);
                        timestamp
                    };
                    if let Err(error) = sender
                        .send_h264_access_unit(&writer, &access_unit, &mut rtp)
                        .await
                    {
                        warn!(%peer, %key, %error, "rtsp video rtp writer failed");
                        break;
                    }
                    packets += 1;
                }
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    rx = stream.video_tx.subscribe();
                    seen_keyframe = false;
                    timestamps.reset();
                    request_video_keyframe(&stream);
                    dropped = dropped.saturating_add(skipped as usize);
                    warn!(%peer, %key, skipped, "rtsp video client lagged behind streamer");
                }
                Err(broadcast::error::RecvError::Closed) => break,
            },
            _ = &mut rtcp_sleep => {
                if let Err(error) = sender
                    .send_sender_report(
                        &writer,
                        RTP_VIDEO_SSRC,
                        video_clock.timestamp(),
                        &rtp,
                        &key,
                    )
                    .await
                {
                    warn!(%peer, %key, %error, "rtsp video rtcp writer failed");
                    break;
                }
                rtcp_sleep
                    .as_mut()
                    .reset(TokioInstant::now() + RTCP_REPORT_INTERVAL);
            }
        }
    }

    info!(%peer, %key, packets, dropped, "rtsp video rtp ended");
}

enum RtspInput {
    Request(RtspRequest),
    Interleaved {
        channel: u8,
        requests_keyframe: bool,
    },
}

#[cfg(test)]
pub(crate) async fn read_rtsp_request<R>(
    reader: &mut R,
) -> Result<Option<RtspRequest>, Box<dyn std::error::Error + Send + Sync>>
where
    R: AsyncBufRead + Unpin,
{
    let mut interleaved_buffer = Vec::new();
    loop {
        match read_rtsp_input(reader, &mut interleaved_buffer).await? {
            Some(RtspInput::Request(request)) => return Ok(Some(request)),
            Some(RtspInput::Interleaved { .. }) => {}
            None => return Ok(None),
        }
    }
}

async fn read_rtsp_input<R>(
    reader: &mut R,
    interleaved_buffer: &mut Vec<u8>,
) -> Result<Option<RtspInput>, Box<dyn std::error::Error + Send + Sync>>
where
    R: AsyncBufRead + Unpin,
{
    loop {
        let Some(first) = read_one(reader).await? else {
            return Ok(None);
        };

        if first == b'$' {
            let mut header = [0u8; 3];
            reader.read_exact(&mut header).await?;
            let len = u16::from_be_bytes([header[1], header[2]]) as usize;
            if len > RTCP_MAX_FEEDBACK_BYTES {
                discard_exact(reader, len).await?;
                continue;
            }
            interleaved_buffer.resize(len, 0);
            reader.read_exact(interleaved_buffer).await?;
            return Ok(Some(RtspInput::Interleaved {
                channel: header[0],
                requests_keyframe: rtcp_requests_keyframe(interleaved_buffer),
            }));
        }

        if first == b'\r' || first == b'\n' {
            continue;
        }

        let mut first_line = vec![first];
        read_until_limited(reader, b'\n', &mut first_line, RTSP_MAX_LINE_BYTES).await?;
        let first_line = String::from_utf8(first_line)?;
        let mut parts = first_line.split_whitespace();
        let Some(method) = parts.next() else {
            continue;
        };
        let Some(uri) = parts.next() else {
            continue;
        };
        let version = parts.next().unwrap_or("RTSP/1.0").to_owned();
        let mut headers = Vec::new();
        let mut header_bytes = 0usize;
        let mut content_length = 0usize;

        loop {
            let mut line = Vec::new();
            let bytes = read_until_limited(reader, b'\n', &mut line, RTSP_MAX_LINE_BYTES).await?;
            if bytes == 0 || line == b"\r\n" || line == b"\n" {
                break;
            }
            if headers.len() >= RTSP_MAX_HEADERS {
                return Err("too many rtsp headers".into());
            }
            header_bytes = header_bytes.saturating_add(bytes);
            if header_bytes > RTSP_MAX_HEADER_BYTES {
                return Err("rtsp headers are too large".into());
            }

            let line = String::from_utf8(line)?;
            if let Some((name, value)) = line.split_once(':') {
                let name = name.trim().to_ascii_lowercase();
                let value = value.trim().to_owned();
                if name == "content-length" {
                    content_length = value.parse().unwrap_or(0);
                }
                headers.push((name, value));
            }
        }

        if content_length != 0 {
            if content_length > RTSP_MAX_BODY_BYTES {
                return Err("rtsp request body too large".into());
            }
            discard_exact(reader, content_length).await?;
        }

        return Ok(Some(RtspInput::Request(RtspRequest {
            method: method.to_ascii_uppercase(),
            uri: uri.to_owned(),
            _version: version,
            headers,
        })));
    }
}

pub(crate) fn rtcp_requests_keyframe(packet: &[u8]) -> bool {
    let mut offset = 0usize;
    while offset + 4 <= packet.len() {
        if packet[offset] >> 6 != 2 {
            return false;
        }
        let words = u16::from_be_bytes([packet[offset + 2], packet[offset + 3]]) as usize + 1;
        let Some(length) = words.checked_mul(4) else {
            return false;
        };
        if length < 4 || offset + length > packet.len() {
            return false;
        }

        let format = packet[offset] & 0x1f;
        if packet[offset + 1] == RTCP_PAYLOAD_SPECIFIC_FEEDBACK
            && ((format == RTCP_PLI && length >= 12) || (format == RTCP_FIR && length >= 20))
        {
            return true;
        }
        offset += length;
    }
    false
}

async fn read_until_limited<R>(
    reader: &mut R,
    delimiter: u8,
    buffer: &mut Vec<u8>,
    limit: usize,
) -> Result<usize, std::io::Error>
where
    R: AsyncBufRead + Unpin,
{
    let started = buffer.len();

    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return Ok(buffer.len().saturating_sub(started));
        }

        let take = available
            .iter()
            .position(|byte| *byte == delimiter)
            .map_or(available.len(), |index| index + 1);
        let found = available[..take].contains(&delimiter);

        if buffer.len().saturating_add(take) > limit {
            return Err(std::io::Error::new(
                ErrorKind::InvalidData,
                "rtsp line too long",
            ));
        }

        buffer.extend_from_slice(&available[..take]);
        reader.consume(take);

        if found {
            return Ok(buffer.len().saturating_sub(started));
        }
    }
}

async fn discard_exact<R>(reader: &mut R, mut len: usize) -> Result<(), std::io::Error>
where
    R: AsyncRead + Unpin,
{
    let mut buffer = [0u8; RTSP_DISCARD_BUFFER_BYTES];
    while len != 0 {
        let chunk = len.min(buffer.len());
        reader.read_exact(&mut buffer[..chunk]).await?;
        len -= chunk;
    }
    Ok(())
}

async fn read_one<R>(reader: &mut R) -> Result<Option<u8>, std::io::Error>
where
    R: AsyncRead + Unpin,
{
    let mut byte = [0u8; 1];
    match reader.read_exact(&mut byte).await {
        Ok(_) => Ok(Some(byte[0])),
        Err(error) if error.kind() == ErrorKind::UnexpectedEof => Ok(None),
        Err(error) => Err(error),
    }
}

async fn write_rtsp_response(
    writer: &SharedRtspWriter,
    status: &str,
    cseq: &str,
    headers: &[(&str, &str)],
    body: Option<&[u8]>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let body_len = body.map_or(0, <[u8]>::len);
    let mut response = format!(
        "RTSP/1.0 {status}\r\nCSeq: {cseq}\r\nServer: VRCStreamer\r\nCache-Control: no-cache\r\n"
    );

    for (name, value) in headers {
        response.push_str(name);
        response.push_str(": ");
        response.push_str(value);
        response.push_str("\r\n");
    }

    if body_len != 0 {
        response.push_str("Content-Length: ");
        response.push_str(&body_len.to_string());
        response.push_str("\r\n");
    }

    response.push_str("\r\n");

    let mut writer = writer.lock().await;
    writer.write_all(response.as_bytes()).await?;
    if let Some(body) = body {
        writer.write_all(body).await?;
    }
    writer.flush().await?;
    Ok(())
}

struct RtpPacketWriter {
    channel: u8,
    packet: Vec<u8>,
}

impl RtpPacketWriter {
    fn new(channel: u8, packet_capacity: usize) -> Self {
        Self {
            channel,
            packet: Vec::with_capacity(packet_capacity),
        }
    }

    async fn send_aac(
        &mut self,
        writer: &SharedRtspWriter,
        access_unit: &[u8],
        rtp: &mut RtpState,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let packet_len = 12 + 2 + 2 + access_unit.len();
        if packet_len > u16::MAX as usize {
            return Err("rtp packet too large".into());
        }

        self.packet.clear();
        self.packet.push(b'$');
        self.packet.push(self.channel);
        self.packet
            .extend_from_slice(&(packet_len as u16).to_be_bytes());
        self.packet.push(0x80);
        self.packet.push(RTP_AUDIO_PAYLOAD_TYPE);
        self.packet.extend_from_slice(&rtp.sequence.to_be_bytes());
        self.packet.extend_from_slice(&rtp.timestamp.to_be_bytes());
        self.packet.extend_from_slice(&RTP_AUDIO_SSRC.to_be_bytes());
        self.packet.extend_from_slice(&16u16.to_be_bytes());

        let au_size = access_unit.len() as u16;
        self.packet.push((au_size >> 5) as u8);
        self.packet.push(((au_size & 0x1f) << 3) as u8);
        self.packet.extend_from_slice(access_unit);

        let mut writer = writer.lock().await;
        writer.write_all(&self.packet).await?;
        rtp.advance_by(AAC_SAMPLES_PER_FRAME, 4 + access_unit.len());
        Ok(())
    }

    async fn send_h264_access_unit(
        &mut self,
        writer: &SharedRtspWriter,
        access_unit: &[u8],
        rtp: &mut RtpState,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let mut nal_start = start_h264_payload(access_unit)?;
        let mut pending = None;
        let mut locked = writer.lock().await;

        loop {
            let next = find_h264_start_code(access_unit, nal_start);
            let nal_end = next.map_or(access_unit.len(), |(index, _)| index);
            if nal_end > nal_start
                && let Some(nal) = pending.replace(&access_unit[nal_start..nal_end])
            {
                self.send_h264_nal(&mut locked, nal, false, rtp).await?;
            }
            let Some((start, len)) = next else {
                break;
            };
            nal_start = start + len;
        }

        let nal = pending.ok_or("h264 access unit has no nal units")?;
        self.send_h264_nal(&mut locked, nal, true, rtp).await?;
        Ok(())
    }

    async fn send_h264_nal(
        &mut self,
        writer: &mut OwnedWriteHalf,
        nal: &[u8],
        marker_on_last_packet: bool,
        rtp: &mut RtpState,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if nal.len() <= RTP_MAX_PAYLOAD_BYTES {
            self.packet.clear();
            self.push_rtp_interleaved_header(
                nal.len(),
                RTP_VIDEO_PAYLOAD_TYPE,
                marker_on_last_packet,
                rtp.sequence,
                rtp.timestamp,
                RTP_VIDEO_SSRC,
            );
            self.packet.extend_from_slice(nal);
            writer.write_all(&self.packet).await?;
            rtp.record_packet(nal.len());
            return Ok(());
        }

        let nal_header = nal[0];
        let nal_type = nal_header & 0x1f;
        let fu_indicator = (nal_header & 0xe0) | 28;
        let max_chunk = RTP_MAX_PAYLOAD_BYTES - 2;
        let mut offset = 1usize;

        while offset < nal.len() {
            let end = (offset + max_chunk).min(nal.len());
            let start = offset == 1;
            let last = end == nal.len();
            let mut fu_header = nal_type;
            if start {
                fu_header |= 0x80;
            }
            if last {
                fu_header |= 0x40;
            }

            self.packet.clear();
            self.push_rtp_interleaved_header(
                2 + end - offset,
                RTP_VIDEO_PAYLOAD_TYPE,
                marker_on_last_packet && last,
                rtp.sequence,
                rtp.timestamp,
                RTP_VIDEO_SSRC,
            );
            self.packet.push(fu_indicator);
            self.packet.push(fu_header);
            self.packet.extend_from_slice(&nal[offset..end]);
            writer.write_all(&self.packet).await?;
            rtp.record_packet(2 + end - offset);
            offset = end;
        }

        Ok(())
    }

    async fn send_sender_report(
        &mut self,
        writer: &SharedRtspWriter,
        ssrc: u32,
        rtp_timestamp: u32,
        rtp: &RtpState,
        cname: &str,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let ntp = ntp_timestamp(SystemTime::now());
        build_rtcp_sender_report(
            &mut self.packet,
            self.channel.saturating_add(1),
            ssrc,
            ntp,
            rtp_timestamp,
            rtp,
            cname,
        );
        let mut writer = writer.lock().await;
        writer.write_all(&self.packet).await?;
        Ok(())
    }

    fn push_rtp_interleaved_header(
        &mut self,
        payload_len: usize,
        payload_type: u8,
        marker: bool,
        sequence: u16,
        timestamp: u32,
        ssrc: u32,
    ) {
        let packet_len = 12 + payload_len;
        self.packet.push(b'$');
        self.packet.push(self.channel);
        self.packet
            .extend_from_slice(&(packet_len as u16).to_be_bytes());
        self.packet.push(0x80);
        self.packet
            .push((if marker { 0x80 } else { 0 }) | payload_type);
        self.packet.extend_from_slice(&sequence.to_be_bytes());
        self.packet.extend_from_slice(&timestamp.to_be_bytes());
        self.packet.extend_from_slice(&ssrc.to_be_bytes());
    }
}

fn ntp_timestamp(now: SystemTime) -> (u32, u32) {
    let elapsed = now.duration_since(UNIX_EPOCH).unwrap_or_default();
    let seconds = elapsed.as_secs().wrapping_add(NTP_UNIX_EPOCH_OFFSET) as u32;
    let fraction = ((elapsed.subsec_nanos() as u64) << 32) / 1_000_000_000;
    (seconds, fraction as u32)
}

pub(crate) fn build_rtcp_sender_report(
    packet: &mut Vec<u8>,
    channel: u8,
    ssrc: u32,
    ntp: (u32, u32),
    rtp_timestamp: u32,
    rtp: &RtpState,
    cname: &str,
) {
    packet.clear();
    packet.extend_from_slice(&[b'$', channel, 0, 0]);

    packet.extend_from_slice(&[0x80, RTCP_SENDER_REPORT, 0, 6]);
    packet.extend_from_slice(&ssrc.to_be_bytes());
    packet.extend_from_slice(&ntp.0.to_be_bytes());
    packet.extend_from_slice(&ntp.1.to_be_bytes());
    packet.extend_from_slice(&rtp_timestamp.to_be_bytes());
    packet.extend_from_slice(&rtp.packet_count.to_be_bytes());
    packet.extend_from_slice(&rtp.octet_count.to_be_bytes());

    let sdes_start = packet.len();
    packet.extend_from_slice(&[0x81, RTCP_SOURCE_DESCRIPTION, 0, 0]);
    packet.extend_from_slice(&ssrc.to_be_bytes());
    let cname = &cname.as_bytes()[..cname.len().min(u8::MAX as usize)];
    packet.extend_from_slice(&[1, cname.len() as u8]);
    packet.extend_from_slice(cname);
    packet.push(0);
    while !(packet.len() - 4).is_multiple_of(4) {
        packet.push(0);
    }

    let sdes_words = ((packet.len() - sdes_start) / 4 - 1) as u16;
    packet[sdes_start + 2..sdes_start + 4].copy_from_slice(&sdes_words.to_be_bytes());
    let interleaved_len = (packet.len() - 4) as u16;
    packet[2..4].copy_from_slice(&interleaved_len.to_be_bytes());
}

pub(crate) fn rtsp_sdp(video_fmtp: &str) -> String {
    format!(
        "v=0\r\n\
         o=- 0 0 IN IP4 127.0.0.1\r\n\
         s= \r\n\
         c=IN IP4 0.0.0.0\r\n\
         t=0 0\r\n\
         m=audio 0 RTP/AVP {RTP_AUDIO_PAYLOAD_TYPE}\r\n\
         a=control:trackID=0\r\n\
         a=rtpmap:{RTP_AUDIO_PAYLOAD_TYPE} mpeg4-generic/{AAC_SAMPLE_RATE}/{AAC_CHANNELS}\r\n\
         a=fmtp:{RTP_AUDIO_PAYLOAD_TYPE} config={AAC_AUDIO_SPECIFIC_CONFIG}; indexdeltalength=3; indexlength=3; mode=AAC-hbr; profile-level-id=1; sizelength=13; streamtype=5\r\n\
         m=video 0 RTP/AVP {RTP_VIDEO_PAYLOAD_TYPE}\r\n\
         a=control:trackID=1\r\n\
         a=rtpmap:{RTP_VIDEO_PAYLOAD_TYPE} H264/{H264_CLOCK_RATE}\r\n\
         a=fmtp:{RTP_VIDEO_PAYLOAD_TYPE} {video_fmtp}\r\n"
    )
}

fn rtsp_content_base(uri: &str) -> String {
    let mut base = uri
        .split(['?', '#'])
        .next()
        .filter(|value| !value.is_empty())
        .unwrap_or(uri)
        .to_owned();
    if !base.ends_with('/') {
        base.push('/');
    }
    base
}

pub(crate) fn key_from_rtsp_uri(uri: &str) -> Option<&str> {
    let path = if let Some((_, rest)) = uri.split_once("://") {
        let slash = rest.find('/')?;
        &rest[slash..]
    } else {
        uri
    };

    path.trim_start_matches('/')
        .split(['/', '?', '#'])
        .next()
        .filter(|value| !value.is_empty())
}

fn rtsp_track_from_uri(uri: &str) -> RtspTrack {
    if uri
        .split(['?', '#'])
        .next()
        .unwrap_or(uri)
        .rsplit('/')
        .next()
        .is_some_and(|segment| segment.eq_ignore_ascii_case("trackID=1"))
    {
        return RtspTrack::Video;
    }
    RtspTrack::Audio
}

fn rtsp_rtp_info(uri: &str, session: &RtspSession) -> String {
    let base = rtsp_content_base(uri);
    let base = base.trim_end_matches('/');
    let mut out = String::with_capacity(128);
    if session.audio_setup {
        let _ = write!(
            out,
            "url={base}/trackID=0;seq={};rtptime={}",
            session.audio_rtp.sequence, session.audio_rtp.timestamp
        );
    }
    if session.video_setup {
        if !out.is_empty() {
            out.push(',');
        }
        let _ = write!(
            out,
            "url={base}/trackID=1;seq={};rtptime={}",
            session.video_rtp.sequence, session.video_rtp.timestamp
        );
    }
    out
}

fn parse_interleaved_channel(transport: &str) -> Option<u8> {
    let lower = transport.to_ascii_lowercase();
    let value = lower.split("interleaved=").nth(1)?;
    value.split(['-', ';']).next()?.trim().parse().ok()
}

pub(crate) fn select_rtsp_interleaved_channel(
    session: &RtspSession,
    track: RtspTrack,
    requested: Option<u8>,
) -> u8 {
    let preferred = requested.unwrap_or(match track {
        RtspTrack::Audio => 0,
        RtspTrack::Video => 2,
    });
    if rtsp_interleaved_channel_available(session, track, preferred) {
        return preferred;
    }

    for channel in (0..=252).step_by(2) {
        if rtsp_interleaved_channel_available(session, track, channel) {
            return channel;
        }
    }
    preferred
}

fn rtsp_interleaved_channel_available(
    session: &RtspSession,
    track: RtspTrack,
    candidate: u8,
) -> bool {
    match track {
        RtspTrack::Audio => {
            !session.video_setup || !rtsp_channel_pairs_overlap(candidate, session.video_channel)
        }
        RtspTrack::Video => {
            !session.audio_setup || !rtsp_channel_pairs_overlap(candidate, session.audio_channel)
        }
    }
}

fn rtsp_channel_pairs_overlap(left: u8, right: u8) -> bool {
    let left = left as u16;
    let right = right as u16;
    left <= right + 1 && right <= left + 1
}

pub(crate) fn channel_video_state(channel: &Channel) -> VideoStreamState {
    if !channel.streamer.load(Ordering::Acquire) {
        VideoStreamState::Offline
    } else if channel.video_active.load(Ordering::Acquire) {
        VideoStreamState::Video
    } else {
        VideoStreamState::AudioOnly
    }
}

async fn rtsp_video_fmtp(state: &AppState, key: &str) -> Arc<str> {
    let channel = state.channels.lock().await.get(key).cloned();
    let Some(channel) = channel else {
        return state.placeholders.offline_fmtp.clone();
    };

    match channel_video_state(&channel) {
        VideoStreamState::Video => channel
            .video_fmtp()
            .unwrap_or_else(|| state.placeholders.audio_only_fmtp.clone()),
        VideoStreamState::AudioOnly => state.placeholders.audio_only_fmtp.clone(),
        VideoStreamState::Offline => state.placeholders.offline_fmtp.clone(),
    }
}

pub(crate) fn placeholder_access_unit(
    placeholders: &Placeholders,
    state: VideoStreamState,
) -> Option<&Bytes> {
    match state {
        VideoStreamState::Offline if !placeholders.offline_video.is_empty() => {
            Some(&placeholders.offline_video)
        }
        VideoStreamState::AudioOnly if !placeholders.audio_only_video.is_empty() => {
            Some(&placeholders.audio_only_video)
        }
        _ => None,
    }
}

#[derive(Default)]
pub(crate) struct RtspSession {
    pub(crate) id: Option<String>,
    pub(crate) key: Option<String>,
    pub(crate) audio_rx: Option<broadcast::Receiver<AudioMessage>>,
    pub(crate) video_rx: Option<broadcast::Receiver<VideoMessage>>,
    pub(crate) _listener_ip_guard: Option<ListenerIpGuard>,
    pub(crate) guard: Option<ListenerGuard>,
    pub(crate) audio_rtp_task: Option<JoinHandle<()>>,
    pub(crate) video_rtp_task: Option<JoinHandle<()>>,
    pub(crate) audio_setup: bool,
    pub(crate) video_setup: bool,
    pub(crate) audio_channel: u8,
    pub(crate) video_channel: u8,
    pub(crate) audio_rtp: RtpState,
    pub(crate) video_rtp: RtpState,
}

impl RtspSession {
    fn stop(&mut self) {
        if let Some(task) = self.audio_rtp_task.take() {
            task.abort();
        }
        if let Some(task) = self.video_rtp_task.take() {
            task.abort();
        }
    }
}

#[derive(Clone, Copy, Default)]
pub(crate) struct RtpState {
    pub(crate) sequence: u16,
    pub(crate) timestamp: u32,
    pub(crate) packet_count: u32,
    pub(crate) octet_count: u32,
}

impl RtpState {
    pub(crate) fn advance_by(&mut self, timestamp_delta: u32, payload_bytes: usize) {
        self.timestamp = self.timestamp.wrapping_add(timestamp_delta);
        self.record_packet(payload_bytes);
    }

    fn record_packet(&mut self, payload_bytes: usize) {
        self.sequence = self.sequence.wrapping_add(1);
        self.packet_count = self.packet_count.wrapping_add(1);
        self.octet_count = self.octet_count.wrapping_add(payload_bytes as u32);
    }
}

struct RtpClock {
    started_at: TokioInstant,
    base_timestamp: u32,
    clock_rate: u32,
}

#[derive(Default)]
pub(crate) struct RtpTimestampMapper {
    offset: Option<u32>,
}

impl RtpTimestampMapper {
    pub(crate) fn reset(&mut self) {
        self.offset = None;
    }

    pub(crate) fn start(&mut self, source: u32, output: u32) {
        self.offset = Some(output.wrapping_sub(source));
    }

    pub(crate) fn map(&self, source: u32) -> Option<u32> {
        self.offset.map(|offset| source.wrapping_add(offset))
    }
}

impl RtpClock {
    fn new(base_timestamp: u32, clock_rate: u32, started_at: TokioInstant) -> Self {
        Self {
            started_at,
            base_timestamp,
            clock_rate,
        }
    }

    fn timestamp(&self) -> u32 {
        let ticks = (self.started_at.elapsed().as_secs_f64() * self.clock_rate as f64) as u32;
        self.base_timestamp.wrapping_add(ticks)
    }
}

pub(crate) struct RtspRequest {
    pub(crate) method: String,
    pub(crate) uri: String,
    _version: String,
    headers: Vec<(String, String)>,
}

impl RtspRequest {
    pub(crate) fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(header_name, _)| header_name.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

pub(crate) struct ListenerGuard {
    state: Arc<AppState>,
    key: String,
    channel: Arc<Channel>,
}

impl Drop for ListenerGuard {
    fn drop(&mut self) {
        self.channel.listeners.fetch_sub(1, Ordering::AcqRel);
        self.state.active_listeners.fetch_sub(1, Ordering::AcqRel);

        let state = self.state.clone();
        let key = self.key.clone();
        let channel = self.channel.clone();
        tokio::spawn(async move {
            cleanup_channel(&state, &key, &channel).await;
        });
    }
}
