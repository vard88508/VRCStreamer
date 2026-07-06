use axum::{
    Router,
    extract::{
        ConnectInfo, Query, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{
        HeaderMap, HeaderValue, StatusCode,
        header::{ACCESS_CONTROL_ALLOW_ORIGIN, CACHE_CONTROL, CONTENT_TYPE, HOST, ORIGIN, VARY},
    },
    response::{IntoResponse, Response},
    routing::get,
};
use axum_server::tls_rustls::RustlsConfig;
use bytes::Bytes;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    env,
    fmt::Write as _,
    fs,
    io::ErrorKind,
    net::{IpAddr, SocketAddr},
    process,
    sync::{
        Arc, Mutex as StdMutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, tcp::OwnedWriteHalf},
    sync::{Mutex, broadcast},
    task::JoinHandle,
    time::{Instant as TokioInstant, sleep_until, timeout},
};
use tracing::{debug, error, info, warn};
use tracing_subscriber::{EnvFilter, fmt};

const RTP_AUDIO_PAYLOAD_TYPE: u8 = 96;
const RTP_VIDEO_PAYLOAD_TYPE: u8 = 97;
const RTP_AUDIO_SSRC: u32 = 0x5652_4341;
const RTP_VIDEO_SSRC: u32 = 0x5652_4356;
const AAC_SAMPLE_RATE: u32 = 48_000;
const AAC_CHANNELS: u8 = 2;
const AAC_SAMPLES_PER_FRAME: u32 = 1024;
const AAC_AUDIO_SPECIFIC_CONFIG: &str = "1190";
const AAC_SILENCE_ACCESS_UNIT: &[u8] = &[0x21, 0x10, 0x04, 0x60, 0x8c, 0x1c];
const AAC_FRAME_DURATION: Duration =
    Duration::from_micros((AAC_SAMPLES_PER_FRAME as u64 * 1_000_000) / AAC_SAMPLE_RATE as u64);
const AAC_MAX_ACCESS_UNIT_BYTES: usize = 4 * 1024;
const H264_CLOCK_RATE: u32 = 90_000;
const H264_WIDTH: u16 = 1280;
const H264_HEIGHT: u16 = 720;
const H264_FPS: u32 = 30;
const H264_TIMESTAMP_DELTA: u32 = H264_CLOCK_RATE / H264_FPS;
const H264_MAX_ACCESS_UNIT_BYTES: usize = 512 * 1024;
const H264_MAX_NAL_UNITS: usize = 64;
const RTP_MAX_PAYLOAD_BYTES: usize = 1200;
const RTSP_MAX_BUFFER_FRAMES: usize = 96;
const RTSP_MAX_LINE_BYTES: usize = 4096;
const RTSP_MAX_HEADERS: usize = 64;
const RTSP_MAX_BODY_BYTES: usize = 4096;
const RTSP_DISCARD_BUFFER_BYTES: usize = 1024;
const STREAM_ID_HEX_CHARS: usize = 32;
const STREAM_ID_BYTES: usize = STREAM_ID_HEX_CHARS / 2;
const STREAM_CODE_BYTES: usize = 32;
const PLACEHOLDERS_PATH: &str = "placeholders";
const STREAMER_LISTENER_UPDATE_INTERVAL: Duration = Duration::from_secs(1);

type SharedRtspWriter = Arc<Mutex<OwnedWriteHalf>>;

#[derive(Clone)]
struct Config {
    server_name: String,
    server_description: String,
    bind_addr: SocketAddr,
    rtsp_bind_addr: SocketAddr,
    rtsp_public_base: Option<String>,
    tls_cert_path: Option<String>,
    tls_key_path: Option<String>,
    video_enabled: bool,
    max_connections: usize,
    max_streamers: usize,
    max_streamers_per_ip: usize,
    max_listeners_total: usize,
    max_listeners_per_stream: usize,
    max_listeners_per_ip: usize,
    max_http_requests_per_ip: usize,
    max_rtsp_requests_per_connection: usize,
    rtsp_handshake_timeout: Duration,
    http_rate_limit_window: Duration,
    max_tracked_ips: usize,
    egress_kbps_per_listener: usize,
    max_aac_frame_bytes: usize,
    max_ingest_bytes_per_sec: usize,
    max_h264_frame_bytes: usize,
    max_video_ingest_bytes_per_sec: usize,
    channel_buffer: usize,
    streamer_idle_timeout: Duration,
    passwords: Vec<String>,
    allow_any_origin: bool,
    allowed_origins: Vec<String>,
}

struct AppState {
    config: Config,
    channels: Mutex<HashMap<String, Arc<Channel>>>,
    ip_limits: StdMutex<HashMap<IpAddr, IpLimitEntry>>,
    placeholders: Placeholders,
    active_streamers: AtomicUsize,
    active_listeners: AtomicUsize,
    next_rtsp_session: AtomicUsize,
    log_salt: [u8; 16],
}

struct Channel {
    audio_tx: broadcast::Sender<Bytes>,
    video_tx: broadcast::Sender<Bytes>,
    streamer: AtomicBool,
    video_active: AtomicBool,
    listeners: AtomicUsize,
    resync_epoch: AtomicUsize,
}

impl Channel {
    fn new(buffer: usize) -> Self {
        let (audio_tx, _) = broadcast::channel(buffer);
        let (video_tx, _) = broadcast::channel(buffer);
        Self {
            audio_tx,
            video_tx,
            streamer: AtomicBool::new(false),
            video_active: AtomicBool::new(false),
            listeners: AtomicUsize::new(0),
            resync_epoch: AtomicUsize::new(0),
        }
    }
}

struct Placeholders {
    offline_video: Bytes,
    audio_only_video: Bytes,
}

enum StreamerMediaFrame {
    Audio(Bytes),
    Video { access_unit: Bytes, keyframe: bool },
}

enum StreamerTextCommand {
    ForceResync,
    VideoStart,
    VideoStop,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RtspTrack {
    Audio,
    Video,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum VideoStreamState {
    Offline,
    AudioOnly,
    Video,
}

struct IpLimitEntry {
    window_started: Instant,
    request_count: usize,
    streamers: usize,
    listeners: usize,
    last_seen: Instant,
}

impl IpLimitEntry {
    fn new(now: Instant) -> Self {
        Self {
            window_started: now,
            request_count: 0,
            streamers: 0,
            listeners: 0,
            last_seen: now,
        }
    }
}

#[derive(Deserialize)]
struct IngestQuery {
    code: String,
    password: Option<String>,
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let _ = rustls::crypto::ring::default_provider().install_default();

    fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("warn".parse()?))
        .init();

    let config = match Config::from_env() {
        Ok(config) => config,
        Err(error) => {
            error!(
                %error,
                active_streams = 0usize,
                active_listeners = 0usize,
                "server failed to load config"
            );
            return Err(error);
        }
    };
    let bind_addr = config.bind_addr;
    let placeholders = match load_placeholders(&config) {
        Ok(placeholders) => placeholders,
        Err(error) => {
            error!(
                %error,
                active_streams = 0usize,
                active_listeners = 0usize,
                "server failed to load placeholders"
            );
            return Err(error);
        }
    };
    let state = Arc::new(AppState {
        config,
        channels: Mutex::new(HashMap::new()),
        ip_limits: StdMutex::new(HashMap::new()),
        placeholders,
        active_streamers: AtomicUsize::new(0),
        active_listeners: AtomicUsize::new(0),
        next_rtsp_session: AtomicUsize::new(1),
        log_salt: make_log_salt(),
    });
    install_panic_hook(state.clone());

    let app = Router::new()
        .route("/healthz", get(healthz))
        .route("/stats", get(stats))
        .route("/ingest", get(ingest_ws))
        .with_state(state.clone());

    tokio::spawn(rtsp_server(state.clone(), state.config.rtsp_bind_addr));

    let handle = axum_server::Handle::new();
    tokio::spawn(shutdown_http_server(handle.clone()));

    let tls_cert_path = state.config.tls_cert_path.clone();
    let tls_key_path = state.config.tls_key_path.clone();
    let service = app.into_make_service_with_connect_info::<SocketAddr>();

    let result = async {
        if let (Some(cert_path), Some(key_path)) = (tls_cert_path, tls_key_path) {
            let tls_config = RustlsConfig::from_pem_file(cert_path, key_path).await?;
            info!(port = bind_addr.port(), "listening on https");
            axum_server::tls_rustls::bind_rustls(bind_addr, tls_config)
                .handle(handle)
                .serve(service)
                .await?;
        } else {
            info!(port = bind_addr.port(), "listening on http");
            axum_server::bind(bind_addr)
                .handle(handle)
                .serve(service)
                .await?;
        }

        Ok::<(), Box<dyn std::error::Error>>(())
    }
    .await;

    if let Err(error) = result {
        log_fatal_error(&state, error.as_ref());
        return Err(error);
    }

    Ok(())
}

impl Config {
    fn from_env() -> Result<Self, Box<dyn std::error::Error>> {
        let bind_addr = env::var("BIND_ADDR")
            .unwrap_or_else(|_| "0.0.0.0:443".to_owned())
            .parse()?;
        let rtsp_bind_addr: SocketAddr = env::var("RTSP_BIND_ADDR")
            .unwrap_or_else(|_| "0.0.0.0:554".to_owned())
            .parse()?;
        let rtsp_public_base = env_public_base("RTSP_PUBLIC_BASE", "rtspt://");
        let tls_cert_path = env_nonempty_or_default(
            "TLS_CERT_PATH",
            "/etc/letsencrypt/live/example.com/fullchain.pem",
        );
        let tls_key_path = env_nonempty_or_default(
            "TLS_KEY_PATH",
            "/etc/letsencrypt/live/example.com/privkey.pem",
        );
        if tls_cert_path.is_some() != tls_key_path.is_some() {
            return Err("TLS_CERT_PATH and TLS_KEY_PATH must be set together".into());
        }
        let video_enabled = env_bool("VIDEO", false);
        let max_connections = env_usize("MAX_CONNECTIONS", 320);
        let max_streamers = env_usize("MAX_STREAMERS", 0);
        let max_listeners_total = env_usize("MAX_LISTENERS_TOTAL", 0);
        let max_listeners_per_stream = env_usize("MAX_LISTENERS_PER_STREAM", 85);
        let max_listeners_per_ip = env_usize("MAX_LISTENERS_PER_IP", 6);
        let egress_kbps_per_listener = env_usize("EGRESS_KBPS_PER_LISTENER", 384);

        Ok(Self {
            server_name: env::var("SERVER_NAME")
                .unwrap_or_else(|_| "Self-Hosted Instance".to_owned()),
            server_description: env::var("SERVER_DESCRIPTION").unwrap_or_default(),
            bind_addr,
            rtsp_bind_addr,
            rtsp_public_base,
            tls_cert_path,
            tls_key_path,
            video_enabled,
            max_connections,
            max_streamers,
            max_streamers_per_ip: env_usize("MAX_STREAMERS_PER_IP", 3),
            max_listeners_total,
            max_listeners_per_stream,
            max_listeners_per_ip,
            max_http_requests_per_ip: env_usize("MAX_HTTP_REQUESTS_PER_IP", 120),
            max_rtsp_requests_per_connection: env_usize("MAX_RTSP_REQUESTS_PER_CONNECTION", 4096),
            rtsp_handshake_timeout: Duration::from_secs(
                env_u64("RTSP_HANDSHAKE_TIMEOUT_SECS", 30).max(1),
            ),
            http_rate_limit_window: Duration::from_secs(
                env_u64("HTTP_RATE_LIMIT_WINDOW_SECS", 60).max(1),
            ),
            max_tracked_ips: env_usize("MAX_TRACKED_IPS", 8192),
            egress_kbps_per_listener,
            max_aac_frame_bytes: env_usize("MAX_AAC_FRAME_BYTES", AAC_MAX_ACCESS_UNIT_BYTES),
            max_ingest_bytes_per_sec: env_usize("MAX_INGEST_BYTES_PER_SEC", 96 * 1024),
            max_h264_frame_bytes: env_usize("MAX_H264_FRAME_BYTES", H264_MAX_ACCESS_UNIT_BYTES),
            max_video_ingest_bytes_per_sec: env_usize(
                "MAX_VIDEO_INGEST_BYTES_PER_SEC",
                1024 * 1024,
            ),
            channel_buffer: env_usize("CHANNEL_BUFFER", 128),
            streamer_idle_timeout: Duration::from_secs(env_u64("STREAMER_IDLE_TIMEOUT_SECS", 120)),
            passwords: env_list("PASSWORD"),
            allow_any_origin: env_bool("ALLOW_ANY_ORIGIN", false),
            allowed_origins: env::var("ALLOWED_ORIGINS")
                .unwrap_or_else(|_| "https://vard.cc".to_owned())
                .split(',')
                .map(str::trim)
                .filter(|origin| !origin.is_empty())
                .map(str::to_owned)
                .collect(),
        })
    }
}

fn load_placeholders(config: &Config) -> Result<Placeholders, Box<dyn std::error::Error>> {
    let offline_video = load_placeholder(PLACEHOLDERS_PATH, "offline.h264")?;
    let audio_only_video = load_placeholder(PLACEHOLDERS_PATH, "audio_only.h264")?;
    validate_h264_access_unit(&offline_video, true, config.max_h264_frame_bytes)
        .map_err(|reason| format!("offline.h264 is invalid: {reason}"))?;
    validate_h264_access_unit(&audio_only_video, true, config.max_h264_frame_bytes)
        .map_err(|reason| format!("audio_only.h264 is invalid: {reason}"))?;

    Ok(Placeholders {
        offline_video,
        audio_only_video,
    })
}

fn load_placeholder(dir: &str, name: &str) -> Result<Bytes, Box<dyn std::error::Error>> {
    let bytes = fs::read(std::path::Path::new(dir).join(name))?;
    Ok(Bytes::from(bytes))
}

async fn healthz(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> Response {
    if !allow_http_request(&state, addr.ip()) {
        return text_response_with_cors(
            StatusCode::TOO_MANY_REQUESTS,
            "too many requests\n",
            &headers,
            &state.config,
        );
    }

    let mut response = ([(CONTENT_TYPE, "text/plain; charset=utf-8")], "ok\n").into_response();
    apply_http_cors(response.headers_mut(), &headers, &state.config);
    response
}

#[derive(Serialize)]
struct StatsResponse<'a> {
    name: &'a str,
    description: &'a str,
    rtsp_base: String,
    video: bool,
    active_connections: usize,
    active_streamers: usize,
    active_listeners: usize,
    active_streams: usize,
    estimated_egress_kbps: usize,
}

async fn stats(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> Response {
    if !allow_http_request(&state, addr.ip()) {
        return text_response_with_cors(
            StatusCode::TOO_MANY_REQUESTS,
            "too many requests\n",
            &headers,
            &state.config,
        );
    }

    let active_streams = {
        let channels = state.channels.lock().await;
        count_active_streams(&channels)
    };
    let active_streamers = state.active_streamers.load(Ordering::Acquire);
    let active_listeners = state.active_listeners.load(Ordering::Acquire);

    let mut response = axum::Json(StatsResponse {
        name: &state.config.server_name,
        description: &state.config.server_description,
        rtsp_base: public_rtsp_base(&state.config, &headers),
        video: state.config.video_enabled,
        active_connections: active_streamers.saturating_add(active_listeners),
        active_streamers,
        active_listeners,
        active_streams,
        estimated_egress_kbps: estimated_egress_kbps(&state.config),
    })
    .into_response();
    let response_headers = response.headers_mut();
    response_headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    apply_http_cors(response_headers, &headers, &state.config);
    response
}

async fn ingest_ws(
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
    let mut rate = RateWindow::new(Duration::from_secs(5));
    let mut video_rate = RateWindow::new(Duration::from_secs(5));
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
        };

        match message {
            Message::Binary(frame) => {
                match parse_streamer_media_frame(frame, &state.config) {
                    Ok(StreamerMediaFrame::Audio(access_unit)) => {
                        if !rate.allow(access_unit.len(), state.config.max_ingest_bytes_per_sec) {
                            warn!(%peer, %key, "streamer exceeded aac ingest rate");
                            let _ = socket.send(Message::Close(None)).await;
                            break;
                        }

                        let frame_len = access_unit.len();
                        if frames == 0 {
                            wake_video_listeners(&channel);
                        }
                        let _ = channel.audio_tx.send(access_unit);
                        frames += 1;
                        bytes = bytes.saturating_add(frame_len);
                        if frames == 1 {
                            info!(%peer, %key, "streamer sent first aac frame");
                        }
                    }
                    Ok(StreamerMediaFrame::Video {
                        access_unit,
                        keyframe,
                    }) => {
                        if !video_rate.allow(
                            access_unit.len(),
                            state.config.max_video_ingest_bytes_per_sec,
                        ) {
                            warn!(%peer, %key, "streamer exceeded h264 ingest rate");
                            let _ = socket.send(Message::Close(None)).await;
                            break;
                        }

                        if !channel.video_active.swap(true, Ordering::AcqRel) {
                            wake_video_listeners(&channel);
                        }
                        let frame_len = access_unit.len();
                        let _ = channel
                            .video_tx
                            .send(video_wire_frame(keyframe, &access_unit));
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
                let _ = socket.send(Message::Pong(payload)).await;
            }
            Message::Pong(_) => {}
            Message::Close(frame) => {
                let _ = socket.send(Message::Close(frame)).await;
                break;
            }
            Message::Text(text)
                if !state.config.video_enabled
                    && matches!(
                        streamer_text_command(text.as_str()),
                        Some(StreamerTextCommand::VideoStart | StreamerTextCommand::VideoStop)
                    ) =>
            {
                warn!(%peer, %key, "streamer sent video command while video is disabled");
                let _ = socket.send(Message::Close(None)).await;
                break;
            }
            Message::Text(text) => match streamer_text_command(text.as_str()) {
                Some(StreamerTextCommand::ForceResync) => {
                    let epoch = force_resync_channel(&channel);
                    let listeners = channel.listeners.load(Ordering::Acquire);
                    info!(%peer, %key, epoch, listeners, "streamer forced rtsp resync");
                }
                Some(StreamerTextCommand::VideoStart) => {
                    channel.video_active.store(true, Ordering::Release);
                    wake_video_listeners(&channel);
                    debug!(%peer, %key, "streamer started h264 video");
                }
                Some(StreamerTextCommand::VideoStop) => {
                    channel.video_active.store(false, Ordering::Release);
                    let epoch = force_resync_channel(&channel);
                    wake_video_listeners(&channel);
                    debug!(%peer, %key, epoch, "streamer stopped h264 video");
                }
                None => {
                    warn!(%peer, %key, "streamer sent text message");
                    let _ = socket.send(Message::Close(None)).await;
                    break;
                }
            },
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
    wake_media_listeners(channel);
    state.active_streamers.fetch_sub(1, Ordering::AcqRel);
    cleanup_channel(state, key, channel).await;
    info!(%peer, %key, frames, "aac streamer disconnected");
}

async fn rtsp_server(state: Arc<AppState>, bind_addr: SocketAddr) {
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

    loop {
        let request = if session.guard.is_none() {
            let now = TokioInstant::now();
            if now >= handshake_deadline {
                return Err("rtsp handshake timeout".into());
            }
            match timeout(handshake_deadline - now, read_rtsp_request(&mut reader)).await {
                Ok(result) => result?,
                Err(_) => return Err("rtsp handshake timeout".into()),
            }
        } else {
            read_rtsp_request(&mut reader).await?
        };
        let Some(request) = request else {
            break;
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
            let sdp = rtsp_sdp();
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

            if let Some((rx, key, channel, rtp)) = start_audio {
                session.audio_rtp_task = Some(tokio::spawn(rtsp_audio_rtp_task(
                    writer.clone(),
                    rx,
                    stream.clone(),
                    key,
                    peer.to_owned(),
                    channel,
                    rtp,
                )));
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
    audio_rx: broadcast::Receiver<Bytes>,
    video_rx: broadcast::Receiver<Bytes>,
    guard: ListenerGuard,
}

async fn rtsp_audio_rtp_task(
    writer: SharedRtspWriter,
    mut rx: broadcast::Receiver<Bytes>,
    stream: Arc<Channel>,
    key: String,
    peer: String,
    channel: u8,
    mut rtp: RtpState,
) {
    let mut buffer = VecDeque::<Bytes>::new();
    let started = true;
    let mut resync_epoch = stream.resync_epoch.load(Ordering::Acquire);
    let mut next_send_at = TokioInstant::now();
    let mut sleep = Box::pin(sleep_until(next_send_at));
    let mut packets = 0usize;
    let mut underruns = 0usize;
    let mut silence_packets = 0usize;
    let mut dropped = 0usize;
    let mut sender = RtpPacketWriter::new(channel);

    loop {
        let current_resync_epoch = stream.resync_epoch.load(Ordering::Acquire);
        if current_resync_epoch != resync_epoch {
            let cleared = buffer.len();
            buffer.clear();
            rx = stream.audio_tx.subscribe();
            rtp.skip_samples(AAC_SAMPLES_PER_FRAME.saturating_mul(cleared as u32));
            dropped = dropped.saturating_add(cleared);
            next_send_at = TokioInstant::now();
            sleep.as_mut().reset(next_send_at);
            resync_epoch = current_resync_epoch;
            debug!(%peer, %key, epoch = current_resync_epoch, cleared, "rtsp listener force resynced");
        }

        tokio::select! {
            frame = rx.recv() => {
                match frame {
                    Ok(frame) if frame.is_empty() => {
                        let cleared = buffer.len();
                        buffer.clear();
                        rtp.skip_samples(AAC_SAMPLES_PER_FRAME.saturating_mul(cleared as u32));
                        dropped = dropped.saturating_add(cleared);
                    }
                    Ok(frame) => {
                        buffer.push_back(frame);
                        while buffer.len() > RTSP_MAX_BUFFER_FRAMES {
                            buffer.pop_front();
                            rtp.skip_samples(AAC_SAMPLES_PER_FRAME);
                            dropped += 1;
                        }
                        if dropped != 0 && dropped.is_multiple_of(50) {
                            debug!(%peer, %key, dropped, "rtsp client dropped queued aac frames to keep latency bounded");
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        rtp.skip_samples(AAC_SAMPLES_PER_FRAME.saturating_mul(skipped as u32));
                        dropped = dropped.saturating_add(skipped as usize);
                        warn!(%peer, %key, skipped, "rtsp client lagged behind streamer");
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            _ = &mut sleep, if started => {
                let frame = if let Some(frame) = buffer.pop_front() {
                    frame
                } else {
                    underruns += 1;
                    silence_packets += 1;
                    Bytes::from_static(AAC_SILENCE_ACCESS_UNIT)
                };

                if let Err(error) = sender.send_aac(&writer, &frame, &mut rtp).await {
                    warn!(%peer, %key, %error, "rtsp rtp writer failed");
                    break;
                }

                packets += 1;
                next_send_at += AAC_FRAME_DURATION;
                let now = TokioInstant::now();
                if now.saturating_duration_since(next_send_at) > Duration::from_millis(250) {
                    next_send_at = now + AAC_FRAME_DURATION;
                }
                sleep.as_mut().reset(next_send_at);
            }
        }
    }

    info!(%peer, %key, packets, underruns, silence_packets, dropped, "rtsp rtp ended");
}

struct RtspVideoTask {
    writer: SharedRtspWriter,
    rx: broadcast::Receiver<Bytes>,
    state: Arc<AppState>,
    stream: Arc<Channel>,
    key: String,
    peer: String,
    channel: u8,
    rtp: RtpState,
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
    } = task;
    let mut seen_keyframe = false;
    let mut last_state = None;
    let mut resync_epoch = stream.resync_epoch.load(Ordering::Acquire);
    let video_clock = VideoRtpClock::new(rtp.timestamp);
    let mut packets = 0usize;
    let mut dropped = 0usize;
    let mut sender = RtpPacketWriter::new(channel);

    loop {
        let current_resync_epoch = stream.resync_epoch.load(Ordering::Acquire);
        if current_resync_epoch != resync_epoch {
            rx = stream.video_tx.subscribe();
            seen_keyframe = false;
            last_state = None;
            resync_epoch = current_resync_epoch;
            debug!(%peer, %key, epoch = current_resync_epoch, "rtsp video listener force resynced");
        }

        let current_state = channel_video_state(&stream);
        if last_state != Some(current_state) {
            seen_keyframe = false;
            last_state = Some(current_state);
            if let Some(frame) = placeholder_access_unit(&state.placeholders, current_state) {
                rtp.timestamp = video_clock.timestamp();
                if let Err(error) = sender.send_h264_access_unit(&writer, frame, &mut rtp).await {
                    warn!(%peer, %key, %error, "rtsp video placeholder writer failed");
                    break;
                }
                packets += 1;
            }
        }

        match rx.recv().await {
            Ok(frame) if frame.is_empty() => {
                seen_keyframe = false;
                last_state = None;
            }
            Ok(frame) => {
                let Some((keyframe, access_unit)) = split_video_wire_frame(frame) else {
                    continue;
                };
                if channel_video_state(&stream) != VideoStreamState::Video {
                    continue;
                }
                if keyframe {
                    seen_keyframe = true;
                }
                if !seen_keyframe {
                    continue;
                }
                rtp.timestamp = video_clock.timestamp();
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
                seen_keyframe = false;
                rtp.skip_samples(H264_TIMESTAMP_DELTA.saturating_mul(skipped as u32));
                dropped = dropped.saturating_add(skipped as usize);
                warn!(%peer, %key, skipped, "rtsp video client lagged behind streamer");
            }
            Err(broadcast::error::RecvError::Closed) => break,
        }
    }

    info!(%peer, %key, packets, dropped, "rtsp video rtp ended");
}

async fn read_rtsp_request<R>(
    reader: &mut R,
) -> Result<Option<RtspRequest>, Box<dyn std::error::Error + Send + Sync>>
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
            discard_exact(reader, len).await?;
            continue;
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

        return Ok(Some(RtspRequest {
            method: method.to_ascii_uppercase(),
            uri: uri.to_owned(),
            _version: version,
            headers,
        }));
    }
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
    fn new(channel: u8) -> Self {
        Self {
            channel,
            packet: Vec::with_capacity(4 + 12 + 2 + 2 + AAC_MAX_ACCESS_UNIT_BYTES),
        }
    }

    async fn send_aac(
        &mut self,
        writer: &SharedRtspWriter,
        access_unit: &[u8],
        rtp: &mut RtpState,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if let Err(reason) = validate_aac_access_unit(access_unit) {
            return Err(reason.into());
        }

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
        rtp.advance_by(AAC_SAMPLES_PER_FRAME);
        Ok(())
    }

    async fn send_h264_access_unit(
        &mut self,
        writer: &SharedRtspWriter,
        access_unit: &[u8],
        rtp: &mut RtpState,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let nal_count = h264_nal_count(access_unit)?;
        let mut nal_index = 0usize;
        let mut nal_start = start_h264_payload(access_unit)?;
        let mut locked = writer.lock().await;

        loop {
            let next = find_h264_start_code(access_unit, nal_start);
            let nal_end = next.map_or(access_unit.len(), |(index, _)| index);
            if nal_end > nal_start {
                nal_index += 1;
                self.send_h264_nal(
                    &mut locked,
                    &access_unit[nal_start..nal_end],
                    nal_index == nal_count,
                    rtp,
                )
                .await?;
            }
            let Some((start, len)) = next else {
                break;
            };
            nal_start = start + len;
        }

        rtp.timestamp = rtp.timestamp.wrapping_add(H264_TIMESTAMP_DELTA);
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
            rtp.sequence = rtp.sequence.wrapping_add(1);
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
            rtp.sequence = rtp.sequence.wrapping_add(1);
            offset = end;
        }

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

fn rtsp_sdp() -> String {
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
         a=fmtp:{RTP_VIDEO_PAYLOAD_TYPE} packetization-mode=1; profile-level-id=42e01f; max-fs=3600; max-mbps=108000\r\n\
         a=framesize:{RTP_VIDEO_PAYLOAD_TYPE} {H264_WIDTH}-{H264_HEIGHT}\r\n"
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

fn key_from_rtsp_uri(uri: &str) -> Option<&str> {
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

fn select_rtsp_interleaved_channel(
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

fn streamer_text_command(text: &str) -> Option<StreamerTextCommand> {
    match text.trim().to_ascii_lowercase().as_str() {
        "force_resync" => Some(StreamerTextCommand::ForceResync),
        "video_start" => Some(StreamerTextCommand::VideoStart),
        "video_stop" => Some(StreamerTextCommand::VideoStop),
        _ => None,
    }
}

fn force_resync_channel(channel: &Channel) -> usize {
    channel
        .resync_epoch
        .fetch_add(1, Ordering::AcqRel)
        .wrapping_add(1)
}

fn wake_audio_listeners(channel: &Channel) {
    let _ = channel.audio_tx.send(Bytes::new());
}

fn wake_video_listeners(channel: &Channel) {
    let _ = channel.video_tx.send(Bytes::new());
}

fn wake_media_listeners(channel: &Channel) {
    wake_audio_listeners(channel);
    wake_video_listeners(channel);
}

fn channel_video_state(channel: &Channel) -> VideoStreamState {
    if !channel.streamer.load(Ordering::Acquire) {
        VideoStreamState::Offline
    } else if channel.video_active.load(Ordering::Acquire) {
        VideoStreamState::Video
    } else {
        VideoStreamState::AudioOnly
    }
}

fn video_wire_frame(keyframe: bool, access_unit: &[u8]) -> Bytes {
    let mut out = Vec::with_capacity(1 + access_unit.len());
    out.push(if keyframe { 0x01 } else { 0x02 });
    out.extend_from_slice(access_unit);
    Bytes::from(out)
}

fn split_video_wire_frame(frame: Bytes) -> Option<(bool, Bytes)> {
    let (&kind, _) = frame.split_first()?;
    match kind {
        0x01 => Some((true, frame.slice(1..))),
        0x02 => Some((false, frame.slice(1..))),
        _ => None,
    }
}

fn placeholder_access_unit(placeholders: &Placeholders, state: VideoStreamState) -> Option<&Bytes> {
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
struct RtspSession {
    id: Option<String>,
    key: Option<String>,
    audio_rx: Option<broadcast::Receiver<Bytes>>,
    video_rx: Option<broadcast::Receiver<Bytes>>,
    _listener_ip_guard: Option<ListenerIpGuard>,
    guard: Option<ListenerGuard>,
    audio_rtp_task: Option<JoinHandle<()>>,
    video_rtp_task: Option<JoinHandle<()>>,
    audio_setup: bool,
    video_setup: bool,
    audio_channel: u8,
    video_channel: u8,
    audio_rtp: RtpState,
    video_rtp: RtpState,
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
struct RtpState {
    sequence: u16,
    timestamp: u32,
}

impl RtpState {
    fn advance_by(&mut self, timestamp_delta: u32) {
        self.timestamp = self.timestamp.wrapping_add(timestamp_delta);
        self.sequence = self.sequence.wrapping_add(1);
    }

    fn skip_samples(&mut self, timestamp_delta: u32) {
        self.timestamp = self.timestamp.wrapping_add(timestamp_delta);
    }
}

struct VideoRtpClock {
    started_at: TokioInstant,
    base_timestamp: u32,
}

impl VideoRtpClock {
    fn new(base_timestamp: u32) -> Self {
        Self {
            started_at: TokioInstant::now(),
            base_timestamp,
        }
    }

    fn timestamp(&self) -> u32 {
        let ticks = (self.started_at.elapsed().as_secs_f64() * H264_CLOCK_RATE as f64) as u32;
        self.base_timestamp.wrapping_add(ticks)
    }
}

struct RtspRequest {
    method: String,
    uri: String,
    _version: String,
    headers: Vec<(String, String)>,
}

impl RtspRequest {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(header_name, _)| header_name.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

async fn get_or_create_channel(state: &Arc<AppState>, key: &str) -> Arc<Channel> {
    let mut channels = state.channels.lock().await;
    channels
        .entry(key.to_owned())
        .or_insert_with(|| Arc::new(Channel::new(state.config.channel_buffer)))
        .clone()
}

async fn cleanup_channel(state: &Arc<AppState>, key: &str, channel: &Arc<Channel>) {
    if channel.streamer.load(Ordering::Acquire) || channel.listeners.load(Ordering::Acquire) != 0 {
        return;
    }

    let mut channels = state.channels.lock().await;
    if let Some(current) = channels.get(key)
        && Arc::ptr_eq(current, channel)
        && !current.streamer.load(Ordering::Acquire)
        && current.listeners.load(Ordering::Acquire) == 0
    {
        channels.remove(key);
    }
}

struct ListenerGuard {
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

fn validate_aac_access_unit(access_unit: &[u8]) -> Result<(), &'static str> {
    if access_unit.len() < 4 {
        return Err("aac frame is too small");
    }
    if access_unit.len() > AAC_MAX_ACCESS_UNIT_BYTES {
        return Err("aac frame is too large");
    }
    if looks_like_adts_frame(access_unit) {
        return Err("expected raw AAC access units, got ADTS");
    }
    if let Some(reason) = rejected_media_signature(access_unit) {
        return Err(reason);
    }
    Ok(())
}

fn parse_streamer_media_frame(
    frame: Bytes,
    config: &Config,
) -> Result<StreamerMediaFrame, &'static str> {
    let Some((&kind, _)) = frame.split_first() else {
        return Err("media frame is empty");
    };

    match kind {
        0x00 => {
            let access_unit = frame.slice(1..);
            if access_unit.len() > config.max_aac_frame_bytes {
                return Err("aac frame is too large");
            }
            validate_aac_access_unit(&access_unit)?;
            Ok(StreamerMediaFrame::Audio(access_unit))
        }
        0x01 | 0x02 => {
            if !config.video_enabled {
                return Err("video is disabled on this server");
            }
            let keyframe = kind == 0x01;
            let access_unit = frame.slice(1..);
            validate_h264_access_unit(&access_unit, keyframe, config.max_h264_frame_bytes)?;
            Ok(StreamerMediaFrame::Video {
                access_unit,
                keyframe,
            })
        }
        _ => {
            if frame.len() > config.max_aac_frame_bytes {
                return Err("aac frame is too large");
            }
            validate_aac_access_unit(&frame)?;
            Ok(StreamerMediaFrame::Audio(frame))
        }
    }
}

fn validate_h264_access_unit(
    access_unit: &[u8],
    keyframe: bool,
    max_bytes: usize,
) -> Result<(), &'static str> {
    if access_unit.len() < 5 {
        return Err("h264 access unit is too small");
    }
    if access_unit.len() > max_bytes {
        return Err("h264 access unit is too large");
    }
    if let Some(reason) = rejected_container_signature(access_unit) {
        return Err(reason);
    }

    let mut saw_slice = false;
    let mut saw_idr = false;
    for_each_h264_nal(access_unit, |nal| {
        if nal[0] & 0x80 != 0 {
            return Err("h264 forbidden zero bit is set");
        }
        match nal[0] & 0x1f {
            1 => saw_slice = true,
            5 => {
                saw_slice = true;
                saw_idr = true;
            }
            6..=9 => {}
            _ => return Err("unsupported h264 nal unit"),
        }
        Ok(())
    })?;

    if !saw_slice {
        return Err("h264 access unit has no video slice");
    }
    if keyframe && !saw_idr {
        return Err("h264 keyframe has no idr slice");
    }
    Ok(())
}

fn h264_nal_count(access_unit: &[u8]) -> Result<usize, &'static str> {
    let mut count = 0usize;
    for_each_h264_nal(access_unit, |_| {
        count += 1;
        Ok(())
    })?;
    Ok(count)
}

fn for_each_h264_nal<F>(access_unit: &[u8], mut f: F) -> Result<(), &'static str>
where
    F: FnMut(&[u8]) -> Result<(), &'static str>,
{
    let mut nal_start = start_h264_payload(access_unit)?;
    let mut count = 0usize;

    loop {
        let next = find_h264_start_code(access_unit, nal_start);
        let nal_end = next.map_or(access_unit.len(), |(index, _)| index);
        if nal_end > nal_start {
            count += 1;
            if count > H264_MAX_NAL_UNITS {
                return Err("too many h264 nal units");
            }
            f(&access_unit[nal_start..nal_end])?;
        }

        let Some((start, len)) = next else {
            break;
        };
        nal_start = start + len;
    }

    if count == 0 {
        return Err("h264 access unit has no nal units");
    }
    Ok(())
}

fn start_h264_payload(access_unit: &[u8]) -> Result<usize, &'static str> {
    find_h264_start_code(access_unit, 0)
        .map(|(start, len)| start + len)
        .ok_or("expected annex-b h264 start code")
}

fn find_h264_start_code(data: &[u8], from: usize) -> Option<(usize, usize)> {
    let mut i = from;
    while i + 3 <= data.len() {
        if data[i] == 0 && data[i + 1] == 0 {
            if data[i + 2] == 1 {
                return Some((i, 3));
            }
            if i + 4 <= data.len() && data[i + 2] == 0 && data[i + 3] == 1 {
                return Some((i, 4));
            }
        }
        i += 1;
    }
    None
}

fn rejected_media_signature(frame: &[u8]) -> Option<&'static str> {
    if let Some(reason) = rejected_container_signature(frame) {
        return Some(reason);
    }
    if frame.starts_with(&[0x00, 0x00, 0x01]) || frame.starts_with(&[0x00, 0x00, 0x00, 0x01]) {
        return Some("video codecs are not accepted");
    }
    None
}

fn rejected_container_signature(frame: &[u8]) -> Option<&'static str> {
    if frame.starts_with(b"ftyp") || frame.get(4..8) == Some(b"ftyp") {
        return Some("container formats are not accepted");
    }
    if frame.starts_with(b"OggS")
        || frame.starts_with(b"RIFF")
        || frame.starts_with(b"fLaC")
        || frame.starts_with(b"ID3")
        || frame.starts_with(&[0x1a, 0x45, 0xdf, 0xa3])
    {
        return Some("container formats are not accepted");
    }
    if frame[0] == 0x47 && frame.len() >= 188 && frame.get(188) == Some(&0x47) {
        return Some("mpeg-ts is not accepted");
    }
    if frame[0] == 0xff && (frame[1] & 0xe0) == 0xe0 {
        return Some("mpeg audio is not accepted");
    }
    None
}

fn looks_like_adts_frame(frame: &[u8]) -> bool {
    if frame.len() < 7 || frame[0] != 0xff || (frame[1] & 0xf0) != 0xf0 {
        return false;
    }

    let protection_absent = (frame[1] & 0x01) != 0;
    let header_len = if protection_absent { 7 } else { 9 };
    let frame_len = (((frame[3] & 0x03) as usize) << 11)
        | ((frame[4] as usize) << 3)
        | (((frame[5] & 0xe0) as usize) >> 5);

    frame_len == frame.len() && frame_len >= header_len
}

fn is_websocket_disconnect_noise(error: &dyn std::fmt::Display) -> bool {
    let text = error.to_string().to_ascii_lowercase();
    text.contains("connection reset without closing handshake")
        || text.contains("connection reset by peer")
        || text.contains("broken pipe")
}

struct RateWindow {
    started: Instant,
    bytes: usize,
    window: Duration,
}

impl RateWindow {
    fn new(window: Duration) -> Self {
        Self {
            started: Instant::now(),
            bytes: 0,
            window,
        }
    }

    fn allow(&mut self, len: usize, bytes_per_sec: usize) -> bool {
        if self.started.elapsed() >= self.window {
            self.started = Instant::now();
            self.bytes = 0;
        }

        self.bytes = self.bytes.saturating_add(len);
        self.bytes <= bytes_per_sec.saturating_mul(self.window.as_secs() as usize)
    }
}

fn allow_http_request(state: &Arc<AppState>, ip: IpAddr) -> bool {
    if state.config.max_http_requests_per_ip == 0 {
        return true;
    }

    let now = Instant::now();
    let mut limits = state
        .ip_limits
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    prune_ip_limits(&mut limits, now, &state.config);

    if !limits.contains_key(&ip)
        && state.config.max_tracked_ips != 0
        && limits.len() >= state.config.max_tracked_ips
    {
        return false;
    }

    let entry = limits.entry(ip).or_insert_with(|| IpLimitEntry::new(now));
    if now.duration_since(entry.window_started) >= state.config.http_rate_limit_window {
        entry.window_started = now;
        entry.request_count = 0;
    }

    entry.last_seen = now;
    if entry.request_count >= state.config.max_http_requests_per_ip {
        return false;
    }

    entry.request_count += 1;
    true
}

fn try_acquire_streamer_ip(
    state: &Arc<AppState>,
    ip: IpAddr,
) -> Result<Option<StreamerIpGuard>, &'static str> {
    if state.config.max_streamers_per_ip == 0 {
        return Ok(None);
    }

    let now = Instant::now();
    let mut limits = state
        .ip_limits
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    prune_ip_limits(&mut limits, now, &state.config);

    if !limits.contains_key(&ip)
        && state.config.max_tracked_ips != 0
        && limits.len() >= state.config.max_tracked_ips
    {
        return Err("too many tracked IPs\n");
    }

    let entry = limits.entry(ip).or_insert_with(|| IpLimitEntry::new(now));
    entry.last_seen = now;
    if entry.streamers >= state.config.max_streamers_per_ip {
        return Err("too many active streamers from this IP\n");
    }

    entry.streamers += 1;
    Ok(Some(StreamerIpGuard {
        state: state.clone(),
        ip,
    }))
}

fn try_acquire_listener_ip(
    state: &Arc<AppState>,
    ip: IpAddr,
) -> Result<Option<ListenerIpGuard>, &'static str> {
    if state.config.max_listeners_per_ip == 0 {
        return Ok(None);
    }

    let now = Instant::now();
    let mut limits = state
        .ip_limits
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    prune_ip_limits(&mut limits, now, &state.config);

    if !limits.contains_key(&ip)
        && state.config.max_tracked_ips != 0
        && limits.len() >= state.config.max_tracked_ips
    {
        return Err("453 Not Enough Bandwidth");
    }

    let entry = limits.entry(ip).or_insert_with(|| IpLimitEntry::new(now));
    entry.last_seen = now;
    if entry.listeners >= state.config.max_listeners_per_ip {
        return Err("453 Not Enough Bandwidth");
    }

    entry.listeners += 1;
    Ok(Some(ListenerIpGuard {
        state: state.clone(),
        ip,
    }))
}

fn prune_ip_limits(limits: &mut HashMap<IpAddr, IpLimitEntry>, now: Instant, config: &Config) {
    let idle_timeout = config.http_rate_limit_window.saturating_mul(2);
    limits.retain(|_, entry| {
        entry.streamers != 0
            || entry.listeners != 0
            || now.duration_since(entry.last_seen) < idle_timeout
    });
}

struct StreamerIpGuard {
    state: Arc<AppState>,
    ip: IpAddr,
}

impl Drop for StreamerIpGuard {
    fn drop(&mut self) {
        let mut limits = self
            .state
            .ip_limits
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(entry) = limits.get_mut(&self.ip) {
            entry.streamers = entry.streamers.saturating_sub(1);
            entry.last_seen = Instant::now();
        }
    }
}

struct ListenerIpGuard {
    state: Arc<AppState>,
    ip: IpAddr,
}

impl Drop for ListenerIpGuard {
    fn drop(&mut self) {
        let mut limits = self
            .state
            .ip_limits
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(entry) = limits.get_mut(&self.ip) {
            entry.listeners = entry.listeners.saturating_sub(1);
            entry.last_seen = Instant::now();
        }
    }
}

fn install_panic_hook(state: Arc<AppState>) {
    std::panic::set_hook(Box::new(move |panic| {
        let message = panic
            .payload()
            .downcast_ref::<&str>()
            .copied()
            .or_else(|| panic.payload().downcast_ref::<String>().map(String::as_str))
            .unwrap_or("panic");
        let location = panic
            .location()
            .map(|location| format!("{}:{}", location.file(), location.line()))
            .unwrap_or_else(|| "unknown".to_owned());
        let active_streams = active_streams(&state);
        let active_listeners = state.active_listeners.load(Ordering::Acquire);

        error!(
            %message,
            %location,
            ?active_streams,
            active_listeners,
            "server panicked"
        );
    }));
}

fn log_fatal_error(state: &AppState, error: &dyn std::error::Error) {
    let active_streams = active_streams(state);
    let active_listeners = state.active_listeners.load(Ordering::Acquire);

    error!(
        %error,
        ?active_streams,
        active_listeners,
        "server stopped after fatal error"
    );
}

fn active_streams(state: &AppState) -> Option<usize> {
    state
        .channels
        .try_lock()
        .ok()
        .map(|channels| count_active_streams(&channels))
}

fn count_active_streams(channels: &HashMap<String, Arc<Channel>>) -> usize {
    channels
        .values()
        .filter(|channel| channel.streamer.load(Ordering::Acquire))
        .count()
}

fn validate_code(code: &str) -> Result<(), &'static str> {
    if code.len() != STREAM_CODE_BYTES {
        return Err("code has invalid length\n");
    }
    if !code.bytes().all(|byte| (0x21..=0x7e).contains(&byte)) {
        return Err("code may contain only printable ascii characters without spaces\n");
    }
    Ok(())
}

fn password_allowed(password: Option<&str>, config: &Config) -> bool {
    config.passwords.is_empty()
        || password
            .is_some_and(|password| config.passwords.iter().any(|allowed| allowed == password))
}

fn max_ws_message_bytes(config: &Config) -> usize {
    let media_bytes = if config.video_enabled {
        config.max_h264_frame_bytes.max(config.max_aac_frame_bytes)
    } else {
        config.max_aac_frame_bytes
    };
    media_bytes.saturating_add(1024)
}

fn limit_allows(limit: usize, current: usize) -> bool {
    limit == 0 || current < limit
}

fn connection_limit_allows(state: &AppState, streamers: usize, listeners: usize) -> bool {
    limit_allows(
        state.config.max_connections,
        streamers.saturating_add(listeners),
    )
}

fn active_streamers(state: &AppState) -> usize {
    state.active_streamers.load(Ordering::Acquire)
}

fn active_listeners(state: &AppState) -> usize {
    state.active_listeners.load(Ordering::Acquire)
}

fn estimated_egress_kbps(config: &Config) -> usize {
    config
        .max_listeners_total
        .saturating_mul(config.egress_kbps_per_listener)
}

fn valid_hash(key: &str) -> bool {
    key.len() == STREAM_ID_HEX_CHARS && key.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn hash_code(code: &str) -> String {
    let digest = Sha256::digest(code.as_bytes());
    let mut out = String::with_capacity(STREAM_ID_HEX_CHARS);
    push_hex_prefix(&mut out, &digest, STREAM_ID_BYTES);
    out
}

fn make_log_salt() -> [u8; 16] {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let seed = Sha256::digest(format!("{}:{now}", process::id()).as_bytes());
    let mut salt = [0u8; 16];
    salt.copy_from_slice(&seed[..16]);
    salt
}

fn peer_id(state: &AppState, ip: IpAddr) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"VRCStreamer peer log id v1");
    hasher.update(state.log_salt);
    match ip {
        IpAddr::V4(ip) => hasher.update(ip.octets()),
        IpAddr::V6(ip) => hasher.update(ip.octets()),
    }
    let digest = hasher.finalize();
    let mut out = String::with_capacity(17);
    out.push_str("peer:");
    push_hex_prefix(&mut out, &digest, 6);
    out
}

fn push_hex_prefix(out: &mut String, bytes: &[u8], take: usize) {
    for &byte in bytes.iter().take(take) {
        out.push(hex_char(byte >> 4));
        out.push(hex_char(byte & 0x0f));
    }
}

fn streamer_hello_message(config: &Config, listeners: usize, rtsp_base: &str) -> String {
    let mut out = String::with_capacity(
        112 + config.server_name.len() + config.server_description.len() + rtsp_base.len(),
    );
    out.push_str("{\"type\":\"hello\",\"name\":");
    push_json_string(&mut out, &config.server_name);
    out.push_str(",\"description\":");
    push_json_string(&mut out, &config.server_description);
    out.push_str(",\"rtsp_base\":");
    push_json_string(&mut out, rtsp_base);
    out.push_str(",\"video\":");
    out.push_str(if config.video_enabled {
        "true"
    } else {
        "false"
    });
    out.push_str(",\"listeners\":");
    let _ = write!(out, "{listeners}");
    out.push('}');
    out
}

fn streamer_listeners_message(listeners: usize) -> String {
    let mut out = String::with_capacity(40);
    let _ = write!(out, "{{\"type\":\"listeners\",\"listeners\":{listeners}}}");
    out
}

fn push_json_string(out: &mut String, value: &str) {
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            ch if ch <= '\u{1f}' => {
                let _ = write!(out, "\\u{:04x}", ch as u32);
            }
            ch => out.push(ch),
        }
    }
    out.push('"');
}

fn hex_char(nibble: u8) -> char {
    match nibble {
        0..=9 => (b'0' + nibble) as char,
        10..=15 => (b'a' + (nibble - 10)) as char,
        _ => unreachable!(),
    }
}

fn origin_allowed(headers: &HeaderMap, config: &Config) -> bool {
    if config.allow_any_origin {
        return true;
    }

    let Some(origin) = headers.get(ORIGIN).and_then(|value| value.to_str().ok()) else {
        return true;
    };

    if config
        .allowed_origins
        .iter()
        .any(|allowed| allowed.eq_ignore_ascii_case(origin))
    {
        return true;
    }

    let Some(host) = headers.get(HOST).and_then(|value| value.to_str().ok()) else {
        return false;
    };

    origin_host(origin).is_some_and(|origin_host| origin_host.eq_ignore_ascii_case(host))
}

fn apply_http_cors(response: &mut HeaderMap, request: &HeaderMap, config: &Config) {
    let Some(origin) = cors_origin(request, config) else {
        return;
    };

    response.insert(ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    response.insert(VARY, HeaderValue::from_static("Origin"));
}

fn cors_origin(headers: &HeaderMap, config: &Config) -> Option<HeaderValue> {
    if config.allow_any_origin {
        return Some(HeaderValue::from_static("*"));
    }

    let origin = headers.get(ORIGIN)?.to_str().ok()?;
    if config
        .allowed_origins
        .iter()
        .any(|allowed| allowed.eq_ignore_ascii_case(origin))
    {
        return HeaderValue::from_str(origin).ok();
    }

    let host = headers.get(HOST)?.to_str().ok()?;
    if origin_host(origin).is_some_and(|origin_host| origin_host.eq_ignore_ascii_case(host)) {
        return HeaderValue::from_str(origin).ok();
    }

    None
}

fn origin_host(origin: &str) -> Option<&str> {
    let (_, rest) = origin.split_once("://")?;
    rest.split('/').next()
}

fn text_response(status: StatusCode, text: &'static str) -> Response {
    (status, [(CONTENT_TYPE, "text/plain; charset=utf-8")], text).into_response()
}

fn text_response_with_cors(
    status: StatusCode,
    text: &'static str,
    headers: &HeaderMap,
    config: &Config,
) -> Response {
    let mut response = text_response(status, text);
    apply_http_cors(response.headers_mut(), headers, config);
    response
}

fn env_usize(key: &str, default: usize) -> usize {
    env_usize_optional(key).unwrap_or(default)
}

fn env_usize_optional(key: &str) -> Option<usize> {
    env::var(key).ok().and_then(|value| value.parse().ok())
}

fn env_u64(key: &str, default: u64) -> u64 {
    env::var(key)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

fn env_bool(key: &str, default: bool) -> bool {
    env::var(key)
        .ok()
        .map(|value| {
            matches!(
                value.to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(default)
}

fn env_public_base(key: &str, default_scheme: &str) -> Option<String> {
    match env::var(key) {
        Ok(value) => normalize_public_base(&value, default_scheme),
        Err(_) => None,
    }
}

fn normalize_public_base(value: &str, default_scheme: &str) -> Option<String> {
    let mut text = value.trim();
    if text.is_empty() || text.eq_ignore_ascii_case("none") {
        return None;
    }
    let mut owned = String::new();
    if !text.contains("://") {
        owned.push_str(default_scheme);
        owned.push_str(text);
        text = &owned;
    }
    Some(text.trim_end_matches('/').to_owned())
}

fn public_rtsp_base(config: &Config, headers: &HeaderMap) -> String {
    if let Some(base) = &config.rtsp_public_base {
        return base.clone();
    }

    let host = headers
        .get(HOST)
        .and_then(|value| value.to_str().ok())
        .and_then(rtsp_host_from_http_host)
        .unwrap_or_else(|| default_rtsp_host(config.rtsp_bind_addr));
    let port = config.rtsp_bind_addr.port();
    if port == 554 {
        format!("rtspt://{host}")
    } else {
        format!("rtspt://{host}:{port}")
    }
}

fn rtsp_host_from_http_host(value: &str) -> Option<String> {
    let host = value.trim();
    if host.is_empty() {
        return None;
    }
    if host.starts_with('[') {
        let end = host.find(']')?;
        return Some(host[..=end].to_owned());
    }
    Some(host.split(':').next().unwrap_or(host).to_owned())
}

fn default_rtsp_host(bind_addr: SocketAddr) -> String {
    match bind_addr.ip() {
        IpAddr::V4(ip) if ip.is_unspecified() => "127.0.0.1".to_owned(),
        IpAddr::V6(ip) if ip.is_unspecified() => "[::1]".to_owned(),
        IpAddr::V6(ip) => format!("[{ip}]"),
        ip => ip.to_string(),
    }
}

fn env_list(key: &str) -> Vec<String> {
    env::var(key)
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect()
}

fn env_nonempty_or_default(key: &str, default: &str) -> Option<String> {
    match env::var(key) {
        Ok(value) if value.is_empty() || value.eq_ignore_ascii_case("none") => None,
        Ok(value) => Some(value),
        Err(_) => Some(default.to_owned()),
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        let _ = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install signal handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}

async fn shutdown_http_server(handle: axum_server::Handle<SocketAddr>) {
    shutdown_signal().await;
    handle.graceful_shutdown(Some(Duration::from_secs(10)));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config() -> Config {
        Config {
            server_name: "VRCStreamer".to_owned(),
            server_description: "Test server".to_owned(),
            bind_addr: "127.0.0.1:8080".parse().unwrap(),
            rtsp_bind_addr: "127.0.0.1:8554".parse().unwrap(),
            rtsp_public_base: None,
            tls_cert_path: None,
            tls_key_path: None,
            video_enabled: true,
            max_connections: 0,
            max_streamers: 1,
            max_streamers_per_ip: 3,
            max_listeners_total: 1,
            max_listeners_per_stream: 1,
            max_listeners_per_ip: 16,
            max_http_requests_per_ip: 120,
            max_rtsp_requests_per_connection: 4096,
            rtsp_handshake_timeout: Duration::from_secs(30),
            http_rate_limit_window: Duration::from_secs(60),
            max_tracked_ips: 16,
            egress_kbps_per_listener: 384,
            max_aac_frame_bytes: AAC_MAX_ACCESS_UNIT_BYTES,
            max_ingest_bytes_per_sec: 128 * 1024,
            max_h264_frame_bytes: H264_MAX_ACCESS_UNIT_BYTES,
            max_video_ingest_bytes_per_sec: 1024 * 1024,
            channel_buffer: 8,
            streamer_idle_timeout: Duration::from_secs(1),
            passwords: Vec::new(),
            allow_any_origin: false,
            allowed_origins: Vec::new(),
        }
    }

    fn test_state(config: Config) -> Arc<AppState> {
        Arc::new(AppState {
            config,
            channels: Mutex::new(HashMap::new()),
            ip_limits: StdMutex::new(HashMap::new()),
            placeholders: Placeholders {
                offline_video: Bytes::new(),
                audio_only_video: Bytes::new(),
            },
            active_streamers: AtomicUsize::new(0),
            active_listeners: AtomicUsize::new(0),
            next_rtsp_session: AtomicUsize::new(1),
            log_salt: [7; 16],
        })
    }

    #[test]
    fn hash_code_matches_sha256_128_bit_hex_prefix() {
        assert_eq!(hash_code("abc"), "ba7816bf8f01cfea414140de5dae2223");
    }

    #[test]
    fn peer_id_hides_raw_ip() {
        let state = test_state(test_config());
        let ip: IpAddr = "203.0.113.42".parse().unwrap();
        let peer = peer_id(&state, ip);

        assert!(peer.starts_with("peer:"));
        assert_eq!(peer, peer_id(&state, ip));
        assert!(!peer.contains("203.0.113.42"));
    }

    #[test]
    fn websocket_disconnect_noise_is_not_warning_worthy() {
        assert!(is_websocket_disconnect_noise(
            &"WebSocket protocol error: Connection reset without closing handshake"
        ));
        assert!(is_websocket_disconnect_noise(&"connection reset by peer"));
        assert!(is_websocket_disconnect_noise(&"Broken pipe"));
        assert!(!is_websocket_disconnect_noise(
            &"WebSocket protocol error: invalid frame opcode"
        ));
    }

    fn run_async_test<F: std::future::Future<Output = ()>>(future: F) {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future);
    }

    #[test]
    fn rtsp_parser_accepts_bounded_request_line() {
        run_async_test(async {
            let input = b"OPTIONS rtspt://127.0.0.1/abc RTSP/1.0\r\nCSeq: 1\r\n\r\n";
            let mut reader = BufReader::new(&input[..]);
            let request = read_rtsp_request(&mut reader).await.unwrap().unwrap();

            assert_eq!(request.method, "OPTIONS");
            assert_eq!(request.uri, "rtspt://127.0.0.1/abc");
            assert_eq!(request.header("cseq"), Some("1"));
        });
    }

    #[test]
    fn rtsp_parser_rejects_unbounded_request_line() {
        run_async_test(async {
            let input = vec![b'A'; RTSP_MAX_LINE_BYTES + 1];
            let mut reader = BufReader::new(input.as_slice());
            let error = match read_rtsp_request(&mut reader).await {
                Ok(_) => panic!("oversized request line was accepted"),
                Err(error) => error,
            };

            assert!(error.to_string().contains("rtsp line too long"));
        });
    }

    #[test]
    fn streamer_text_command_accepts_force_resync() {
        assert!(matches!(
            streamer_text_command("force_resync"),
            Some(StreamerTextCommand::ForceResync)
        ));
        assert!(matches!(
            streamer_text_command(" FORCE_RESYNC "),
            Some(StreamerTextCommand::ForceResync)
        ));
        assert!(streamer_text_command("hello").is_none());
    }

    #[test]
    fn force_resync_channel_advances_epoch() {
        let channel = Channel::new(8);
        assert_eq!(channel.resync_epoch.load(Ordering::Acquire), 0);
        assert_eq!(force_resync_channel(&channel), 1);
        assert_eq!(channel.resync_epoch.load(Ordering::Acquire), 1);
        assert_eq!(force_resync_channel(&channel), 2);
    }

    #[test]
    fn audio_only_stream_start_wakes_video_listeners() {
        let channel = Channel::new(8);
        let mut rx = channel.video_tx.subscribe();

        assert!(matches!(
            channel_video_state(&channel),
            VideoStreamState::Offline
        ));
        channel.streamer.store(true, Ordering::Release);
        wake_video_listeners(&channel);

        assert!(rx.try_recv().unwrap().is_empty());
        assert!(matches!(
            channel_video_state(&channel),
            VideoStreamState::AudioOnly
        ));
    }

    #[test]
    fn streamer_hello_message_escapes_json_strings() {
        let mut config = test_config();
        config.server_name = "Name \"A\"".to_owned();
        config.server_description = "Line\nTwo".to_owned();

        assert_eq!(
            streamer_hello_message(&config, 7, "rtspt://example.com"),
            "{\"type\":\"hello\",\"name\":\"Name \\\"A\\\"\",\"description\":\"Line\\nTwo\",\"rtsp_base\":\"rtspt://example.com\",\"video\":true,\"listeners\":7}"
        );
    }

    #[test]
    fn code_accepts_exact_length_printable_ascii_without_spaces() {
        assert!(validate_code("Abc123!@Abc123!@Abc123!@Abc123!@").is_ok());
        assert!(validate_code("Abc 123!Abc123!@Abc123!@Abc123!@").is_err());
        assert!(validate_code("short").is_err());
    }

    #[test]
    fn http_rate_limit_blocks_after_configured_requests() {
        let mut config = test_config();
        config.max_http_requests_per_ip = 2;
        let state = test_state(config);
        let ip = "127.0.0.1".parse().unwrap();

        assert!(allow_http_request(&state, ip));
        assert!(allow_http_request(&state, ip));
        assert!(!allow_http_request(&state, ip));
    }

    #[test]
    fn streamer_ip_limit_releases_when_guard_drops() {
        let mut config = test_config();
        config.max_streamers_per_ip = 1;
        let state = test_state(config);
        let ip = "127.0.0.1".parse().unwrap();

        let guard = try_acquire_streamer_ip(&state, ip).unwrap();
        assert!(guard.is_some());
        assert!(try_acquire_streamer_ip(&state, ip).is_err());
        drop(guard);
        assert!(try_acquire_streamer_ip(&state, ip).unwrap().is_some());
    }

    #[test]
    fn listener_ip_limit_releases_when_guard_drops() {
        let mut config = test_config();
        config.max_listeners_per_ip = 1;
        let state = test_state(config);
        let ip = "127.0.0.1".parse().unwrap();

        let guard = try_acquire_listener_ip(&state, ip).unwrap();
        assert!(guard.is_some());
        assert!(try_acquire_listener_ip(&state, ip).is_err());
        drop(guard);
        assert!(try_acquire_listener_ip(&state, ip).unwrap().is_some());
    }

    #[test]
    fn zero_limit_means_disabled() {
        assert!(limit_allows(0, usize::MAX));
        assert!(limit_allows(3, 2));
        assert!(!limit_allows(3, 3));
    }

    #[test]
    fn max_connections_counts_streamers_and_listeners() {
        let mut config = test_config();
        config.max_connections = 3;
        let state = test_state(config);

        assert!(connection_limit_allows(&state, 1, 1));
        assert!(!connection_limit_allows(&state, 1, 2));
    }

    #[test]
    fn active_stream_count_ignores_offline_listener_channels() {
        let mut channels = HashMap::new();
        let offline = Arc::new(Channel::new(8));
        offline.listeners.store(1, Ordering::Release);
        channels.insert("offline".to_owned(), offline);

        let live = Arc::new(Channel::new(8));
        live.streamer.store(true, Ordering::Release);
        live.listeners.store(1, Ordering::Release);
        channels.insert("live".to_owned(), live);

        assert_eq!(count_active_streams(&channels), 1);
    }

    #[test]
    fn estimated_egress_uses_listener_limit_and_per_listener_cost() {
        let mut config = test_config();
        config.max_listeners_total = 85;
        config.egress_kbps_per_listener = 384;

        assert_eq!(estimated_egress_kbps(&config), 32640);
    }

    #[test]
    fn websocket_message_limit_ignores_h264_size_when_video_is_disabled() {
        let mut config = test_config();
        config.video_enabled = false;
        config.max_aac_frame_bytes = 4096;
        config.max_h264_frame_bytes = 512 * 1024;

        assert_eq!(max_ws_message_bytes(&config), 5120);
    }

    #[test]
    fn passwords_are_optional_and_exact() {
        let mut config = test_config();
        assert!(password_allowed(None, &config));

        config.passwords = vec!["alpha".to_owned(), "beta".to_owned()];
        assert!(!password_allowed(None, &config));
        assert!(!password_allowed(Some(""), &config));
        assert!(!password_allowed(Some("Alpha"), &config));
        assert!(password_allowed(Some("alpha"), &config));
        assert!(password_allowed(Some("beta"), &config));
    }

    #[test]
    fn validator_accepts_raw_aac_access_unit() {
        assert!(validate_aac_access_unit(&[0x21, 0x10, 0x56, 0xe5]).is_ok());
    }

    #[test]
    fn validator_rejects_adts_frame() {
        let adts = [
            0xff, 0xf1, 0x4c, 0x80, 0x01, 0x7f, 0xfc, 0x00, 0x00, 0x00, 0x00,
        ];
        assert_eq!(
            validate_aac_access_unit(&adts),
            Err("expected raw AAC access units, got ADTS")
        );
    }

    #[test]
    fn validator_rejects_common_container_and_video_signatures() {
        assert_eq!(
            validate_aac_access_unit(b"OggSnot aac"),
            Err("container formats are not accepted")
        );
        assert_eq!(
            validate_aac_access_unit(&[0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1f]),
            Err("video codecs are not accepted")
        );
        assert_eq!(
            validate_aac_access_unit(b"ID3not aac"),
            Err("container formats are not accepted")
        );
    }

    #[test]
    fn validator_rejects_oversized_access_unit() {
        assert_eq!(
            validate_aac_access_unit(&vec![0; AAC_MAX_ACCESS_UNIT_BYTES + 1]),
            Err("aac frame is too large")
        );
    }

    #[test]
    fn validator_accepts_annex_b_h264_keyframe() {
        let access_unit = [
            0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1f, 0, 0, 1, 0x65, 0x88, 0x84,
        ];
        assert!(validate_h264_access_unit(&access_unit, true, H264_MAX_ACCESS_UNIT_BYTES).is_ok());
    }

    #[test]
    fn streamer_rejects_video_frames_when_video_is_disabled() {
        let mut config = test_config();
        config.video_enabled = false;
        let frame = Bytes::from_static(&[
            0x01, 0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1f, 0, 0, 1, 0x65, 0x88, 0x84,
        ]);

        assert!(matches!(
            parse_streamer_media_frame(frame, &config),
            Err("video is disabled on this server")
        ));
    }

    #[test]
    fn validator_rejects_h264_keyframe_without_idr() {
        let access_unit = [0, 0, 0, 1, 0x41, 0x9a, 0x22];
        assert_eq!(
            validate_h264_access_unit(&access_unit, true, H264_MAX_ACCESS_UNIT_BYTES),
            Err("h264 keyframe has no idr slice")
        );
    }

    #[test]
    fn rtsp_uri_parser_extracts_hash() {
        let key = "a85c0211c512828c4c52dc5716a79e3a";

        assert_eq!(
            key_from_rtsp_uri("rtsp://example.com/a85c0211c512828c4c52dc5716a79e3a"),
            Some(key)
        );
        assert_eq!(
            key_from_rtsp_uri("/a85c0211c512828c4c52dc5716a79e3a/trackID=0"),
            Some(key)
        );
        assert_eq!(
            key_from_rtsp_uri("rtspt://example.com:8554/a85c0211c512828c4c52dc5716a79e3a?x=1"),
            Some(key)
        );
        assert!(valid_hash(key));
        assert!(!valid_hash(
            "a85c0211c512828c4c52dc5716a79e3acba2b62dd6575b986366fd84e0903bc1"
        ));
        assert!(!valid_hash(
            key_from_rtsp_uri("/live/a85c0211c512828c4c52dc5716a79e3a").unwrap()
        ));
    }

    #[test]
    fn rtsp_interleaved_channels_do_not_overlap_between_tracks() {
        let mut session = RtspSession {
            audio_setup: true,
            audio_channel: 0,
            ..RtspSession::default()
        };

        assert_eq!(
            select_rtsp_interleaved_channel(&session, RtspTrack::Video, Some(0)),
            2
        );
        assert_eq!(
            select_rtsp_interleaved_channel(&session, RtspTrack::Video, Some(2)),
            2
        );

        session.video_setup = true;
        session.video_channel = 2;
        assert_eq!(
            select_rtsp_interleaved_channel(&session, RtspTrack::Audio, Some(2)),
            0
        );
    }

    #[test]
    fn aac_rtp_timestamp_delta_is_one_access_unit() {
        let mut rtp = RtpState::default();
        rtp.advance_by(AAC_SAMPLES_PER_FRAME);
        assert_eq!(rtp.timestamp, 1024);
        assert_eq!(rtp.sequence, 1);
    }

    #[test]
    fn rtsp_sdp_matches_topaz_audio_shape() {
        let sdp = rtsp_sdp();

        assert!(sdp.contains("m=audio 0 RTP/AVP 96\r\n"));
        assert!(sdp.contains("a=control:trackID=0\r\n"));
        assert!(sdp.contains("a=rtpmap:96 mpeg4-generic/48000/2\r\n"));
        assert!(sdp.contains("config=1190"));
        assert!(sdp.contains("m=video 0 RTP/AVP 97\r\n"));
        assert!(sdp.contains("a=control:trackID=1\r\n"));
        assert!(sdp.contains("a=rtpmap:97 H264/90000\r\n"));
        assert!(sdp.contains("packetization-mode=1"));
    }

    #[test]
    fn streamer_video_flag_is_independent_from_rtsp_placeholder_track() {
        let mut config = test_config();
        config.video_enabled = false;

        assert!(
            streamer_hello_message(&config, 0, "rtspt://example.com").contains("\"video\":false")
        );
        assert!(rtsp_sdp().contains("m=video 0 RTP/AVP 97\r\n"));
    }
}
