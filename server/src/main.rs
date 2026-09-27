use axum::{
    Router,
    extract::{ConnectInfo, State},
    http::{
        HeaderMap, HeaderValue, StatusCode,
        header::{
            ACCESS_CONTROL_ALLOW_ORIGIN, CACHE_CONTROL, CONTENT_TYPE, HOST, LOCATION, ORIGIN, VARY,
        },
    },
    response::{IntoResponse, Response},
    routing::get,
};
use axum_server::tls_rustls::{RustlsAcceptor, RustlsConfig};
use hyper_util::rt::TokioTimer;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::ErrorKind,
    net::{IpAddr, SocketAddr},
    path::{Path, PathBuf},
    process,
    sync::{
        Arc, Mutex as StdMutex, RwLock as StdRwLock,
        atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    net::TcpListener,
    sync::{Notify, broadcast},
};
use tracing::{error, info, warn};
use tracing_subscriber::{EnvFilter, fmt};

mod config;
mod limits;
mod media;
mod rtsp;
#[cfg(test)]
mod tests;
mod websocket;

use config::{Config, VideoQuality};
use limits::{IpLimitTable, allow_http_request};
use media::{AudioMessage, VideoMessage};
use rtsp::rtsp_server;
use websocket::stream_ws;

const RTP_VIDEO_PAYLOAD_TYPE: u8 = 96;
const RTP_AUDIO_PAYLOAD_TYPE: u8 = 97;
const RTP_AUDIO_SSRC: u32 = 0x5652_4341;
const RTP_VIDEO_SSRC: u32 = 0x5652_4356;
const AAC_SAMPLE_RATE: u32 = 48_000;
const AAC_CHANNELS: u8 = 2;
const AAC_SAMPLES_PER_FRAME: u32 = 1024;
const AAC_AUDIO_SPECIFIC_CONFIG: &str = "1190";
const AAC_SILENCE_ACCESS_UNIT: &[u8] = &[0x21, 0x10, 0x04, 0x60, 0x8c, 0x1c];
const AAC_FRAME_DURATION: Duration =
    Duration::from_micros((AAC_SAMPLES_PER_FRAME as u64 * 1_000_000) / AAC_SAMPLE_RATE as u64);
const AAC_MAX_BITRATE_KBPS: usize = 320;
const AAC_MAX_FRAMES_PER_SECOND: usize = 64;
const AAC_MAX_ACCESS_UNIT_BYTES: usize = 4 * 1024;
const AAC_MAX_INGEST_BYTES_PER_SECOND: usize = AAC_MAX_BITRATE_KBPS * 1000 / 8 * 6 / 5;
const AAC_INGEST_BURST_SECS: usize = 5;
const AAC_ABUSE_MAX_FRAMES_PER_SECOND: usize = AAC_MAX_FRAMES_PER_SECOND * 2;
const AAC_ABUSE_MAX_INGEST_BYTES_PER_SECOND: usize = AAC_MAX_INGEST_BYTES_PER_SECOND * 2;
const AAC_ABUSE_BURST_SECS: usize = 10;
const MEDIA_FRAME_HEADER_BYTES: usize = 5;
const MEDIA_CLOCK_RATE: u32 = AAC_SAMPLE_RATE;
const H264_CLOCK_RATE: u32 = 90_000;
const H264_MAX_NAL_UNITS: usize = 64;
const RTP_MAX_PAYLOAD_BYTES: usize = 1200;
const RTSP_MAX_LINE_BYTES: usize = 4096;
const RTSP_MAX_HEADER_BYTES: usize = 16 * 1024;
const RTSP_MAX_HEADERS: usize = 64;
const RTSP_MAX_BODY_BYTES: usize = 4096;
const RTSP_DISCARD_BUFFER_BYTES: usize = 1024;
const RTSP_MAX_INTERLEAVED_BYTES: usize = 4096;
const STREAM_ID_HEX_CHARS: usize = 32;
const STREAM_ID_BYTES: usize = STREAM_ID_HEX_CHARS / 2;
const STREAM_CODE_BYTES: usize = 32;
const STREAM_BLACKLIST_FILE: &str = "blacklist.txt";
const STREAM_BLACKLIST_RELOAD_INTERVAL: Duration = Duration::from_secs(60);
const MAX_STREAMER_IP_BANS: usize = 65_536;
const STREAMER_LISTENER_UPDATE_INTERVAL: Duration = Duration::from_secs(1);
const STREAMER_CONTROL_MESSAGES_PER_SECOND: usize = 8;
const RTCP_REPORT_INTERVAL: Duration = Duration::from_secs(5);
const DEFAULT_TOKEN_BUCKET_BURST_SECS: usize = 2;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[repr(u8)]
enum StreamMode {
    Audio = 1,
    Video = 2,
}

#[derive(Default)]
struct MediaCounts {
    audio: AtomicUsize,
    video: AtomicUsize,
}

impl MediaCounts {
    fn counter(&self, mode: StreamMode) -> &AtomicUsize {
        match mode {
            StreamMode::Audio => &self.audio,
            StreamMode::Video => &self.video,
        }
    }
}

struct AppState {
    config: Config,
    channels: StdRwLock<HashMap<String, Arc<Channel>>>,
    stream_blacklist: StdRwLock<HashSet<String>>,
    blocked_streamer_ips: StdRwLock<StreamerIpBans>,
    ip_limits: StdMutex<IpLimitTable>,
    active_connections: AtomicUsize,
    active_streamers: AtomicUsize,
    active_listeners: AtomicUsize,
    streams: MediaCounts,
    listeners: MediaCounts,
    next_rtsp_session: AtomicUsize,
    log_salt: [u8; 16],
}

#[derive(Default)]
struct StreamerIpBans {
    by_ip: HashMap<IpAddr, HashSet<String>>,
    associations: usize,
    overflowed_ids: HashSet<String>,
}

struct Channel {
    audio_tx: broadcast::Sender<AudioMessage>,
    video_tx: broadcast::Sender<VideoMessage>,
    streamer: AtomicBool,
    mode: AtomicU8,
    listeners: AtomicUsize,
    generation: AtomicUsize,
    blacklist_notify: Notify,
    video_fmtp: StdRwLock<Option<Arc<str>>>,
    configuration_changed: Notify,
}

impl Channel {
    fn new(buffer: usize) -> Self {
        let (audio_tx, _) = broadcast::channel(buffer);
        let (video_tx, _) = broadcast::channel(buffer);
        Self {
            audio_tx,
            video_tx,
            streamer: AtomicBool::new(false),
            mode: AtomicU8::new(0),
            listeners: AtomicUsize::new(0),
            generation: AtomicUsize::new(0),
            blacklist_notify: Notify::new(),
            video_fmtp: StdRwLock::new(None),
            configuration_changed: Notify::new(),
        }
    }

    fn mode(&self) -> Option<StreamMode> {
        match self.mode.load(Ordering::Acquire) {
            1 => Some(StreamMode::Audio),
            2 => Some(StreamMode::Video),
            _ => None,
        }
    }

    fn video_fmtp(&self) -> Option<Arc<str>> {
        self.video_fmtp
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn set_video_fmtp(&self, value: Option<Arc<str>>) {
        *self
            .video_fmtp
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = value;
        self.configuration_changed.notify_waiters();
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let _ = rustls::crypto::ring::default_provider().install_default();

    let config = Config::load()?;
    let log_filter =
        EnvFilter::try_new(&config.log_filter).unwrap_or_else(|_| EnvFilter::new("warn"));
    fmt().with_env_filter(log_filter).init();

    let bind_addr = config.bind_addr;
    let blacklist_path = PathBuf::from(STREAM_BLACKLIST_FILE);
    let stream_blacklist = match load_stream_blacklist(&blacklist_path) {
        Ok(entries) => entries,
        Err(error) => {
            warn!(path = %blacklist_path.display(), %error, "failed to load stream blacklist; starting with an empty list");
            HashSet::new()
        }
    };
    if !stream_blacklist.is_empty() {
        info!(
            path = %blacklist_path.display(),
            entries = stream_blacklist.len(),
            "stream blacklist loaded"
        );
    }
    let state = Arc::new(AppState {
        config,
        channels: StdRwLock::new(HashMap::new()),
        stream_blacklist: StdRwLock::new(stream_blacklist),
        blocked_streamer_ips: StdRwLock::new(StreamerIpBans::default()),
        ip_limits: StdMutex::new(IpLimitTable::new()),
        active_connections: AtomicUsize::new(0),
        active_streamers: AtomicUsize::new(0),
        active_listeners: AtomicUsize::new(0),
        streams: MediaCounts::default(),
        listeners: MediaCounts::default(),
        next_rtsp_session: AtomicUsize::new(1),
        log_salt: make_log_salt(),
    });
    install_panic_hook(state.clone());
    tokio::spawn(watch_stream_blacklist(state.clone(), blacklist_path));

    let app = http_router(state.clone());

    let rtsp_listener = match TcpListener::bind(state.config.rtsp_bind_addr).await {
        Ok(listener) => listener,
        Err(error) => {
            log_fatal_error(&state, &error);
            return Err(error.into());
        }
    };
    let mut rtsp_task = tokio::spawn(rtsp_server(state.clone(), rtsp_listener));

    let handle = axum_server::Handle::new();
    tokio::spawn(shutdown_http_server(handle.clone()));

    let tls_cert_path = state.config.tls_cert_path.clone();
    let tls_key_path = state.config.tls_key_path.clone();
    let service = app.into_make_service_with_connect_info::<SocketAddr>();

    let http_server = async {
        let mut server = axum_server::bind(bind_addr).handle(handle);
        server
            .http_builder()
            .http1()
            .timer(TokioTimer::new())
            .header_read_timeout(Duration::from_secs(10));
        if let (Some(cert_path), Some(key_path)) = (tls_cert_path, tls_key_path) {
            let tls_config = RustlsConfig::from_pem_file(cert_path, key_path).await?;
            info!(port = bind_addr.port(), "listening on https");
            server
                .acceptor(RustlsAcceptor::new(tls_config))
                .serve(service)
                .await?;
        } else {
            info!(port = bind_addr.port(), "listening on http");
            server.serve(service).await?;
        }

        Ok::<(), Box<dyn std::error::Error>>(())
    };

    let result = tokio::select! {
        result = http_server => result,
        result = &mut rtsp_task => match result {
            Ok(()) => Err("rtsp server stopped unexpectedly".into()),
            Err(error) => Err(error.into()),
        },
    };
    rtsp_task.abort();

    if let Err(error) = result {
        log_fatal_error(&state, error.as_ref());
        return Err(error);
    }

    Ok(())
}

fn load_stream_blacklist(path: &Path) -> Result<HashSet<String>, String> {
    match fs::read_to_string(path) {
        Ok(contents) => parse_stream_blacklist(&contents),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(HashSet::new()),
        Err(error) => Err(error.to_string()),
    }
}

fn parse_stream_blacklist(contents: &str) -> Result<HashSet<String>, String> {
    let mut entries = HashSet::new();
    for (index, entry) in contents
        .split(|character: char| character == ';' || character.is_whitespace())
        .filter(|entry| !entry.is_empty())
        .enumerate()
    {
        let entry = entry.trim_start_matches('\u{feff}');
        if !valid_hash(entry) {
            return Err(format!(
                "blacklist entry {} is not a 32-character hexadecimal stream ID",
                index + 1
            ));
        }
        entries.insert(entry.to_ascii_lowercase());
    }
    Ok(entries)
}

fn streamer_ip_is_blocked(state: &AppState, ip: IpAddr) -> bool {
    let blocked = state
        .blocked_streamer_ips
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    // Unknown IPs from an overflowed ID stay blocked until that ID is removed.
    blocked.by_ip.contains_key(&ip) || !blocked.overflowed_ids.is_empty()
}

fn block_streamer_ip_if_blacklisted(state: &AppState, key: &str, ip: IpAddr) -> bool {
    // Keep the ID read lock until the IP ban is recorded, matching reload's lock order.
    let blacklist = state
        .stream_blacklist
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !blacklist.contains(key) {
        return false;
    }
    let mut blocked = state
        .blocked_streamer_ips
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if blocked.by_ip.get(&ip).is_some_and(|ids| ids.contains(key)) {
        return true;
    }
    if blocked.associations < MAX_STREAMER_IP_BANS {
        blocked.by_ip.entry(ip).or_default().insert(key.to_owned());
        blocked.associations += 1;
    } else if !blocked.overflowed_ids.contains(key) {
        blocked.overflowed_ids.insert(key.to_owned());
        warn!(
            "streamer IP ban table full; new streams blocked until overflowed IDs are removed or the server restarts"
        );
    }
    true
}

fn replace_stream_blacklist(state: &AppState, entries: HashSet<String>) -> Option<(usize, usize)> {
    let entry_count = entries.len();
    {
        let mut current = state
            .stream_blacklist
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if *current == entries {
            return None;
        }
        let mut blocked = state
            .blocked_streamer_ips
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut associations = 0;
        blocked.by_ip.retain(|_, stream_ids| {
            stream_ids.retain(|key| entries.contains(key));
            if stream_ids.is_empty() {
                return false;
            }
            stream_ids.shrink_to_fit();
            associations += stream_ids.len();
            true
        });
        blocked.associations = associations;
        blocked.overflowed_ids.retain(|key| entries.contains(key));
        *current = entries;
    }

    let kicked = notify_blacklisted_streamers(state);
    Some((entry_count, kicked))
}

fn notify_blacklisted_streamers(state: &AppState) -> usize {
    let blacklist = state
        .stream_blacklist
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let channels = state
        .channels
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut kicked = 0usize;
    for key in blacklist.iter() {
        if let Some(channel) = channels.get(key)
            && channel.streamer.load(Ordering::Acquire)
        {
            channel.blacklist_notify.notify_one();
            kicked = kicked.saturating_add(1);
        }
    }
    kicked
}

async fn watch_stream_blacklist(state: Arc<AppState>, path: PathBuf) {
    loop {
        tokio::time::sleep(STREAM_BLACKLIST_RELOAD_INTERVAL).await;
        match load_stream_blacklist(&path) {
            Ok(entries) => {
                if let Some((entries, kicked)) = replace_stream_blacklist(&state, entries) {
                    info!(path = %path.display(), entries, kicked, "stream blacklist reloaded");
                }
            }
            Err(error) => {
                warn!(path = %path.display(), %error, "failed to reload stream blacklist; keeping the previous list");
            }
        }
    }
}

fn http_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/status", get(status))
        .route("/info", get(server_info))
        .route("/stream", get(stream_ws))
        .fallback(redirect)
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            rate_limit_http,
        ))
        .with_state(state)
}

async fn rate_limit_http(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    if !allow_http_request(&state, addr.ip()) {
        return text_response_with_cors(
            StatusCode::TOO_MANY_REQUESTS,
            "too many requests\n",
            request.headers(),
            &state.config,
        );
    }
    next.run(request).await
}

async fn redirect(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let mut response = StatusCode::FOUND.into_response();
    response
        .headers_mut()
        .insert(LOCATION, state.config.redirect_url.clone());
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    apply_http_cors(response.headers_mut(), &headers, &state.config);
    response
}

async fn status(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let mut response = ([(CONTENT_TYPE, "text/plain; charset=utf-8")], "ok\n").into_response();
    apply_http_cors(response.headers_mut(), &headers, &state.config);
    response
}

#[derive(Serialize)]
struct ServerInfo<'a> {
    name: &'a str,
    description: &'a str,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    official_public: bool,
    rtsp_base: String,
    video: bool,
    video_qualities: &'a [VideoQuality],
    audio_streams: usize,
    video_streams: usize,
    audio_listeners: usize,
    video_listeners: usize,
}

async fn server_info(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let video_qualities = if state.config.video_enabled {
        state.config.video_qualities.as_slice()
    } else {
        &[]
    };

    let mut response = axum::Json(ServerInfo {
        name: &state.config.server_name,
        description: &state.config.server_description,
        official_public: state.config.official_public,
        rtsp_base: public_rtsp_base(&state.config, &headers),
        video: state.config.video_enabled,
        video_qualities,
        audio_streams: state.streams.audio.load(Ordering::Acquire),
        video_streams: state.streams.video.load(Ordering::Acquire),
        audio_listeners: state.listeners.audio.load(Ordering::Acquire),
        video_listeners: state.listeners.video.load(Ordering::Acquire),
    })
    .into_response();
    let response_headers = response.headers_mut();
    response_headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    apply_http_cors(response_headers, &headers, &state.config);
    response
}

fn advance_stream_generation(channel: &Channel) -> usize {
    // Do not reuse a DESCRIBE generation when an idle channel is removed and recreated.
    static NEXT_GENERATION: AtomicUsize = AtomicUsize::new(1);
    let generation = NEXT_GENERATION.fetch_add(1, Ordering::Relaxed);
    channel.generation.store(generation, Ordering::Release);
    generation
}

fn wake_media_listeners(channel: &Channel) {
    let _ = channel.audio_tx.send(AudioMessage::Wake);
    let _ = channel.video_tx.send(VideoMessage::Wake);
}

fn reserve_channel<T>(
    state: &AppState,
    key: &str,
    reserve: impl FnOnce(&Channel) -> T,
) -> (Arc<Channel>, T) {
    // Keep the channel mapped until the caller's atomic reservation is complete.
    let channels = state
        .channels
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(channel) = channels.get(key) {
        let result = reserve(channel);
        return (channel.clone(), result);
    }
    drop(channels);

    let mut channels = state
        .channels
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let channel = channels
        .entry(key.to_owned())
        .or_insert_with(|| Arc::new(Channel::new(state.config.channel_buffer)));
    let result = reserve(channel);
    (channel.clone(), result)
}

fn cleanup_channel(state: &AppState, key: &str, channel: &Arc<Channel>) {
    if channel.streamer.load(Ordering::Acquire) || channel.listeners.load(Ordering::Acquire) != 0 {
        return;
    }

    let mut channels = state
        .channels
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
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
        let active_streams = state.active_streamers.load(Ordering::Acquire);
        let active_listeners = state.active_listeners.load(Ordering::Acquire);

        error!(
            %message,
            %location,
            active_streams,
            active_listeners,
            "server panicked"
        );
    }));
}

fn log_fatal_error(state: &AppState, error: &dyn std::error::Error) {
    let active_streams = state.active_streamers.load(Ordering::Acquire);
    let active_listeners = state.active_listeners.load(Ordering::Acquire);

    error!(
        %error,
        active_streams,
        active_listeners,
        "server stopped after fatal error"
    );
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
        config.max_h264_frame_bytes
    } else {
        AAC_MAX_ACCESS_UNIT_BYTES
    };
    media_bytes.saturating_add(MEDIA_FRAME_HEADER_BYTES)
}

fn limit_allows(limit: usize, current: usize) -> bool {
    limit == 0 || current < limit
}

fn valid_hash(key: &str) -> bool {
    key.len() == STREAM_ID_HEX_CHARS && key.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[derive(Clone, Copy)]
struct StreamIdForLog<'a>(&'a str);

fn stream_id_for_log(key: &str) -> StreamIdForLog<'_> {
    StreamIdForLog(key)
}

impl std::fmt::Display for StreamIdForLog<'_> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if !valid_hash(self.0) {
            return formatter.write_str("[invalid]");
        }
        write!(formatter, "...{}", &self.0[STREAM_ID_HEX_CHARS - 4..])
    }
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
    hasher.update(b"VRCast peer log id v1");
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

fn hex_char(nibble: u8) -> char {
    match nibble {
        0..=9 => (b'0' + nibble) as char,
        10..=15 => (b'a' + (nibble - 10)) as char,
        _ => unreachable!(),
    }
}

fn origin_allowed(headers: &HeaderMap, config: &Config) -> bool {
    !headers.contains_key(ORIGIN) || cors_origin(headers, config).is_some()
}

fn apply_http_cors(response: &mut HeaderMap, request: &HeaderMap, config: &Config) {
    let Some(origin) = cors_origin(request, config) else {
        return;
    };

    response.insert(ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    response.insert(VARY, HeaderValue::from_static("Origin"));
}

fn cors_origin(headers: &HeaderMap, config: &Config) -> Option<HeaderValue> {
    if config.allowed_origins.iter().any(|origin| origin == "*") {
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

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                let _ = signal.recv().await;
            }
            Err(error) => {
                error!(%error, "failed to install SIGTERM handler");
                std::future::pending::<()>().await;
            }
        }
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
