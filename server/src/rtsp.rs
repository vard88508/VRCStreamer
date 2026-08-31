use std::{
    fmt::{self, Write as _},
    future::pending,
    io::ErrorKind,
    pin::Pin,
    sync::{Arc, atomic::Ordering},
    time::{Duration, Instant as StdInstant, SystemTime, UNIX_EPOCH},
};

use bytes::Bytes;
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, tcp::OwnedWriteHalf},
    sync::{Mutex, broadcast},
    task::JoinHandle,
    time::{Instant as TokioInstant, Sleep, sleep_until, timeout},
};
use tracing::{debug, info, trace, warn};

use super::limits::{
    ConnectionGuard, ListenerIpGuard, try_acquire_connection, try_acquire_listener_ip,
};
use super::media::{AudioMessage, VideoMessage, find_h264_start_code, start_h264_payload};
use super::{
    AAC_AUDIO_SPECIFIC_CONFIG, AAC_CHANNELS, AAC_FRAME_DURATION, AAC_SAMPLE_RATE,
    AAC_SAMPLES_PER_FRAME, AAC_SILENCE_ACCESS_UNIT, AppState, Channel, H264_CLOCK_RATE,
    MEDIA_CLOCK_RATE, Placeholders, RTCP_REPORT_INTERVAL, RTP_AUDIO_PAYLOAD_TYPE, RTP_AUDIO_SSRC,
    RTP_MAX_PAYLOAD_BYTES, RTP_VIDEO_PAYLOAD_TYPE, RTP_VIDEO_SSRC, RTSP_DISCARD_BUFFER_BYTES,
    RTSP_MAX_BODY_BYTES, RTSP_MAX_HEADER_BYTES, RTSP_MAX_HEADERS, RTSP_MAX_LINE_BYTES,
    cleanup_channel, limit_allows, peer_id, request_video_keyframe, reserve_channel, valid_hash,
};

type SharedRtspWriter = Arc<Mutex<OwnedWriteHalf>>;
type RtspResult<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;
const RTCP_MAX_FEEDBACK_BYTES: usize = 4096;
const RTCP_SENDER_REPORT: u8 = 200;
const RTCP_SOURCE_DESCRIPTION: u8 = 202;
const RTCP_PAYLOAD_SPECIFIC_FEEDBACK: u8 = 206;
const RTCP_PLI: u8 = 1;
const RTCP_FIR: u8 = 4;
const NTP_UNIX_EPOCH_OFFSET: u64 = 2_208_988_800;
const MAX_AUDIO_BACKLOG_FRAMES: usize = 12;
const MAX_VIDEO_BACKLOG_AGE: Duration = Duration::from_secs(1);
const RTP_PACKET_BUFFER_BYTES: usize = 4 + 12 + RTP_MAX_PAYLOAD_BYTES;
const RTP_TCP_WRITE_BATCH_BYTES: usize = 16 * 1024;
const MEDIA_TIMELINE_REANCHOR_TICKS: i64 = MEDIA_CLOCK_RATE as i64 * 60 * 30;

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

pub(crate) async fn rtsp_server(state: Arc<AppState>, listener: TcpListener) {
    info!(
        port = state.config.rtsp_bind_addr.port(),
        "listening on rtsp"
    );

    loop {
        match listener.accept().await {
            Ok((stream, addr)) => {
                let listener_ip_guard = match try_acquire_listener_ip(&state, addr.ip()) {
                    Ok(guard) => guard,
                    Err(_) => continue,
                };
                let connection_guard = match try_acquire_connection(&state) {
                    Ok(guard) => guard,
                    Err(_) => continue,
                };
                let state = state.clone();
                let peer = peer_id(&state, addr.ip());
                tokio::spawn(async move {
                    if let Err(error) = handle_rtsp_client(
                        stream,
                        &peer,
                        state,
                        listener_ip_guard,
                        connection_guard,
                    )
                    .await
                    {
                        warn!(%peer, %error, "rtsp client error");
                    }
                });
            }
            Err(error) => {
                warn!(%error, "rtsp accept error");
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }
}

async fn handle_rtsp_client(
    stream: tokio::net::TcpStream,
    peer: &str,
    state: Arc<AppState>,
    listener_ip_guard: Option<ListenerIpGuard>,
    _connection_guard: ConnectionGuard,
) -> RtspResult<()> {
    stream.set_nodelay(true)?;
    let (read_half, write_half) = stream.into_split();
    let writer = Arc::new(Mutex::new(write_half));
    let mut reader = BufReader::with_capacity(RTSP_MAX_LINE_BYTES, read_half);
    let mut session = RtspSession {
        _listener_ip_guard: listener_ip_guard,
        ..RtspSession::default()
    };
    let handshake_deadline = TokioInstant::now() + state.config.rtsp_handshake_timeout;
    let mut requests = 0usize;
    let mut interleaved_buffer = Vec::new();

    loop {
        let input = if session.media_rtp_task.is_none() {
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
            tokio::select! {
                input = read_rtsp_input(&mut reader, &mut interleaved_buffer) => input?,
                result = session.media_rtp_task.wait() => {
                    if let Err(error) = result {
                        warn!(%peer, %error, "rtsp media task failed");
                    }
                    break;
                }
            }
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
        if handle_rtsp_request(&request, &writer, &state, &mut session, peer).await? {
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
) -> RtspResult<bool> {
    let cseq = request.header("cseq").unwrap_or("0");
    info!(%peer, method = %request.method, uri = %request.uri, "rtsp request");
    trace!(
        %peer,
        method = %request.method,
        uri = %request.uri,
        headers = ?RtspHeadersForLog(&request.headers),
        "rtsp request headers"
    );
    if !session.androidx_media3 && request.is_androidx_media3() {
        session.androidx_media3 = true;
        debug!(%peer, "rtsp AndroidX Media3 compatibility enabled");
    }

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
            let (video_state, video_fmtp) = rtsp_video_description(state, key);
            session.video_advertised = should_advertise_video(session.androidx_media3, video_state);
            let sdp = rtsp_sdp(session.video_advertised.then_some(video_fmtp.as_ref()));
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

            let track = rtsp_track_from_uri(&request.uri, session.video_advertised);
            if track == RtspTrack::Video && !session.video_track_allowed() {
                write_rtsp_response(writer, "404 Not Found", cseq, &[], None).await?;
                return Ok(false);
            }

            if session.guard.is_none() {
                match subscribe_listener(state, &key) {
                    Ok(subscription) => {
                        session.audio_rx = Some(subscription.audio_rx);
                        if session.video_track_allowed() {
                            session.video_rx = Some(subscription.video_rx);
                        }
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
                rtp_channel.saturating_add(1),
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

            let Some(stream) = session.guard.as_ref().map(|guard| guard.channel.clone()) else {
                write_rtsp_response(writer, "454 Session Not Found", cseq, &[], None).await?;
                return Ok(false);
            };
            let Some(key) = session.key.clone() else {
                write_rtsp_response(writer, "454 Session Not Found", cseq, &[], None).await?;
                return Ok(false);
            };

            let start_media = session.media_rtp_task.is_none();
            let audio = if start_media && session.audio_setup {
                let Some(rx) = session.audio_rx.take() else {
                    write_rtsp_response(writer, "454 Session Not Found", cseq, &[], None).await?;
                    return Ok(false);
                };
                Some(RtspAudioTrackStart {
                    rx,
                    channel: session.audio_channel,
                    rtp: session.audio_rtp,
                })
            } else {
                None
            };
            let video = if start_media && session.video_setup {
                let Some(rx) = session.video_rx.take() else {
                    write_rtsp_response(writer, "454 Session Not Found", cseq, &[], None).await?;
                    return Ok(false);
                };
                Some(RtspVideoTrackStart {
                    rx,
                    channel: session.video_channel,
                    rtp: session.video_rtp,
                })
            } else {
                None
            };

            let rtp_info = rtsp_rtp_info(&request.uri, session);
            write_rtsp_response(
                writer,
                "200 OK",
                cseq,
                &[
                    ("Range", "npt=now-"),
                    ("RTP-Info", rtp_info.as_str()),
                    ("Session", session.id.as_deref().unwrap_or("1")),
                ],
                None,
            )
            .await?;

            if start_media {
                session
                    .media_rtp_task
                    .start(tokio::spawn(rtsp_media_rtp_task(RtspMediaTask {
                        writer: writer.clone(),
                        state: state.clone(),
                        stream,
                        key,
                        peer: peer.to_owned(),
                        audio,
                        video,
                        suppress_placeholders: session.androidx_media3,
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

fn subscribe_listener(
    state: &Arc<AppState>,
    key: &str,
) -> Result<ListenerSubscription, &'static str> {
    if state
        .active_listeners
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
            limit_allows(state.config.max_listeners_total, current)
                .then_some(current.saturating_add(1))
        })
        .is_err()
    {
        return Err("453 Not Enough Bandwidth");
    }

    let (channel, reserved) = reserve_channel(state, key, |channel| {
        channel
            .listeners
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                limit_allows(state.config.max_listeners_per_stream, current)
                    .then_some(current.saturating_add(1))
            })
            .is_ok()
    });
    if !reserved {
        state.active_listeners.fetch_sub(1, Ordering::AcqRel);
        cleanup_channel(state, key, &channel);
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

struct RtspAudioTrackStart {
    rx: broadcast::Receiver<AudioMessage>,
    channel: u8,
    rtp: RtpState,
}

struct RtspVideoTrackStart {
    rx: broadcast::Receiver<VideoMessage>,
    channel: u8,
    rtp: RtpState,
}

struct RtspMediaTask {
    writer: SharedRtspWriter,
    state: Arc<AppState>,
    stream: Arc<Channel>,
    key: String,
    peer: String,
    audio: Option<RtspAudioTrackStart>,
    video: Option<RtspVideoTrackStart>,
    suppress_placeholders: bool,
}

struct RtpTaskContext<'a> {
    writer: &'a SharedRtspWriter,
    stream: &'a Channel,
    resync_epoch: usize,
    key: &'a str,
    peer: &'a str,
}

struct AudioRtpTrack {
    rx: broadcast::Receiver<AudioMessage>,
    rtp: RtpState,
    clock: RtpClock,
    next_send_at: TokioInstant,
    silence_sleep: Pin<Box<Sleep>>,
    rtcp: RtcpReporter,
    rtcp_sleep: Pin<Box<Sleep>>,
    packets: usize,
    silence_packets: usize,
    dropped: usize,
    sender: RtpPacketWriter,
}

impl AudioRtpTrack {
    fn new(start: RtspAudioTrackStart, play_started_at: TokioInstant) -> Self {
        let next_send_at = TokioInstant::now();
        Self {
            rx: start.rx,
            rtp: start.rtp,
            clock: RtpClock::new(start.rtp.timestamp, AAC_SAMPLE_RATE, play_started_at),
            next_send_at,
            silence_sleep: Box::pin(sleep_until(next_send_at)),
            rtcp: RtcpReporter::new(RTP_AUDIO_SSRC, AAC_SAMPLE_RATE),
            rtcp_sleep: Box::pin(sleep_until(TokioInstant::now() + RTCP_REPORT_INTERVAL)),
            packets: 0,
            silence_packets: 0,
            dropped: 0,
            sender: RtpPacketWriter::new(start.channel, RTP_PACKET_BUFFER_BYTES),
        }
    }

    fn resync(&mut self, stream: &Channel) {
        self.rx = stream.audio_tx.subscribe();
        self.next_send_at = TokioInstant::now();
        self.silence_sleep.as_mut().reset(self.next_send_at);
    }

    fn drop_backlog(&mut self, stream: &Channel) -> usize {
        let queued = self.rx.len();
        if queued <= MAX_AUDIO_BACKLOG_FRAMES {
            return 0;
        }
        self.rx = stream.audio_tx.subscribe();
        self.next_send_at = TokioInstant::now();
        self.silence_sleep.as_mut().reset(self.next_send_at);
        self.dropped = self.dropped.saturating_add(queued);
        queued
    }

    async fn handle_event(
        &mut self,
        event: AudioRtpEvent,
        context: &RtpTaskContext<'_>,
        timeline: &mut RtpMediaTimeline,
    ) -> RtspResult<bool> {
        match event {
            AudioRtpEvent::Message(Ok(AudioMessage::Wake)) => {
                self.next_send_at = TokioInstant::now();
                self.silence_sleep.as_mut().reset(self.next_send_at);
            }
            AudioRtpEvent::Message(Ok(AudioMessage::Frame {
                access_unit,
                media_timestamp,
                published_at,
            })) => {
                if !context.stream.streamer.load(Ordering::Acquire) {
                    return Ok(true);
                }
                self.rtp.timestamp =
                    timeline.map(context.resync_epoch, media_timestamp, &self.clock);
                let media_time = RtcpMediaTime::new(self.rtp.timestamp, published_at);
                self.rtcp
                    .start_if_needed(
                        &mut self.sender,
                        context.writer,
                        media_time,
                        &mut self.rtcp_sleep,
                        &self.rtp,
                        context.key,
                    )
                    .await?;
                self.sender
                    .send_aac(context.writer, &access_unit, &mut self.rtp)
                    .await?;
                self.rtcp.record(media_time);
                self.packets += 1;
            }
            AudioRtpEvent::Message(Err(broadcast::error::RecvError::Lagged(skipped))) => {
                self.rx = context.stream.audio_tx.subscribe();
                self.dropped = self.dropped.saturating_add(skipped as usize);
                debug!(peer = %context.peer, key = %context.key, skipped, "rtsp audio client lagged behind streamer");
            }
            AudioRtpEvent::Message(Err(broadcast::error::RecvError::Closed)) => return Ok(false),
            AudioRtpEvent::Silence => {
                let media_time =
                    RtcpMediaTime::new(self.rtp.timestamp, self.next_send_at.into_std());
                self.rtcp
                    .start_if_needed(
                        &mut self.sender,
                        context.writer,
                        media_time,
                        &mut self.rtcp_sleep,
                        &self.rtp,
                        context.key,
                    )
                    .await?;
                self.sender
                    .send_aac(context.writer, AAC_SILENCE_ACCESS_UNIT, &mut self.rtp)
                    .await?;
                self.rtcp.record(media_time);
                self.packets += 1;
                self.silence_packets += 1;
                self.next_send_at += AAC_FRAME_DURATION;
                let now = TokioInstant::now();
                if now.saturating_duration_since(self.next_send_at) > Duration::from_millis(250) {
                    self.next_send_at = now + AAC_FRAME_DURATION;
                }
                self.silence_sleep.as_mut().reset(self.next_send_at);
            }
            AudioRtpEvent::Report => {
                self.rtcp
                    .send_report(&mut self.sender, context.writer, &self.rtp, context.key)
                    .await?;
                self.rtcp_sleep
                    .as_mut()
                    .reset(TokioInstant::now() + RTCP_REPORT_INTERVAL);
            }
        }
        Ok(true)
    }
}

enum AudioRtpEvent {
    Message(Result<AudioMessage, broadcast::error::RecvError>),
    Silence,
    Report,
}

async fn next_audio_event(
    track: Option<&mut AudioRtpTrack>,
    streamer_active: bool,
) -> AudioRtpEvent {
    let Some(track) = track else {
        return pending().await;
    };
    let report_started = track.rtcp.started();
    tokio::select! {
        message = track.rx.recv() => AudioRtpEvent::Message(message),
        _ = &mut track.silence_sleep, if !streamer_active => AudioRtpEvent::Silence,
        _ = &mut track.rtcp_sleep, if report_started => AudioRtpEvent::Report,
    }
}

struct VideoRtpTrack {
    rx: broadcast::Receiver<VideoMessage>,
    rtp: RtpState,
    clock: RtpClock,
    seen_keyframe: bool,
    last_state: Option<VideoStreamState>,
    rtcp: RtcpReporter,
    rtcp_sleep: Pin<Box<Sleep>>,
    packets: usize,
    dropped: usize,
    sender: RtpPacketWriter,
}

impl VideoRtpTrack {
    fn new(start: RtspVideoTrackStart, play_started_at: TokioInstant) -> Self {
        Self {
            rx: start.rx,
            rtp: start.rtp,
            clock: RtpClock::new(start.rtp.timestamp, H264_CLOCK_RATE, play_started_at),
            seen_keyframe: false,
            last_state: None,
            rtcp: RtcpReporter::new(RTP_VIDEO_SSRC, H264_CLOCK_RATE),
            rtcp_sleep: Box::pin(sleep_until(TokioInstant::now() + RTCP_REPORT_INTERVAL)),
            packets: 0,
            dropped: 0,
            sender: RtpPacketWriter::new(start.channel, RTP_PACKET_BUFFER_BYTES),
        }
    }

    fn resync(&mut self, stream: &Channel) {
        self.rx = stream.video_tx.subscribe();
        self.seen_keyframe = false;
        self.last_state = None;
        request_video_keyframe(stream);
    }

    async fn sync_state(
        &mut self,
        writer: &SharedRtspWriter,
        placeholders: &Placeholders,
        stream: &Channel,
        key: &str,
        suppress_placeholders: bool,
    ) -> RtspResult<()> {
        let current_state = channel_video_state(stream);
        if self.last_state == Some(current_state) {
            return Ok(());
        }
        self.seen_keyframe = false;
        self.last_state = Some(current_state);
        if current_state == VideoStreamState::Video {
            request_video_keyframe(stream);
        } else {
            self.sender.shrink_to_packet_buffer();
        }
        if suppress_placeholders {
            return Ok(());
        }
        let Some(frame) = placeholder_access_unit(placeholders, current_state) else {
            return Ok(());
        };
        self.rtp.timestamp = self.clock.timestamp();
        let media_time = RtcpMediaTime::new(self.rtp.timestamp, StdInstant::now());
        self.rtcp
            .start_if_needed(
                &mut self.sender,
                writer,
                media_time,
                &mut self.rtcp_sleep,
                &self.rtp,
                key,
            )
            .await?;
        self.sender
            .send_h264_access_unit(writer, frame, false, false, &mut self.rtp)
            .await?;
        self.rtcp.record(media_time);
        self.packets += 1;
        Ok(())
    }

    async fn handle_event(
        &mut self,
        event: VideoRtpEvent,
        context: &RtpTaskContext<'_>,
        timeline: &mut RtpMediaTimeline,
    ) -> RtspResult<bool> {
        match event {
            VideoRtpEvent::Message(Ok(VideoMessage::Wake)) => {
                self.seen_keyframe = false;
                self.last_state = None;
                request_video_keyframe(context.stream);
            }
            VideoRtpEvent::Message(Ok(VideoMessage::Frame {
                access_unit,
                keyframe,
                single_nal,
                media_timestamp,
                published_at,
            })) => {
                if channel_video_state(context.stream) != VideoStreamState::Video {
                    return Ok(true);
                }
                let queued = self.rx.len();
                if queued > 0 && published_at.elapsed() > MAX_VIDEO_BACKLOG_AGE {
                    self.rx = context.stream.video_tx.subscribe();
                    self.seen_keyframe = false;
                    request_video_keyframe(context.stream);
                    self.dropped = self.dropped.saturating_add(queued.saturating_add(1));
                    debug!(peer = %context.peer, key = %context.key, queued, "rtsp video backlog expired");
                    return Ok(true);
                }
                if self.last_state != Some(VideoStreamState::Video) {
                    self.seen_keyframe = false;
                    self.last_state = Some(VideoStreamState::Video);
                    if !keyframe {
                        request_video_keyframe(context.stream);
                    }
                }
                if keyframe {
                    self.seen_keyframe = true;
                }
                if !self.seen_keyframe {
                    return Ok(true);
                }
                self.rtp.timestamp =
                    timeline.map(context.resync_epoch, media_timestamp, &self.clock);
                let media_time = RtcpMediaTime::new(self.rtp.timestamp, published_at);
                self.rtcp
                    .start_if_needed(
                        &mut self.sender,
                        context.writer,
                        media_time,
                        &mut self.rtcp_sleep,
                        &self.rtp,
                        context.key,
                    )
                    .await?;
                self.sender
                    .send_h264_access_unit(
                        context.writer,
                        &access_unit,
                        single_nal,
                        true,
                        &mut self.rtp,
                    )
                    .await?;
                self.rtcp.record(media_time);
                self.packets += 1;
            }
            VideoRtpEvent::Message(Err(broadcast::error::RecvError::Lagged(skipped))) => {
                self.rx = context.stream.video_tx.subscribe();
                self.seen_keyframe = false;
                request_video_keyframe(context.stream);
                self.dropped = self.dropped.saturating_add(skipped as usize);
                debug!(peer = %context.peer, key = %context.key, skipped, "rtsp video client lagged behind streamer");
            }
            VideoRtpEvent::Message(Err(broadcast::error::RecvError::Closed)) => return Ok(false),
            VideoRtpEvent::Report => {
                self.rtcp
                    .send_report(&mut self.sender, context.writer, &self.rtp, context.key)
                    .await?;
                self.rtcp_sleep
                    .as_mut()
                    .reset(TokioInstant::now() + RTCP_REPORT_INTERVAL);
            }
        }
        Ok(true)
    }
}

enum VideoRtpEvent {
    Message(Result<VideoMessage, broadcast::error::RecvError>),
    Report,
}

async fn next_video_event(track: Option<&mut VideoRtpTrack>) -> VideoRtpEvent {
    let Some(track) = track else {
        return pending().await;
    };
    let report_started = track.rtcp.started();
    tokio::select! {
        message = track.rx.recv() => VideoRtpEvent::Message(message),
        _ = &mut track.rtcp_sleep, if report_started => VideoRtpEvent::Report,
    }
}

async fn rtsp_media_rtp_task(task: RtspMediaTask) {
    let RtspMediaTask {
        writer,
        state,
        stream,
        key,
        peer,
        audio,
        video,
        suppress_placeholders,
    } = task;
    let play_started_at = TokioInstant::now();
    let mut timeline = RtpMediaTimeline::default();
    let mut audio = audio.map(|track| AudioRtpTrack::new(track, play_started_at));
    let mut video = video.map(|track| VideoRtpTrack::new(track, play_started_at));
    let mut resync_epoch = stream.resync_epoch.load(Ordering::Acquire);

    if video.is_some() && channel_video_state(&stream) == VideoStreamState::Video {
        request_video_keyframe(&stream);
    }

    loop {
        let current_resync_epoch = stream.resync_epoch.load(Ordering::Acquire);
        if current_resync_epoch != resync_epoch {
            if let Some(track) = audio.as_mut() {
                track.resync(&stream);
            }
            if let Some(track) = video.as_mut() {
                track.resync(&stream);
            }
            resync_epoch = current_resync_epoch;
            debug!(%peer, %key, epoch = current_resync_epoch, "rtsp listener force resynced");
        }

        if let Some(track) = audio.as_mut() {
            let queued = track.drop_backlog(&stream);
            if queued != 0 {
                debug!(%peer, %key, queued, "rtsp audio backlog dropped");
            }
        }
        if let Some(track) = video.as_mut()
            && let Err(error) = track
                .sync_state(
                    &writer,
                    &state.placeholders,
                    &stream,
                    &key,
                    suppress_placeholders,
                )
                .await
        {
            warn!(%peer, %key, %error, "rtsp video placeholder writer failed");
            break;
        }
        if audio.is_none() && video.is_none() {
            break;
        }

        let streamer_active = stream.streamer.load(Ordering::Acquire);
        let context = RtpTaskContext {
            writer: &writer,
            stream: &stream,
            resync_epoch,
            key: &key,
            peer: &peer,
        };
        tokio::select! {
            event = next_audio_event(audio.as_mut(), streamer_active) => {
                let Some(track) = audio.as_mut() else {
                    continue;
                };
                let result = track.handle_event(event, &context, &mut timeline).await;
                match result {
                    Ok(true) => {}
                    Ok(false) => break,
                    Err(error) => {
                        warn!(%peer, %key, %error, "rtsp audio writer failed");
                        break;
                    }
                }
            }
            event = next_video_event(video.as_mut()) => {
                let Some(track) = video.as_mut() else {
                    continue;
                };
                let result = track.handle_event(event, &context, &mut timeline).await;
                match result {
                    Ok(true) => {}
                    Ok(false) => break,
                    Err(error) => {
                        warn!(%peer, %key, %error, "rtsp video writer failed");
                        break;
                    }
                }
            }
        }
    }

    let audio_packets = audio.as_ref().map_or(0, |track| track.packets);
    let silence_packets = audio.as_ref().map_or(0, |track| track.silence_packets);
    let audio_dropped = audio.as_ref().map_or(0, |track| track.dropped);
    let video_packets = video.as_ref().map_or(0, |track| track.packets);
    let video_dropped = video.as_ref().map_or(0, |track| track.dropped);
    info!(
        %peer,
        %key,
        audio_packets,
        silence_packets,
        audio_dropped,
        video_packets,
        video_dropped,
        "rtsp media ended"
    );
}

enum RtspInput {
    Request(RtspRequest),
    Interleaved {
        channel: u8,
        requests_keyframe: bool,
    },
}

#[cfg(test)]
pub(crate) async fn read_rtsp_request<R>(reader: &mut R) -> RtspResult<Option<RtspRequest>>
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
) -> RtspResult<Option<RtspInput>>
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
) -> RtspResult<()> {
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

pub(crate) struct RtpPacketWriter {
    channel: u8,
    packet: Vec<u8>,
}

#[derive(Clone, Copy)]
struct RtcpMediaTime {
    rtp_timestamp: u32,
    published_at: StdInstant,
}

impl RtcpMediaTime {
    fn new(rtp_timestamp: u32, published_at: StdInstant) -> Self {
        Self {
            rtp_timestamp,
            published_at,
        }
    }

    fn timestamp_at(self, now: StdInstant, clock_rate: u32) -> u32 {
        project_rtp_timestamp(
            self.rtp_timestamp,
            now.saturating_duration_since(self.published_at),
            clock_rate,
        )
    }
}

pub(crate) fn project_rtp_timestamp(timestamp: u32, elapsed: Duration, clock_rate: u32) -> u32 {
    let whole_ticks = elapsed.as_secs().wrapping_mul(clock_rate as u64);
    let fractional_ticks = elapsed.subsec_nanos() as u64 * clock_rate as u64 / 1_000_000_000;
    timestamp.wrapping_add(whole_ticks.wrapping_add(fractional_ticks) as u32)
}

struct RtcpReporter {
    media_time: Option<RtcpMediaTime>,
    ssrc: u32,
    clock_rate: u32,
}

impl RtcpReporter {
    fn new(ssrc: u32, clock_rate: u32) -> Self {
        Self {
            media_time: None,
            ssrc,
            clock_rate,
        }
    }

    fn started(&self) -> bool {
        self.media_time.is_some()
    }

    fn record(&mut self, media_time: RtcpMediaTime) {
        self.media_time = Some(media_time);
    }

    async fn start_if_needed(
        &self,
        sender: &mut RtpPacketWriter,
        writer: &SharedRtspWriter,
        media_time: RtcpMediaTime,
        timer: &mut Pin<Box<Sleep>>,
        rtp: &RtpState,
        cname: &str,
    ) -> RtspResult<()> {
        if self.started() {
            return Ok(());
        }
        sender
            .send_sender_report(writer, self.ssrc, media_time, self.clock_rate, rtp, cname)
            .await?;
        timer
            .as_mut()
            .reset(TokioInstant::now() + RTCP_REPORT_INTERVAL);
        Ok(())
    }

    async fn send_report(
        &self,
        sender: &mut RtpPacketWriter,
        writer: &SharedRtspWriter,
        rtp: &RtpState,
        cname: &str,
    ) -> RtspResult<()> {
        let Some(media_time) = self.media_time else {
            return Ok(());
        };
        sender
            .send_sender_report(writer, self.ssrc, media_time, self.clock_rate, rtp, cname)
            .await
    }
}

impl RtpPacketWriter {
    pub(crate) fn new(channel: u8, packet_capacity: usize) -> Self {
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
    ) -> RtspResult<()> {
        let packet_len = 12 + 2 + 2 + access_unit.len();
        if packet_len > u16::MAX as usize {
            return Err("rtp packet too large".into());
        }

        self.packet.clear();
        self.push_rtp_interleaved_header(
            4 + access_unit.len(),
            RTP_AUDIO_PAYLOAD_TYPE,
            true,
            rtp.sequence,
            rtp.timestamp,
            RTP_AUDIO_SSRC,
        );
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

    pub(crate) async fn send_h264_access_unit(
        &mut self,
        writer: &SharedRtspWriter,
        access_unit: &[u8],
        single_nal: bool,
        batch_writes: bool,
        rtp: &mut RtpState,
    ) -> RtspResult<()> {
        let mut nal_start = start_h264_payload(access_unit)?;
        let mut locked = writer.lock().await;
        let batch_limit = if batch_writes {
            RTP_TCP_WRITE_BATCH_BYTES
        } else {
            RTP_PACKET_BUFFER_BYTES
        };
        self.packet.clear();
        if single_nal {
            self.send_h264_nal(
                &mut locked,
                &access_unit[nal_start..],
                true,
                batch_limit,
                rtp,
            )
            .await?;
            return self.flush_h264_packets(&mut locked).await;
        }

        let mut pending = None;

        loop {
            let next = find_h264_start_code(access_unit, nal_start);
            let nal_end = next.map_or(access_unit.len(), |(index, _)| index);
            if nal_end > nal_start
                && let Some(nal) = pending.replace(&access_unit[nal_start..nal_end])
            {
                self.send_h264_nal(&mut locked, nal, false, batch_limit, rtp)
                    .await?;
            }
            let Some((start, len)) = next else {
                break;
            };
            nal_start = start + len;
        }

        let nal = pending.ok_or("h264 access unit has no nal units")?;
        self.send_h264_nal(&mut locked, nal, true, batch_limit, rtp)
            .await?;
        self.flush_h264_packets(&mut locked).await
    }

    async fn send_h264_nal(
        &mut self,
        writer: &mut OwnedWriteHalf,
        nal: &[u8],
        marker_on_last_packet: bool,
        batch_limit: usize,
        rtp: &mut RtpState,
    ) -> RtspResult<()> {
        if nal.len() <= RTP_MAX_PAYLOAD_BYTES {
            self.flush_h264_batch_if_full(writer, nal.len(), batch_limit)
                .await?;
            self.push_rtp_interleaved_header(
                nal.len(),
                RTP_VIDEO_PAYLOAD_TYPE,
                marker_on_last_packet,
                rtp.sequence,
                rtp.timestamp,
                RTP_VIDEO_SSRC,
            );
            self.packet.extend_from_slice(nal);
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

            self.flush_h264_batch_if_full(writer, 2 + end - offset, batch_limit)
                .await?;
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
            rtp.record_packet(2 + end - offset);
            offset = end;
        }

        Ok(())
    }

    async fn flush_h264_batch_if_full(
        &mut self,
        writer: &mut OwnedWriteHalf,
        payload_len: usize,
        batch_limit: usize,
    ) -> RtspResult<()> {
        if !self.packet.is_empty() && self.packet.len() + 4 + 12 + payload_len > batch_limit {
            self.flush_h264_packets(writer).await?;
        }
        Ok(())
    }

    fn shrink_to_packet_buffer(&mut self) {
        self.packet.clear();
        self.packet.shrink_to(RTP_PACKET_BUFFER_BYTES);
    }

    async fn flush_h264_packets(&mut self, writer: &mut OwnedWriteHalf) -> RtspResult<()> {
        if !self.packet.is_empty() {
            writer.write_all(&self.packet).await?;
            self.packet.clear();
        }
        Ok(())
    }

    async fn send_sender_report(
        &mut self,
        writer: &SharedRtspWriter,
        ssrc: u32,
        media_time: RtcpMediaTime,
        clock_rate: u32,
        rtp: &RtpState,
        cname: &str,
    ) -> RtspResult<()> {
        let now = StdInstant::now();
        let ntp = ntp_timestamp(SystemTime::now());
        let rtp_timestamp = media_time.timestamp_at(now, clock_rate);
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

pub(crate) fn rtsp_sdp(video_fmtp: Option<&str>) -> String {
    let mut sdp = String::with_capacity(512 + video_fmtp.map_or(0, str::len));
    let _ = write!(
        sdp,
        "v=0\r\n\
         o=- 0 0 IN IP4 127.0.0.1\r\n\
         s= \r\n\
         c=IN IP4 0.0.0.0\r\n\
         t=0 0\r\n\
         a=range:npt=now-\r\n\
         a=control:*\r\n"
    );
    if let Some(video_fmtp) = video_fmtp {
        let _ = write!(
            sdp,
            "m=video 0 RTP/AVP {RTP_VIDEO_PAYLOAD_TYPE}\r\n\
             a=control:trackID=0\r\n\
             a=rtpmap:{RTP_VIDEO_PAYLOAD_TYPE} H264/{H264_CLOCK_RATE}\r\n\
             a=fmtp:{RTP_VIDEO_PAYLOAD_TYPE} {video_fmtp}\r\n"
        );
    }
    let audio_track_id = usize::from(video_fmtp.is_some());
    let _ = write!(
        sdp,
        "m=audio 0 RTP/AVP {RTP_AUDIO_PAYLOAD_TYPE}\r\n\
         a=control:trackID={audio_track_id}\r\n\
         a=rtpmap:{RTP_AUDIO_PAYLOAD_TYPE} mpeg4-generic/{AAC_SAMPLE_RATE}/{AAC_CHANNELS}\r\n\
         a=fmtp:{RTP_AUDIO_PAYLOAD_TYPE} config={AAC_AUDIO_SPECIFIC_CONFIG}; indexdeltalength=3; indexlength=3; mode=AAC-hbr; profile-level-id=1; sizelength=13; streamtype=5\r\n"
    );
    sdp
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

pub(crate) fn rtsp_track_from_uri(uri: &str, video_advertised: bool) -> RtspTrack {
    if video_advertised
        && uri
            .split(['?', '#'])
            .next()
            .unwrap_or(uri)
            .rsplit('/')
            .next()
            .is_some_and(|segment| segment.eq_ignore_ascii_case("trackID=0"))
    {
        return RtspTrack::Video;
    }
    RtspTrack::Audio
}

pub(crate) fn rtsp_rtp_info(uri: &str, session: &RtspSession) -> String {
    let base = rtsp_content_base(uri);
    let base = base.trim_end_matches('/');
    let mut out = String::with_capacity(128);
    if session.video_setup {
        let _ = write!(
            out,
            "url={base}/trackID=0;seq={};rtptime={}",
            session.video_rtp.sequence, session.video_rtp.timestamp
        );
    }
    if session.audio_setup {
        if !out.is_empty() {
            out.push(',');
        }
        let track_id = usize::from(session.video_advertised);
        let _ = write!(
            out,
            "url={base}/trackID={track_id};seq={};rtptime={}",
            session.audio_rtp.sequence, session.audio_rtp.timestamp
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
        RtspTrack::Audio if session.video_advertised => 2,
        RtspTrack::Audio => 0,
        RtspTrack::Video => 0,
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
    if candidate == u8::MAX {
        return false;
    }
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

fn rtsp_video_description(state: &AppState, key: &str) -> (VideoStreamState, Arc<str>) {
    let channel = state
        .channels
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(key)
        .cloned();
    let Some(channel) = channel else {
        return (
            VideoStreamState::Offline,
            state.placeholders.offline_fmtp.clone(),
        );
    };

    let video_state = channel_video_state(&channel);
    let fmtp = match video_state {
        VideoStreamState::Video => channel
            .video_fmtp()
            .unwrap_or_else(|| state.placeholders.audio_only_fmtp.clone()),
        VideoStreamState::AudioOnly => state.placeholders.audio_only_fmtp.clone(),
        VideoStreamState::Offline => state.placeholders.offline_fmtp.clone(),
    };
    (video_state, fmtp)
}

pub(crate) fn should_advertise_video(androidx_media3: bool, state: VideoStreamState) -> bool {
    !androidx_media3 || state == VideoStreamState::Video
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
    pub(crate) media_rtp_task: MediaTaskGuard,
    pub(crate) audio_setup: bool,
    pub(crate) video_setup: bool,
    pub(crate) audio_channel: u8,
    pub(crate) video_channel: u8,
    pub(crate) audio_rtp: RtpState,
    pub(crate) video_rtp: RtpState,
    pub(crate) androidx_media3: bool,
    pub(crate) video_advertised: bool,
}

impl RtspSession {
    fn video_track_allowed(&self) -> bool {
        !self.androidx_media3 || self.video_advertised
    }

    fn stop(&mut self) {
        self.media_rtp_task.stop();
    }
}

#[derive(Default)]
pub(crate) struct MediaTaskGuard(Option<JoinHandle<()>>);

impl MediaTaskGuard {
    fn is_none(&self) -> bool {
        self.0.is_none()
    }

    fn start(&mut self, task: JoinHandle<()>) {
        self.stop();
        self.0 = Some(task);
    }

    async fn wait(&mut self) -> Result<(), tokio::task::JoinError> {
        let Some(task) = self.0.as_mut() else {
            return pending().await;
        };
        let result = task.await;
        self.0 = None;
        result
    }

    fn stop(&mut self) {
        if let Some(task) = self.0.take() {
            task.abort();
        }
    }
}

impl Drop for MediaTaskGuard {
    fn drop(&mut self) {
        self.stop();
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

pub(crate) struct RtpClock {
    started_at: TokioInstant,
    base_timestamp: u32,
    clock_rate: u32,
}

#[derive(Default)]
pub(crate) struct RtpMediaTimeline {
    epoch: usize,
    anchor: Option<RtpMediaAnchor>,
}

#[derive(Clone, Copy)]
struct RtpMediaAnchor {
    source_timestamp: u64,
    play_timestamp: i64,
}

impl RtpMediaTimeline {
    pub(crate) fn map(&mut self, epoch: usize, source_timestamp: u64, clock: &RtpClock) -> u32 {
        if self.epoch != epoch {
            self.epoch = epoch;
            self.anchor = None;
        }

        let anchor = *self.anchor.get_or_insert_with(|| RtpMediaAnchor {
            source_timestamp,
            play_timestamp: clock.media_timestamp(),
        });
        let media_delta = if source_timestamp >= anchor.source_timestamp {
            (source_timestamp - anchor.source_timestamp).min(i64::MAX as u64) as i64
        } else {
            -((anchor.source_timestamp - source_timestamp).min(i64::MAX as u64) as i64)
        };
        let play_timestamp = anchor.play_timestamp.saturating_add(media_delta);
        if media_delta >= MEDIA_TIMELINE_REANCHOR_TICKS {
            self.anchor = Some(RtpMediaAnchor {
                source_timestamp,
                play_timestamp,
            });
        }
        clock.timestamp_at(play_timestamp)
    }
}

impl RtpClock {
    pub(crate) fn new(base_timestamp: u32, clock_rate: u32, started_at: TokioInstant) -> Self {
        Self {
            started_at,
            base_timestamp,
            clock_rate,
        }
    }

    fn timestamp(&self) -> u32 {
        let ticks =
            (self.started_at.elapsed().as_nanos() * self.clock_rate as u128 / 1_000_000_000) as u32;
        self.base_timestamp.wrapping_add(ticks)
    }

    fn media_timestamp(&self) -> i64 {
        (self.started_at.elapsed().as_nanos() * MEDIA_CLOCK_RATE as u128 / 1_000_000_000) as i64
    }

    fn timestamp_at(&self, media_timestamp: i64) -> u32 {
        let media_ticks =
            media_timestamp.saturating_mul(self.clock_rate as i64) / MEDIA_CLOCK_RATE as i64;
        self.base_timestamp.wrapping_add(media_ticks as u32)
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

    pub(crate) fn is_androidx_media3(&self) -> bool {
        self.header("user-agent")
            .is_some_and(|value| value.starts_with("AndroidXMedia3"))
    }
}

struct RtspHeadersForLog<'a>(&'a [(String, String)]);

impl fmt::Debug for RtspHeadersForLog<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut headers = formatter.debug_map();
        for (name, value) in self.0 {
            if matches!(
                name.as_str(),
                "authorization" | "proxy-authorization" | "cookie" | "set-cookie"
            ) {
                headers.entry(name, &"[redacted]");
            } else {
                headers.entry(name, value);
            }
        }
        headers.finish()
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
        cleanup_channel(&self.state, &self.key, &self.channel);
    }
}
