use axum::http::{HeaderValue, Uri};
use serde::{Serialize, Serializer};
use std::{
    collections::HashMap,
    env, fs,
    io::{self, ErrorKind},
    net::SocketAddr,
    path::Path,
    str::FromStr,
    time::Duration,
};

use super::DEFAULT_TOKEN_BUCKET_BURST_SECS;

type ConfigResult<T> = Result<T, Box<dyn std::error::Error>>;

pub(super) const DEFAULT_VIDEO_QUALITIES: &str =
    "1280x720*30/2000,1280x720*60/4000,1920x1080*30/3000,1920x1080*60/6000";
pub(super) const H264_DEFAULT_MAX_ACCESS_UNIT_BYTES: usize = 512 * 1024;
pub(super) const H264_HARD_MAX_ACCESS_UNIT_BYTES: usize = 8 * 1024 * 1024;
const MAX_VIDEO_QUALITIES: usize = 32;
const MAX_VIDEO_INGEST_BURST_SECS: usize = 60;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct VideoQuality {
    pub width: u16,
    pub height: u16,
    pub fps: u16,
    pub bitrate_kbps: u32,
}

impl VideoQuality {
    pub fn video_bytes_per_second(self) -> usize {
        (self.bitrate_kbps as usize).saturating_mul(1000) / 8
    }

    pub fn max_ingest_frames_per_second(self) -> usize {
        (self.fps as usize).saturating_mul(3).div_ceil(2)
    }
}

impl std::fmt::Display for VideoQuality {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "{}x{}*{}/{}",
            self.width, self.height, self.fps, self.bitrate_kbps
        )
    }
}

impl Serialize for VideoQuality {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.collect_str(self)
    }
}

#[derive(Clone)]
pub(super) struct Config {
    pub server_name: String,
    pub log_filter: String,
    pub server_description: String,
    pub official_public: bool,
    pub redirect_url: HeaderValue,
    pub bind_addr: SocketAddr,
    pub rtsp_bind_addr: SocketAddr,
    pub rtsp_public_base: Option<String>,
    pub tls_cert_path: Option<String>,
    pub tls_key_path: Option<String>,
    pub video_enabled: bool,
    pub video_qualities: Vec<VideoQuality>,
    pub max_h264_frame_bytes: usize,
    pub video_ingest_burst_secs: usize,
    pub max_connections: usize,
    pub max_streamers: usize,
    pub max_streamers_per_ip: usize,
    pub max_listeners_total: usize,
    pub max_listeners_per_stream: usize,
    pub max_listeners_per_ip: usize,
    pub max_http_requests_per_ip: usize,
    pub rtsp_handshake_timeout: Duration,
    pub http_rate_limit_window: Duration,
    pub channel_buffer: usize,
    pub streamer_idle_timeout: Duration,
    pub passwords: Vec<String>,
    pub allowed_origins: Vec<String>,
}

impl Config {
    pub fn load() -> ConfigResult<Self> {
        let environment = env::vars_os()
            .filter_map(|(key, value)| Some((key.into_string().ok()?, value.into_string().ok()?)));
        Self::from_sources(Path::new("."), environment)
    }

    pub(super) fn from_sources(
        directory: &Path,
        environment: impl IntoIterator<Item = (String, String)>,
    ) -> ConfigResult<Self> {
        let values = ConfigValues::load(directory, environment)?;
        let tls_cert_path = values.optional(
            "TLS_CERT_PATH",
            "/etc/letsencrypt/live/example.com/fullchain.pem",
        );
        let tls_key_path = values.optional(
            "TLS_KEY_PATH",
            "/etc/letsencrypt/live/example.com/privkey.pem",
        );
        if tls_cert_path.is_some() != tls_key_path.is_some() {
            return Err("TLS_CERT_PATH and TLS_KEY_PATH must be set together".into());
        }

        Ok(Self {
            server_name: values.get("SERVER_NAME", "Self-Hosted Instance").to_owned(),
            log_filter: values.get("RUST_LOG", "warn").to_owned(),
            server_description: values.get("SERVER_DESCRIPTION", "").to_owned(),
            official_public: values.boolean("OFFICIAL_PUBLIC", false),
            redirect_url: parse_redirect_url(
                values.get("ROOT_REDIRECT_URL", "https://vrcast.net"),
            )?,
            bind_addr: values.get("BIND_ADDR", "0.0.0.0:443").parse()?,
            rtsp_bind_addr: values.get("RTSP_BIND_ADDR", "0.0.0.0:554").parse()?,
            rtsp_public_base: normalize_public_base(values.get("RTSP_PUBLIC_BASE", ""), "rtspt://"),
            tls_cert_path,
            tls_key_path,
            video_enabled: values.boolean("VIDEO", true),
            video_qualities: parse_video_qualities(
                values.get("AVAILABLE_VIDEO_QUALITY", DEFAULT_VIDEO_QUALITIES),
            )?,
            max_h264_frame_bytes: values.bounded_usize(
                "MAX_H264_FRAME_BYTES",
                H264_DEFAULT_MAX_ACCESS_UNIT_BYTES,
                H264_HARD_MAX_ACCESS_UNIT_BYTES,
            )?,
            video_ingest_burst_secs: values.bounded_usize(
                "VIDEO_INGEST_BURST_SECS",
                DEFAULT_TOKEN_BUCKET_BURST_SECS,
                MAX_VIDEO_INGEST_BURST_SECS,
            )?,
            max_connections: values.number("MAX_CONNECTIONS", 320),
            max_streamers: values.number("MAX_STREAMERS", 0),
            max_streamers_per_ip: values.number("MAX_STREAMERS_PER_IP", 3),
            max_listeners_total: values.number("MAX_LISTENERS_TOTAL", 0),
            max_listeners_per_stream: values.number("MAX_LISTENERS_PER_STREAM", 105),
            max_listeners_per_ip: values.number("MAX_LISTENERS_PER_IP", 6),
            max_http_requests_per_ip: values.number("MAX_HTTP_REQUESTS_PER_IP", 60),
            rtsp_handshake_timeout: Duration::from_secs(
                values.number("RTSP_HANDSHAKE_TIMEOUT_SECS", 30).max(1),
            ),
            http_rate_limit_window: Duration::from_secs(
                values.number("HTTP_RATE_LIMIT_WINDOW_SECS", 60).max(1),
            ),
            channel_buffer: values.number("CHANNEL_BUFFER", 128usize).max(1),
            streamer_idle_timeout: Duration::from_secs(
                values.number("STREAMER_IDLE_TIMEOUT_SECS", 120),
            ),
            passwords: values.list("PASSWORD", ""),
            allowed_origins: values.list("ALLOWED_ORIGINS", "https://vrcast.net"),
        })
    }
}

// Resolve once at startup without mutating the process environment.
struct ConfigValues(HashMap<String, String>);

impl ConfigValues {
    fn load(
        directory: &Path,
        environment: impl IntoIterator<Item = (String, String)>,
    ) -> ConfigResult<Self> {
        let mut values = HashMap::new();
        for name in ["VRCast.conf", ".env"] {
            let path = directory.join(name);
            let contents = match fs::read_to_string(&path) {
                Ok(contents) => contents,
                Err(error) if error.kind() == ErrorKind::NotFound => continue,
                Err(error) => {
                    return Err(io::Error::new(
                        error.kind(),
                        format!("cannot read {}: {error}", path.display()),
                    )
                    .into());
                }
            };
            for (index, line) in contents.trim_start_matches('\u{feff}').lines().enumerate() {
                let line = line.trim();
                if line.is_empty() || line.starts_with(['#', ';']) {
                    continue;
                }
                let invalid_line = || {
                    io::Error::new(
                        ErrorKind::InvalidData,
                        format!(
                            "invalid KEY=value syntax in {} at line {}",
                            path.display(),
                            index + 1
                        ),
                    )
                };
                let (key, value) = line.split_once('=').ok_or_else(invalid_line)?;
                let key = key.trim();
                if key.is_empty()
                    || !key.bytes().enumerate().all(|(i, byte)| {
                        byte == b'_' || byte.is_ascii_alphabetic() || i > 0 && byte.is_ascii_digit()
                    })
                {
                    return Err(invalid_line().into());
                }
                let value = value.trim();
                // Unquoted values are literal, including spaces, dollars and Windows paths.
                let value = if value.starts_with('"') {
                    serde_json::from_str::<String>(value).map_err(|_| invalid_line())?
                } else if let Some(value) = value.strip_prefix('\'') {
                    value
                        .strip_suffix('\'')
                        .ok_or_else(invalid_line)?
                        .to_owned()
                } else {
                    value.to_owned()
                };
                values.insert(key.to_owned(), value);
            }
        }
        values.extend(environment);
        Ok(Self(values))
    }

    fn get<'a>(&'a self, key: &str, default: &'a str) -> &'a str {
        self.0.get(key).map(String::as_str).unwrap_or(default)
    }

    fn number<T: FromStr>(&self, key: &str, default: T) -> T {
        self.0
            .get(key)
            .and_then(|value| value.parse().ok())
            .unwrap_or(default)
    }

    fn bounded_usize(&self, key: &str, default: usize, max: usize) -> ConfigResult<usize> {
        let value = match self.0.get(key) {
            Some(value) => value
                .parse::<usize>()
                .map_err(|_| format!("{key} must be an integer"))?,
            None => default,
        };
        if !(1..=max).contains(&value) {
            return Err(format!("{key} must be between 1 and {max}").into());
        }
        Ok(value)
    }

    fn boolean(&self, key: &str, default: bool) -> bool {
        self.0
            .get(key)
            .map(|value| {
                matches!(
                    value.to_ascii_lowercase().as_str(),
                    "1" | "true" | "yes" | "on"
                )
            })
            .unwrap_or(default)
    }

    fn optional(&self, key: &str, default: &str) -> Option<String> {
        let value = self.get(key, default);
        (!value.is_empty() && !value.eq_ignore_ascii_case("none")).then(|| value.to_owned())
    }

    fn list(&self, key: &str, default: &str) -> Vec<String> {
        self.get(key, default)
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .collect()
    }
}

pub(super) fn parse_redirect_url(value: &str) -> Result<HeaderValue, Box<dyn std::error::Error>> {
    let value = value.trim();
    let uri: Uri = value.parse()?;
    if !matches!(uri.scheme_str(), Some(scheme) if scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https"))
        || uri.authority().is_none()
    {
        return Err("ROOT_REDIRECT_URL must be an absolute HTTP or HTTPS URL".into());
    }
    Ok(value.parse()?)
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

pub(super) fn parse_video_qualities(
    value: &str,
) -> Result<Vec<VideoQuality>, Box<dyn std::error::Error>> {
    let mut qualities = Vec::new();
    for entry in value
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
    {
        if qualities.len() >= MAX_VIDEO_QUALITIES {
            return Err(format!(
                "AVAILABLE_VIDEO_QUALITY supports at most {MAX_VIDEO_QUALITIES} presets"
            )
            .into());
        }
        let (size_and_fps, bitrate) = entry
            .split_once('/')
            .ok_or_else(|| format!("invalid AVAILABLE_VIDEO_QUALITY preset: {entry}"))?;
        let (size, fps) = size_and_fps
            .split_once('*')
            .ok_or_else(|| format!("invalid AVAILABLE_VIDEO_QUALITY preset: {entry}"))?;
        let (width, height) = size
            .split_once(['x', 'X'])
            .ok_or_else(|| format!("invalid AVAILABLE_VIDEO_QUALITY preset: {entry}"))?;
        let quality = VideoQuality {
            width: parse_nonzero(width, entry)?,
            height: parse_nonzero(height, entry)?,
            fps: parse_nonzero(fps, entry)?,
            bitrate_kbps: parse_nonzero(bitrate, entry)?,
        };
        if qualities.contains(&quality) {
            return Err(format!("duplicate AVAILABLE_VIDEO_QUALITY preset: {entry}").into());
        }
        qualities.push(quality);
    }
    if qualities.is_empty() {
        return Err("AVAILABLE_VIDEO_QUALITY must contain at least one preset".into());
    }
    Ok(qualities)
}

fn parse_nonzero<T>(value: &str, preset: &str) -> Result<T, Box<dyn std::error::Error>>
where
    T: std::str::FromStr + Default + PartialEq,
    T::Err: std::error::Error + 'static,
{
    let parsed = value.trim().parse::<T>()?;
    if parsed == T::default() {
        return Err(format!("zero value in AVAILABLE_VIDEO_QUALITY preset: {preset}").into());
    }
    Ok(parsed)
}
