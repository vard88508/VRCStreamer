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
    io::ErrorKind,
    net::{IpAddr, SocketAddr},
    sync::{
        Arc, Mutex as StdMutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, tcp::OwnedWriteHalf},
    sync::{Mutex, broadcast},
    task::JoinHandle,
    time::{Instant as TokioInstant, sleep_until, timeout},
};
use tracing::{info, warn};
use tracing_subscriber::{EnvFilter, fmt};

const RTP_AUDIO_PAYLOAD_TYPE: u8 = 96;
const RTP_AUDIO_SSRC: u32 = 0x5652_4341;
const AAC_SAMPLE_RATE: u32 = 48_000;
const AAC_CHANNELS: u8 = 2;
const AAC_SAMPLES_PER_FRAME: u32 = 1024;
const AAC_AUDIO_SPECIFIC_CONFIG: &str = "1190";
const AAC_SILENCE_ACCESS_UNIT: &[u8] = &[0x21, 0x10, 0x04, 0x60, 0x8c, 0x1c];
const AAC_FRAME_DURATION: Duration =
    Duration::from_micros((AAC_SAMPLES_PER_FRAME as u64 * 1_000_000) / AAC_SAMPLE_RATE as u64);
const AAC_MAX_ACCESS_UNIT_BYTES: usize = 4 * 1024;
const RTSP_PREBUFFER_FRAMES: usize = 12;
const RTSP_MAX_BUFFER_FRAMES: usize = 96;
const RTSP_LOW_WATER_FRAMES: usize = 4;
const RTSP_MAX_LINE_BYTES: usize = 4096;
const RTSP_MAX_HEADERS: usize = 64;
const RTSP_MAX_BODY_BYTES: usize = 4096;
const STREAM_ID_HEX_CHARS: usize = 32;
const STREAM_ID_BYTES: usize = STREAM_ID_HEX_CHARS / 2;

type SharedRtspWriter = Arc<Mutex<OwnedWriteHalf>>;

#[derive(Clone)]
struct Config {
    bind_addr: SocketAddr,
    rtsp_bind_addr: SocketAddr,
    rtsp_extra_bind_addr: Option<SocketAddr>,
    tls_cert_path: Option<String>,
    tls_key_path: Option<String>,
    code_min_bytes: usize,
    code_max_bytes: usize,
    max_publishers: usize,
    max_publishers_per_ip: usize,
    max_listeners_total: usize,
    max_listeners_per_stream: usize,
    max_http_requests_per_ip: usize,
    http_rate_limit_window: Duration,
    max_tracked_ips: usize,
    max_aac_frame_bytes: usize,
    max_ingest_bytes_per_sec: usize,
    channel_buffer: usize,
    publisher_idle_timeout: Duration,
    allow_any_origin: bool,
    allowed_origins: Vec<String>,
}

struct AppState {
    config: Config,
    channels: Mutex<HashMap<String, Arc<Channel>>>,
    ip_limits: StdMutex<HashMap<IpAddr, IpLimitEntry>>,
    active_publishers: AtomicUsize,
    active_listeners: AtomicUsize,
    next_rtsp_session: AtomicUsize,
}

struct Channel {
    tx: broadcast::Sender<Bytes>,
    publisher: AtomicBool,
    listeners: AtomicUsize,
}

impl Channel {
    fn new(buffer: usize) -> Self {
        let (tx, _) = broadcast::channel(buffer);
        Self {
            tx,
            publisher: AtomicBool::new(false),
            listeners: AtomicUsize::new(0),
        }
    }
}

struct IpLimitEntry {
    window_started: Instant,
    request_count: usize,
    publishers: usize,
    last_seen: Instant,
}

impl IpLimitEntry {
    fn new(now: Instant) -> Self {
        Self {
            window_started: now,
            request_count: 0,
            publishers: 0,
            last_seen: now,
        }
    }
}

#[derive(Deserialize)]
struct IngestQuery {
    code: String,
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let _ = rustls::crypto::ring::default_provider().install_default();

    fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("info".parse()?))
        .init();

    let config = Config::from_env()?;
    let bind_addr = config.bind_addr;
    let state = Arc::new(AppState {
        config,
        channels: Mutex::new(HashMap::new()),
        ip_limits: StdMutex::new(HashMap::new()),
        active_publishers: AtomicUsize::new(0),
        active_listeners: AtomicUsize::new(0),
        next_rtsp_session: AtomicUsize::new(1),
    });

    let app = Router::new()
        .route("/healthz", get(healthz))
        .route("/stats", get(stats))
        .route("/ingest", get(ingest_ws))
        .with_state(state.clone());

    tokio::spawn(rtsp_server(state.clone(), state.config.rtsp_bind_addr));
    if let Some(addr) = state.config.rtsp_extra_bind_addr {
        tokio::spawn(rtsp_server(state.clone(), addr));
    }

    let handle = axum_server::Handle::new();
    tokio::spawn(shutdown_http_server(handle.clone()));

    let tls_cert_path = state.config.tls_cert_path.clone();
    let tls_key_path = state.config.tls_key_path.clone();
    let service = app.into_make_service_with_connect_info::<SocketAddr>();

    if let (Some(cert_path), Some(key_path)) = (tls_cert_path, tls_key_path) {
        let tls_config = RustlsConfig::from_pem_file(cert_path, key_path).await?;
        info!("listening on https://{bind_addr}");
        axum_server::tls_rustls::bind_rustls(bind_addr, tls_config)
            .handle(handle)
            .serve(service)
            .await?;
    } else {
        info!("listening on http://{bind_addr}");
        axum_server::bind(bind_addr)
            .handle(handle)
            .serve(service)
            .await?;
    }

    Ok(())
}

impl Config {
    fn from_env() -> Result<Self, Box<dyn std::error::Error>> {
        let bind_addr = env::var("BIND_ADDR")
            .unwrap_or_else(|_| "0.0.0.0:8080".to_owned())
            .parse()?;
        let rtsp_bind_addr: SocketAddr = env::var("RTSP_BIND_ADDR")
            .unwrap_or_else(|_| "0.0.0.0:8554".to_owned())
            .parse()?;
        let rtsp_extra_bind_addr = env::var("RTSP_EXTRA_BIND_ADDR")
            .ok()
            .filter(|value| !value.is_empty())
            .map(|value| value.parse())
            .transpose()?;
        let tls_cert_path = env_nonempty("TLS_CERT_PATH");
        let tls_key_path = env_nonempty("TLS_KEY_PATH");
        if tls_cert_path.is_some() != tls_key_path.is_some() {
            return Err("TLS_CERT_PATH and TLS_KEY_PATH must be set together".into());
        }

        Ok(Self {
            bind_addr,
            rtsp_bind_addr,
            rtsp_extra_bind_addr,
            tls_cert_path,
            tls_key_path,
            code_min_bytes: env_usize("CODE_MIN_BYTES", 8),
            code_max_bytes: env_usize("CODE_MAX_BYTES", 128),
            max_publishers: env_usize("MAX_PUBLISHERS", 500),
            max_publishers_per_ip: env_usize("MAX_PUBLISHERS_PER_IP", 3),
            max_listeners_total: env_usize("MAX_LISTENERS_TOTAL", 2500),
            max_listeners_per_stream: env_usize("MAX_LISTENERS_PER_STREAM", 85),
            max_http_requests_per_ip: env_usize("MAX_HTTP_REQUESTS_PER_IP", 120),
            http_rate_limit_window: Duration::from_secs(
                env_u64("HTTP_RATE_LIMIT_WINDOW_SECS", 60).max(1),
            ),
            max_tracked_ips: env_usize("MAX_TRACKED_IPS", 8192),
            max_aac_frame_bytes: env_usize("MAX_AAC_FRAME_BYTES", AAC_MAX_ACCESS_UNIT_BYTES),
            max_ingest_bytes_per_sec: env_usize("MAX_INGEST_BYTES_PER_SEC", 96 * 1024),
            channel_buffer: env_usize("CHANNEL_BUFFER", 128),
            publisher_idle_timeout: Duration::from_secs(env_u64(
                "PUBLISHER_IDLE_TIMEOUT_SECS",
                120,
            )),
            allow_any_origin: env_bool("ALLOW_ANY_ORIGIN", false),
            allowed_origins: env::var("ALLOWED_ORIGINS")
                .unwrap_or_default()
                .split(',')
                .map(str::trim)
                .filter(|origin| !origin.is_empty())
                .map(str::to_owned)
                .collect(),
        })
    }
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
struct StatsResponse {
    active_listeners: usize,
    active_streams: usize,
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
        channels.len()
    };

    let mut response = axum::Json(StatsResponse {
        active_listeners: state.active_listeners.load(Ordering::Acquire),
        active_streams,
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
    if !allow_http_request(&state, addr.ip()) {
        warn!(%addr, "rejected publisher over http request rate limit");
        return text_response_with_cors(
            StatusCode::TOO_MANY_REQUESTS,
            "too many requests\n",
            &headers,
            &state.config,
        );
    }

    if !origin_allowed(&headers, &state.config) {
        warn!(%addr, "rejected publisher with invalid origin");
        return text_response(StatusCode::FORBIDDEN, "origin is not allowed\n");
    }

    if let Err(reason) = validate_code(&query.code, &state.config) {
        return text_response(StatusCode::BAD_REQUEST, reason);
    }

    let key = hash_code(&query.code);
    let channel = get_or_create_channel(&state, &key).await;
    if channel
        .publisher
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return text_response(
            StatusCode::CONFLICT,
            "stream already has an active publisher\n",
        );
    }

    let ip_guard = match try_acquire_publisher_ip(&state, addr.ip()) {
        Ok(guard) => guard,
        Err(reason) => {
            channel.publisher.store(false, Ordering::Release);
            cleanup_channel(&state, &key, &channel).await;
            return text_response(StatusCode::TOO_MANY_REQUESTS, reason);
        }
    };

    if state
        .active_publishers
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
            (current < state.config.max_publishers).then_some(current + 1)
        })
        .is_err()
    {
        channel.publisher.store(false, Ordering::Release);
        cleanup_channel(&state, &key, &channel).await;
        return text_response(
            StatusCode::TOO_MANY_REQUESTS,
            "too many active publishers\n",
        );
    }

    info!(%addr, %key, "aac publisher connected");
    ws.max_message_size(state.config.max_aac_frame_bytes + 1024)
        .on_upgrade(move |socket| publisher_session(socket, state, key, channel, addr, ip_guard))
        .into_response()
}

async fn publisher_session(
    mut socket: WebSocket,
    state: Arc<AppState>,
    key: String,
    channel: Arc<Channel>,
    addr: SocketAddr,
    _ip_guard: Option<PublisherIpGuard>,
) {
    let mut rate = RateWindow::new(Duration::from_secs(5));
    let mut frames = 0usize;
    let mut bytes = 0usize;
    let started_at = Instant::now();
    let mut last_report = Instant::now();

    loop {
        let message = match timeout(state.config.publisher_idle_timeout, socket.recv()).await {
            Ok(Some(Ok(message))) => message,
            Ok(Some(Err(error))) => {
                warn!(%addr, %key, %error, "publisher websocket error");
                break;
            }
            Ok(None) => break,
            Err(_) => {
                warn!(%addr, %key, "publisher idle timeout");
                let _ = socket.send(Message::Close(None)).await;
                break;
            }
        };

        match message {
            Message::Binary(frame) => {
                if frame.len() > state.config.max_aac_frame_bytes {
                    warn!(%addr, %key, len = frame.len(), "aac frame too large");
                    let _ = socket.send(Message::Close(None)).await;
                    break;
                }
                if !rate.allow(frame.len(), state.config.max_ingest_bytes_per_sec) {
                    warn!(%addr, %key, "publisher exceeded aac ingest rate");
                    let _ = socket.send(Message::Close(None)).await;
                    break;
                }
                if let Err(reason) = validate_aac_access_unit(&frame) {
                    warn!(%addr, %key, %reason, "publisher sent invalid aac");
                    let _ = socket.send(Message::Close(None)).await;
                    break;
                }

                let frame_len = frame.len();
                let _ = channel.tx.send(frame);
                frames += 1;
                bytes = bytes.saturating_add(frame_len);
                if frames == 1 {
                    info!(%addr, %key, "publisher sent first aac frame");
                }
                if frames % 250 == 0 || last_report.elapsed() >= Duration::from_secs(5) {
                    let elapsed = started_at.elapsed().as_secs_f64().max(0.001);
                    info!(
                        %addr,
                        %key,
                        frames,
                        bytes,
                        fps = frames as f64 / elapsed,
                        kbps = (bytes as f64 * 8.0 / 1000.0) / elapsed,
                        "aac publisher rate"
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
            Message::Text(_) => {
                warn!(%addr, %key, "publisher sent text message");
                let _ = socket.send(Message::Close(None)).await;
                break;
            }
        }
    }

    finish_publisher(&state, &key, &channel, addr, frames).await;
}

async fn finish_publisher(
    state: &Arc<AppState>,
    key: &str,
    channel: &Arc<Channel>,
    addr: SocketAddr,
    frames: usize,
) {
    let _ = channel.tx.send(Bytes::new());
    channel.publisher.store(false, Ordering::Release);
    state.active_publishers.fetch_sub(1, Ordering::AcqRel);
    cleanup_channel(state, key, channel).await;
    info!(%addr, %key, frames, "aac publisher disconnected");
}

async fn rtsp_server(state: Arc<AppState>, bind_addr: SocketAddr) {
    let listener = match TcpListener::bind(bind_addr).await {
        Ok(listener) => listener,
        Err(error) => {
            warn!(%error, %bind_addr, "failed to bind rtsp listener");
            return;
        }
    };

    info!("listening on rtsp://{bind_addr}");

    loop {
        match listener.accept().await {
            Ok((stream, addr)) => {
                let state = state.clone();
                tokio::spawn(async move {
                    if let Err(error) = handle_rtsp_client(stream, addr, state).await {
                        warn!(%addr, %error, "rtsp client error");
                    }
                });
            }
            Err(error) => warn!(%error, "rtsp accept error"),
        }
    }
}

async fn handle_rtsp_client(
    stream: tokio::net::TcpStream,
    addr: SocketAddr,
    state: Arc<AppState>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    stream.set_nodelay(true)?;
    let (read_half, write_half) = stream.into_split();
    let writer = Arc::new(Mutex::new(write_half));
    let mut reader = BufReader::new(read_half);
    let mut session = RtspSession::default();

    loop {
        let Some(request) = read_rtsp_request(&mut reader).await? else {
            break;
        };
        if handle_rtsp_request(&request, &writer, &state, &mut session, addr).await? {
            break;
        }
    }

    session.stop();
    info!(%addr, "rtsp client disconnected");
    Ok(())
}

async fn handle_rtsp_request(
    request: &RtspRequest,
    writer: &SharedRtspWriter,
    state: &Arc<AppState>,
    session: &mut RtspSession,
    addr: SocketAddr,
) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
    let cseq = request.header("cseq").unwrap_or("0");
    info!(%addr, method = %request.method, uri = %request.uri, "rtsp request");

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

            if session.rx.is_none() {
                match subscribe_listener(state, &key).await {
                    Ok((rx, guard)) => {
                        session.rx = Some(rx);
                        session.guard = Some(guard);
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

            let rtp_channel = parse_interleaved_channel(transport).unwrap_or(0);
            session.key = Some(key.clone());
            session.audio_setup = true;
            session.audio_channel = rtp_channel;

            let transport_header = format!(
                "RTP/AVP/TCP;unicast;interleaved={rtp_channel}-{};ssrc={RTP_AUDIO_SSRC:08X}",
                rtp_channel + 1
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
            info!(%addr, %key, rtp_channel, "rtsp audio setup");
        }
        "PLAY" => {
            if !session.audio_setup {
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

            let start_rtp = if session.rtp_task.is_none() {
                let Some(rx) = session.rx.take() else {
                    write_rtsp_response(writer, "454 Session Not Found", cseq, &[], None).await?;
                    return Ok(false);
                };
                let Some(guard) = session.guard.take() else {
                    write_rtsp_response(writer, "454 Session Not Found", cseq, &[], None).await?;
                    return Ok(false);
                };
                let key = session.key.clone().unwrap_or_default();
                let rtp = session.rtp;
                let channel = session.audio_channel;
                Some((rx, guard, key, channel, rtp))
            } else {
                None
            };

            let rtp_info = format!(
                "url={}/trackID=0;seq={};rtptime={}",
                rtsp_content_base(&request.uri).trim_end_matches('/'),
                session.rtp.sequence,
                session.rtp.timestamp
            );
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

            if let Some((rx, guard, key, channel, rtp)) = start_rtp {
                session.rtp_task = Some(tokio::spawn(rtsp_rtp_task(
                    writer.clone(),
                    rx,
                    guard,
                    key,
                    addr,
                    channel,
                    rtp,
                )));
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
) -> Result<(broadcast::Receiver<Bytes>, ListenerGuard), &'static str> {
    let channel = {
        let channels = state.channels.lock().await;
        match channels.get(key) {
            Some(channel) if channel.publisher.load(Ordering::Acquire) => channel.clone(),
            _ => return Err("404 Not Found"),
        }
    };

    if state
        .active_listeners
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
            (current < state.config.max_listeners_total).then_some(current + 1)
        })
        .is_err()
    {
        return Err("453 Not Enough Bandwidth");
    }

    if channel
        .listeners
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
            (current < state.config.max_listeners_per_stream).then_some(current + 1)
        })
        .is_err()
    {
        state.active_listeners.fetch_sub(1, Ordering::AcqRel);
        return Err("453 Not Enough Bandwidth");
    }

    let rx = channel.tx.subscribe();
    let guard = ListenerGuard {
        state: state.clone(),
        key: key.to_owned(),
        channel,
        released: false,
    };
    Ok((rx, guard))
}

async fn rtsp_rtp_task(
    writer: SharedRtspWriter,
    mut rx: broadcast::Receiver<Bytes>,
    _guard: ListenerGuard,
    key: String,
    addr: SocketAddr,
    channel: u8,
    mut rtp: RtpState,
) {
    let mut buffer = VecDeque::<Bytes>::new();
    let mut ended = false;
    let mut started = false;
    let mut next_send_at = TokioInstant::now();
    let mut sleep = Box::pin(sleep_until(next_send_at));
    let mut packets = 0usize;
    let mut underruns = 0usize;
    let mut silence_packets = 0usize;
    let mut dropped = 0usize;
    let mut sender = RtpPacketWriter::new(channel);

    loop {
        if !started && !buffer.is_empty() && (buffer.len() >= RTSP_PREBUFFER_FRAMES || ended) {
            started = true;
            next_send_at = TokioInstant::now();
            sleep.as_mut().reset(next_send_at);
            info!(%addr, %key, buffered_frames = buffer.len(), "rtsp rtp prebuffer ready");
        }

        if ended && buffer.is_empty() {
            break;
        }

        tokio::select! {
            frame = rx.recv(), if !ended => {
                match frame {
                    Ok(frame) if frame.is_empty() => ended = true,
                    Ok(frame) => {
                        buffer.push_back(frame);
                        while buffer.len() > RTSP_MAX_BUFFER_FRAMES {
                            buffer.pop_front();
                            rtp.skip_samples(AAC_SAMPLES_PER_FRAME);
                            dropped += 1;
                        }
                        if dropped != 0 && dropped % 50 == 0 {
                            warn!(%addr, %key, dropped, "rtsp client dropped queued aac frames to keep latency bounded");
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        rtp.skip_samples(AAC_SAMPLES_PER_FRAME.saturating_mul(skipped as u32));
                        dropped = dropped.saturating_add(skipped as usize);
                        warn!(%addr, %key, skipped, "rtsp client lagged behind publisher");
                    }
                    Err(broadcast::error::RecvError::Closed) => ended = true,
                }
            }
            _ = &mut sleep, if started => {
                let frame = if let Some(frame) = buffer.pop_front() {
                    if buffer.len() < RTSP_LOW_WATER_FRAMES && packets % 50 == 0 {
                        warn!(
                            %addr,
                            %key,
                            queued_frames = buffer.len(),
                            "rtsp rtp buffer low"
                        );
                    }
                    frame
                } else {
                    underruns += 1;
                    silence_packets += 1;
                    if underruns <= 5 || underruns % 50 == 0 {
                        warn!(%addr, %key, underruns, "rtsp rtp underrun; sending aac silence");
                    }
                    Bytes::from_static(AAC_SILENCE_ACCESS_UNIT)
                };

                if let Err(error) = sender.send_aac(&writer, &frame, &mut rtp).await {
                    warn!(%addr, %key, %error, "rtsp rtp writer failed");
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

    info!(%addr, %key, packets, underruns, silence_packets, dropped, "rtsp rtp ended");
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
            let mut discard = vec![0u8; len];
            reader.read_exact(&mut discard).await?;
            continue;
        }

        if first == b'\r' || first == b'\n' {
            continue;
        }

        let mut first_line = vec![first];
        reader.read_until(b'\n', &mut first_line).await?;
        if first_line.len() > RTSP_MAX_LINE_BYTES {
            return Err("rtsp request line too long".into());
        }
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
            let bytes = reader.read_until(b'\n', &mut line).await?;
            if bytes == 0 || line == b"\r\n" || line == b"\n" {
                break;
            }
            if line.len() > RTSP_MAX_LINE_BYTES {
                return Err("rtsp header line too long".into());
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
            let mut discard = vec![0u8; content_length];
            reader.read_exact(&mut discard).await?;
        }

        return Ok(Some(RtspRequest {
            method: method.to_ascii_uppercase(),
            uri: uri.to_owned(),
            _version: version,
            headers,
        }));
    }
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
        "RTSP/1.0 {status}\r\nCSeq: {cseq}\r\nServer: vrc-audio-streamer\r\nCache-Control: no-cache\r\n"
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
         a=fmtp:{RTP_AUDIO_PAYLOAD_TYPE} config={AAC_AUDIO_SPECIFIC_CONFIG}; indexdeltalength=3; indexlength=3; mode=AAC-hbr; profile-level-id=1; sizelength=13; streamtype=5\r\n"
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

fn parse_interleaved_channel(transport: &str) -> Option<u8> {
    let lower = transport.to_ascii_lowercase();
    let value = lower.split("interleaved=").nth(1)?;
    value.split(['-', ';']).next()?.trim().parse().ok()
}

#[derive(Default)]
struct RtspSession {
    id: Option<String>,
    key: Option<String>,
    rx: Option<broadcast::Receiver<Bytes>>,
    guard: Option<ListenerGuard>,
    rtp_task: Option<JoinHandle<()>>,
    audio_setup: bool,
    audio_channel: u8,
    rtp: RtpState,
}

impl RtspSession {
    fn stop(&mut self) {
        if let Some(task) = self.rtp_task.take() {
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
    if channel.publisher.load(Ordering::Acquire) || channel.listeners.load(Ordering::Acquire) != 0 {
        return;
    }

    let mut channels = state.channels.lock().await;
    if let Some(current) = channels.get(key)
        && Arc::ptr_eq(current, channel)
        && !current.publisher.load(Ordering::Acquire)
        && current.listeners.load(Ordering::Acquire) == 0
    {
        channels.remove(key);
    }
}

struct ListenerGuard {
    state: Arc<AppState>,
    key: String,
    channel: Arc<Channel>,
    released: bool,
}

impl Drop for ListenerGuard {
    fn drop(&mut self) {
        if self.released {
            return;
        }
        self.released = true;
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

fn rejected_media_signature(frame: &[u8]) -> Option<&'static str> {
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
    if frame.starts_with(&[0x00, 0x00, 0x01]) || frame.starts_with(&[0x00, 0x00, 0x00, 0x01]) {
        return Some("video codecs are not accepted");
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

fn try_acquire_publisher_ip(
    state: &Arc<AppState>,
    ip: IpAddr,
) -> Result<Option<PublisherIpGuard>, &'static str> {
    if state.config.max_publishers_per_ip == 0 {
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
    if entry.publishers >= state.config.max_publishers_per_ip {
        return Err("too many active publishers from this IP\n");
    }

    entry.publishers += 1;
    Ok(Some(PublisherIpGuard {
        state: state.clone(),
        ip,
        released: false,
    }))
}

fn prune_ip_limits(limits: &mut HashMap<IpAddr, IpLimitEntry>, now: Instant, config: &Config) {
    let idle_timeout = config.http_rate_limit_window.saturating_mul(2);
    limits.retain(|_, entry| {
        entry.publishers != 0 || now.duration_since(entry.last_seen) < idle_timeout
    });
}

struct PublisherIpGuard {
    state: Arc<AppState>,
    ip: IpAddr,
    released: bool,
}

impl Drop for PublisherIpGuard {
    fn drop(&mut self) {
        if self.released {
            return;
        }
        self.released = true;

        let mut limits = self
            .state
            .ip_limits
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(entry) = limits.get_mut(&self.ip) {
            entry.publishers = entry.publishers.saturating_sub(1);
            entry.last_seen = Instant::now();
        }
    }
}

fn validate_code(code: &str, config: &Config) -> Result<(), &'static str> {
    let len = code.len();
    if len < config.code_min_bytes {
        return Err("code is too short\n");
    }
    if len > config.code_max_bytes {
        return Err("code is too long\n");
    }
    if !code.bytes().all(|byte| (0x21..=0x7e).contains(&byte)) {
        return Err("code may contain only printable ascii characters without spaces\n");
    }
    Ok(())
}

fn valid_hash(key: &str) -> bool {
    key.len() == STREAM_ID_HEX_CHARS && key.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn hash_code(code: &str) -> String {
    let digest = Sha256::digest(code.as_bytes());
    let mut out = String::with_capacity(STREAM_ID_HEX_CHARS);
    for &byte in digest.iter().take(STREAM_ID_BYTES) {
        out.push(hex_char(byte >> 4));
        out.push(hex_char(byte & 0x0f));
    }
    out
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
    env::var(key)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
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

fn env_nonempty(key: &str) -> Option<String> {
    env::var(key).ok().filter(|value| !value.is_empty())
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
            bind_addr: "127.0.0.1:8080".parse().unwrap(),
            rtsp_bind_addr: "127.0.0.1:8554".parse().unwrap(),
            rtsp_extra_bind_addr: None,
            tls_cert_path: None,
            tls_key_path: None,
            code_min_bytes: 8,
            code_max_bytes: 128,
            max_publishers: 1,
            max_publishers_per_ip: 3,
            max_listeners_total: 1,
            max_listeners_per_stream: 1,
            max_http_requests_per_ip: 120,
            http_rate_limit_window: Duration::from_secs(60),
            max_tracked_ips: 16,
            max_aac_frame_bytes: AAC_MAX_ACCESS_UNIT_BYTES,
            max_ingest_bytes_per_sec: 128 * 1024,
            channel_buffer: 8,
            publisher_idle_timeout: Duration::from_secs(1),
            allow_any_origin: false,
            allowed_origins: Vec::new(),
        }
    }

    fn test_state(config: Config) -> Arc<AppState> {
        Arc::new(AppState {
            config,
            channels: Mutex::new(HashMap::new()),
            ip_limits: StdMutex::new(HashMap::new()),
            active_publishers: AtomicUsize::new(0),
            active_listeners: AtomicUsize::new(0),
            next_rtsp_session: AtomicUsize::new(1),
        })
    }

    #[test]
    fn hash_code_matches_sha256_128_bit_hex_prefix() {
        assert_eq!(hash_code("abc"), "ba7816bf8f01cfea414140de5dae2223");
    }

    #[test]
    fn code_accepts_printable_ascii_without_spaces() {
        let config = test_config();

        assert!(validate_code("Abc123!@", &config).is_ok());
        assert!(validate_code("Abc 123!", &config).is_err());
        assert!(validate_code("short", &config).is_err());
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
    fn publisher_ip_limit_releases_when_guard_drops() {
        let mut config = test_config();
        config.max_publishers_per_ip = 1;
        let state = test_state(config);
        let ip = "127.0.0.1".parse().unwrap();

        let guard = try_acquire_publisher_ip(&state, ip).unwrap();
        assert!(guard.is_some());
        assert!(try_acquire_publisher_ip(&state, ip).is_err());
        drop(guard);
        assert!(try_acquire_publisher_ip(&state, ip).unwrap().is_some());
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
        assert!(!sdp.contains("m=video"));
    }
}
