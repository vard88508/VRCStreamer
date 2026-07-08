use axum::{
    Router,
    extract::{ConnectInfo, State},
    http::{
        HeaderMap, HeaderValue, StatusCode,
        header::{ACCESS_CONTROL_ALLOW_ORIGIN, CACHE_CONTROL, CONTENT_TYPE, HOST, ORIGIN, VARY},
    },
    response::{IntoResponse, Response},
    routing::get,
};
use axum_server::tls_rustls::RustlsConfig;
use bytes::Bytes;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    env,
    fmt::Write as _,
    fs,
    net::{IpAddr, SocketAddr},
    process,
    sync::{
        Arc, Mutex as StdMutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{Mutex, broadcast};
use tracing::{error, info};
use tracing_subscriber::{EnvFilter, fmt};

mod limits;
mod media;
mod rtsp;
#[cfg(test)]
mod tests;
mod websocket;

use limits::{IpLimitEntry, allow_http_request};
use media::{VideoMessage, validate_h264_access_unit};
use rtsp::rtsp_server;
use websocket::ingest_ws;

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
    video_tx: broadcast::Sender<VideoMessage>,
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
    let _ = channel.video_tx.send(VideoMessage::Wake);
}

fn wake_media_listeners(channel: &Channel) {
    wake_audio_listeners(channel);
    wake_video_listeners(channel);
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
