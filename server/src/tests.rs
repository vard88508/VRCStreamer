use super::config::{
    DEFAULT_VIDEO_QUALITIES, H264_DEFAULT_MAX_ACCESS_UNIT_BYTES, H264_HARD_MAX_ACCESS_UNIT_BYTES,
    parse_redirect_url, parse_video_qualities,
};
use super::limits::{
    TokenBucket, try_acquire_connection, try_acquire_listener_ip, try_acquire_streamer_ip,
};
use super::media::{
    StreamerMediaFrame, h264_sdp_fmtp, inspect_h264_access_unit, parse_streamer_media_frame,
    validate_aac_access_unit,
};
use super::rtsp::{
    RTSP_CONTROL_BURST_SECS, RTSP_CONTROL_MESSAGES_PER_SECOND, RtpClock, RtpMediaTimeline,
    RtpPacketWriter, RtpState, RtspInput, RtspSession, RtspTrack, build_rtcp_sender_report,
    parse_rtsp_target, project_rtp_timestamp, read_rtsp_input, rtsp_rtp_info,
    select_rtsp_interleaved_channel, with_write_timeout,
};
use super::websocket::{
    MediaTimestampNormalizer, is_websocket_disconnect_noise, parse_stream_start,
};
use super::*;
use bytes::Bytes;
use std::time::Instant;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    time::Instant as TokioInstant,
};

const TEST_VIDEO_FMTP: &str =
    "packetization-mode=1; profile-level-id=42e01f; sprop-parameter-sets=Z0LgHw==,aM48gA==";

type TestSocket = BufReader<tokio::net::TcpStream>;

struct ConfigTestDir(PathBuf);

impl ConfigTestDir {
    fn new() -> Self {
        static NEXT_ID: AtomicUsize = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "vrcast-config-{}-{}-{}",
            process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT_ID.fetch_add(1, Ordering::Relaxed),
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}

impl Drop for ConfigTestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn config_layers_files_then_environment_without_mutating_environment() {
    let directory = ConfigTestDir::new();
    let previous_name = std::env::var_os("SERVER_NAME");
    let load = || Config::from_sources(&directory.0, []).unwrap();
    let defaults = load();
    assert_eq!(defaults.server_name, "Self-Hosted Instance");
    assert_eq!(
        defaults.video_qualities,
        parse_video_qualities(DEFAULT_VIDEO_QUALITIES).unwrap()
    );

    fs::write(
        directory.0.join("VRCast.conf"),
        concat!(
            "SERVER_NAME=Config server\n",
            "SERVER_DESCRIPTION=Shared configuration\n",
            "PASSWORD=secret\n",
            "VIDEO=false\n",
            "RUST_LOG=debug\n",
            "MAX_CONNECTIONS=90\n",
            "AVAILABLE_VIDEO_QUALITY=1440x1080*60/6000\n",
        ),
    )
    .unwrap();
    let conf = load();
    assert_eq!(conf.server_name, "Config server");
    assert!(!conf.video_enabled);
    assert_eq!(conf.log_filter, "debug");
    assert_eq!(conf.video_qualities[0].width, 1440);

    fs::write(
        directory.0.join(".env"),
        concat!(
            "SERVER_NAME=Env server\n",
            "PASSWORD=\n",
            "VIDEO=true\n",
            "MAX_CONNECTIONS=0\n",
        ),
    )
    .unwrap();
    let combined = load();
    assert_eq!(combined.server_name, "Env server");
    assert_eq!(combined.server_description, "Shared configuration");
    assert!(combined.passwords.is_empty());
    assert!(combined.video_enabled);
    assert_eq!(combined.max_connections, 0);

    let config = Config::from_sources(
        &directory.0,
        [
            ("SERVER_NAME".into(), "Process server".into()),
            ("RUST_LOG".into(), "trace".into()),
        ],
    )
    .unwrap();
    assert_eq!(config.server_name, "Process server");
    assert_eq!(config.log_filter, "trace");
    assert_eq!(config.server_description, combined.server_description);
    assert_eq!(std::env::var_os("SERVER_NAME"), previous_name);

    fs::remove_file(directory.0.join("VRCast.conf")).unwrap();
    assert_eq!(load().server_name, "Env server");
}

#[test]
fn config_accepts_example_quotes_comments_crlf_and_utf8_bom() {
    let directory = ConfigTestDir::new();
    fs::write(
        directory.0.join("VRCast.conf"),
        include_str!("../.env.example"),
    )
    .unwrap();
    let config = Config::from_sources(&directory.0, []).unwrap();
    assert_eq!(config.server_name, "Self-Hosted Instance");
    assert_eq!(config.channel_buffer, 128);
    assert_eq!(
        config.max_h264_frame_bytes,
        H264_DEFAULT_MAX_ACCESS_UNIT_BYTES
    );

    fs::write(
        directory.0.join(".env"),
        concat!(
            "\u{feff}# Local overrides\r\n",
            "SERVER_NAME=\"Vard's server\"\r\n",
            "PASSWORD='p#$$word'\r\n",
            "TLS_CERT_PATH=none\r\n",
            "TLS_KEY_PATH=\r\n",
        ),
    )
    .unwrap();
    let config = Config::from_sources(&directory.0, []).unwrap();
    assert_eq!(config.server_name, "Vard's server");
    assert_eq!(config.passwords, ["p#$$word"]);
    assert!(config.tls_cert_path.is_none());
    assert!(config.tls_key_path.is_none());

    fs::write(
        directory.0.join(".env"),
        concat!(
            "SERVER_NAME=Vard's Server\n",
            "PASSWORD=p#$$word=a\n",
            "TLS_CERT_PATH=C:\\certs\\fullchain.pem\n",
            "SERVER_DESCRIPTION=\u{65e5}\u{672c}\u{8a9e}\n",
        ),
    )
    .unwrap();
    let config = Config::from_sources(&directory.0, []).unwrap();
    assert_eq!(config.server_name, "Vard's Server");
    assert_eq!(config.passwords, ["p#$$word=a"]);
    assert_eq!(
        config.tls_cert_path.as_deref(),
        Some(r"C:\certs\fullchain.pem")
    );
    assert_eq!(config.server_description, "\u{65e5}\u{672c}\u{8a9e}");
}

#[test]
fn config_rejects_broken_files_without_exposing_their_contents() {
    let directory = ConfigTestDir::new();
    for name in ["VRCast.conf", ".env"] {
        let path = directory.0.join(name);
        for contents in [
            "PASSWORD=\"private-secret",
            "PASSWORD='private-secret",
            "private-secret",
            "BAD KEY=private-secret",
        ] {
            fs::write(&path, contents).unwrap();
            let error = Config::from_sources(&directory.0, [])
                .err()
                .unwrap()
                .to_string();
            assert!(error.contains(name));
            assert!(error.contains("line 1"));
            assert!(!error.contains("private-secret"));
        }
        fs::remove_file(&path).unwrap();

        fs::create_dir(&path).unwrap();
        let error = Config::from_sources(&directory.0, [])
            .err()
            .unwrap()
            .to_string();
        assert!(error.contains("cannot read"));
        assert!(error.contains(name));
        fs::remove_dir(&path).unwrap();
    }
}

#[test]
fn config_validates_merged_limits_addresses_and_tls_pair() {
    let directory = ConfigTestDir::new();
    for (key, value) in [
        ("MAX_H264_FRAME_BYTES", "0"),
        ("MAX_H264_FRAME_BYTES", "8388609"),
        ("VIDEO_INGEST_BURST_SECS", "61"),
        ("VIDEO_INGEST_BURST_SECS", "invalid"),
        ("TLS_KEY_PATH", "none"),
        ("BIND_ADDR", "invalid"),
        ("ROOT_REDIRECT_URL", "javascript:alert(1)"),
        ("AVAILABLE_VIDEO_QUALITY", "invalid"),
    ] {
        assert!(
            Config::from_sources(&directory.0, [(key.into(), value.into())]).is_err(),
            "{key}"
        );
    }
}

async fn send_ws(socket: &mut TestSocket, opcode: u8, payload: &[u8]) {
    assert!(payload.len() < 126);
    let mut frame = vec![0x80 | opcode, 0x80 | payload.len() as u8, 0, 0, 0, 0];
    frame.extend_from_slice(payload);
    socket.get_mut().write_all(&frame).await.unwrap();
}

async fn recv_ws(socket: &mut TestSocket) -> (u8, Vec<u8>) {
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut header = [0; 2];
        socket.read_exact(&mut header).await.unwrap();
        assert_eq!(header[1] & 0x80, 0);
        let length = match header[1] {
            126 => socket.read_u16().await.unwrap() as usize,
            127 => panic!("unexpected large server message"),
            length => length as usize,
        };
        let mut body = vec![0; length];
        socket.read_exact(&mut body).await.unwrap();
        (header[0] & 0xf, body)
    })
    .await
    .unwrap()
}

async fn start_test_stream(socket: &mut TestSocket, config: &str) {
    send_ws(socket, 1, config.as_bytes()).await;
    let (opcode, body) = recv_ws(socket).await;
    assert_eq!(opcode, 1, "{}", String::from_utf8_lossy(&body));
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&body).unwrap()["type"],
        "ready"
    );
}

async fn http_get(address: SocketAddr, path: &str) -> (String, String) {
    let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
    socket
        .write_all(
            format!("GET {path} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        )
        .await
        .unwrap();
    let mut response = String::new();
    tokio::time::timeout(Duration::from_secs(5), socket.read_to_string(&mut response))
        .await
        .unwrap()
        .unwrap();
    let (headers, body) = response.split_once("\r\n\r\n").unwrap();
    (headers.to_owned(), body.to_owned())
}

#[test]
fn stream_configuration_is_explicit_and_validated() {
    let mut config = test_config();
    assert_eq!(
        parse_stream_start(r#"{"mode":"audio"}"#, &config).unwrap(),
        (StreamMode::Audio, None)
    );
    assert_eq!(
        parse_stream_start(
            r#"{"mode":"video","video_quality":"1280x720*30/2000"}"#,
            &config
        )
        .unwrap(),
        (StreamMode::Video, Some(config.video_qualities[0]))
    );
    for invalid in [
        "video_start",
        "{}",
        r#"{"mode":"other"}"#,
        r#"{"mode":"video"}"#,
        r#"{"mode":"audio","video_quality":"1280x720*30/2000"}"#,
        r#"{"mode":"video","video_quality":"1280x720*30/9000"}"#,
        r#"{"mode":"audio","extra":true}"#,
    ] {
        assert!(parse_stream_start(invalid, &config).is_err(), "{invalid}");
    }
    assert!(parse_stream_start(&" ".repeat(513), &config).is_err());
    config.video_enabled = false;
    assert!(
        parse_stream_start(
            r#"{"mode":"video","video_quality":"1280x720*30/2000"}"#,
            &config
        )
        .is_err()
    );
    assert!(parse_stream_start(r#"{"mode":"audio"}"#, &config).is_ok());
}

#[tokio::test]
async fn http_api_omits_optional_flag_and_uses_only_mode_counters() {
    for official in [false, true] {
        let mut config = test_config();
        config.official_public = official;
        config.server_name = "A \"quoted\" server".into();
        let state = test_state(config);
        state.streams.audio.store(2, Ordering::Release);
        state.streams.video.store(3, Ordering::Release);
        state.listeners.audio.store(4, Ordering::Release);
        state.listeners.video.store(5, Ordering::Release);
        let (address, server) = test_http_server(state).await;
        let (headers, body) = http_get(address, "/info").await;
        assert!(headers.starts_with("HTTP/1.1 200"));
        let info: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(info["name"], "A \"quoted\" server");
        assert_eq!(info["audio_streams"], 2);
        assert_eq!(info["video_streams"], 3);
        assert_eq!(info["audio_listeners"], 4);
        assert_eq!(info["video_listeners"], 5);
        assert_eq!(info.get("official_public").is_some(), official);
        for key in [
            "active_streamers",
            "active_streams",
            "active_listeners",
            "active_connections",
            "policies_link",
            "report_abuse_link",
            "estimated_egress_kbps",
        ] {
            assert!(info.get(key).is_none());
        }
        assert_eq!(info["video_qualities"][0], "1280x720*30/2000");
        assert_eq!(http_get(address, "/status").await.1, "ok\n");
        for path in ["/", "/anything", "/stats", "/healthz", "/ingest"] {
            let (headers, _) = http_get(address, path).await;
            assert!(headers.starts_with("HTTP/1.1 302"), "{path}");
            assert!(headers.contains("location: https://vrcast.net"));
        }
        server.abort();
    }
}

#[tokio::test]
async fn http_rate_limit_covers_unknown_paths_and_invalid_upgrades() {
    let mut config = test_config();
    config.max_http_requests_per_ip = 2;
    let (address, server) = test_http_server(test_state(config)).await;
    assert!(
        http_get(address, "/unknown")
            .await
            .0
            .starts_with("HTTP/1.1 302")
    );
    assert!(
        http_get(address, "/status")
            .await
            .0
            .starts_with("HTTP/1.1 200")
    );
    for path in ["/status", "/stream?code=bad", "/another-unknown"] {
        assert!(http_get(address, path).await.0.starts_with("HTTP/1.1 429"));
    }
    server.abort();
}

#[tokio::test]
async fn stream_start_and_close_update_counts_and_release_reservation() {
    let state = test_state(test_config());
    let code = "a".repeat(STREAM_CODE_BYTES);
    let (address, server) = test_http_server(state.clone()).await;
    for mode in [StreamMode::Audio, StreamMode::Video] {
        let (status, mut socket) = test_stream_connect(address, &code).await;
        assert!(status.starts_with("HTTP/1.1 101"));
        assert_eq!(state.streams.counter(mode).load(Ordering::Acquire), 0);
        start_test_stream(
            &mut socket,
            match mode {
                StreamMode::Audio => r#"{"mode":"audio"}"#,
                StreamMode::Video => r#"{"mode":"video","video_quality":"1280x720*30/2000"}"#,
            },
        )
        .await;
        assert_eq!(state.streams.counter(mode).load(Ordering::Acquire), 1);
        let (status, _) = test_stream_connect(address, &code).await;
        assert!(status.starts_with("HTTP/1.1 409"));
        send_ws(&mut socket, 8, &1000_u16.to_be_bytes()).await;
        assert_eq!(recv_ws(&mut socket).await.0, 8);
        drop(socket);
        tokio::time::timeout(Duration::from_secs(5), async {
            while state.active_streamers.load(Ordering::Acquire) != 0
                || !state.channels.read().unwrap().is_empty()
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(state.streams.counter(mode).load(Ordering::Acquire), 0);
    }
    server.abort();
}

#[tokio::test]
async fn websocket_rejects_early_media_video_in_audio_mode_and_reconfiguration() {
    for (start, opcode, payload) in [
        (false, 2, vec![0, 0, 0, 0, 0, 1]),
        (true, 2, vec![1, 0, 0, 0, 0, 1]),
        (
            true,
            1,
            br#"{"mode":"video","video_quality":"1280x720*30/2000"}"#.to_vec(),
        ),
    ] {
        let state = test_state(test_config());
        let (address, server) = test_http_server(state).await;
        let (status, mut socket) =
            test_stream_connect(address, &"a".repeat(STREAM_CODE_BYTES)).await;
        assert!(status.starts_with("HTTP/1.1 101"));
        if start {
            start_test_stream(&mut socket, r#"{"mode":"audio"}"#).await;
        }
        send_ws(&mut socket, opcode, &payload).await;
        let (opcode, body) = recv_ws(&mut socket).await;
        assert_eq!(opcode, 8);
        assert_eq!(&body[..2], &1008_u16.to_be_bytes());
        server.abort();
    }
}

#[test]
fn rtsp_audio_suffix_and_track_are_independent() {
    let id = "0123456789abcdef0123456789abcdef";
    for base in [format!("/{id}"), format!("rtspt://example.com:8554/{id}")] {
        let bare = parse_rtsp_target(&base).unwrap();
        assert_eq!(bare.key, id);
        assert!(!bare.audio_only);
        assert_eq!(bare.track, None);
        let queried = format!("{base}/trackID=0?x=1");
        let track = parse_rtsp_target(&queried).unwrap();
        assert_eq!(track.key, id);
        assert_eq!(track.track, Some(0));
        let uri = format!("{base}/audio/trackID=0");
        let audio = parse_rtsp_target(&uri).unwrap();
        assert!(audio.audio_only);
        assert_eq!(audio.track, Some(0));
        assert!(parse_rtsp_target(&format!("{base}/audio/extra")).is_none());
        assert!(parse_rtsp_target(&format!("{base}/trackID=2")).is_none());
    }
    assert!(parse_rtsp_target(&format!("/live/{id}")).is_none());
    assert!(parse_rtsp_target(&format!("/{id}{id}")).is_none());
}

async fn rtsp_request(
    socket: &mut TestSocket,
    method: &str,
    uri: &str,
    extra: &str,
) -> (String, String) {
    socket
        .get_mut()
        .write_all(format!("{method} {uri} RTSP/1.0\r\nCSeq: 1\r\n{extra}\r\n").as_bytes())
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        // Skip any already queued interleaved RTP/RTCP before the response.
        while socket.fill_buf().await.unwrap().first() == Some(&b'$') {
            let mut header = [0; 4];
            socket.read_exact(&mut header).await.unwrap();
            let mut payload = vec![0; u16::from_be_bytes([header[2], header[3]]) as usize];
            socket.read_exact(&mut payload).await.unwrap();
        }
        let mut headers = String::new();
        let mut length = 0;
        loop {
            let mut line = String::new();
            socket.read_line(&mut line).await.unwrap();
            assert!(!line.is_empty(), "RTSP connection closed before response");
            if line == "\r\n" {
                break;
            }
            if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                length = value.trim().parse::<usize>().unwrap();
            }
            headers.push_str(&line);
        }
        let mut body = vec![0; length];
        socket.read_exact(&mut body).await.unwrap();
        (headers, String::from_utf8(body).unwrap())
    })
    .await
    .unwrap()
}

async fn test_rtsp_server(state: Arc<AppState>) -> (SocketAddr, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    (address, tokio::spawn(rtsp_server(state, listener)))
}

#[tokio::test]
async fn rtsp_control_flood_closes_only_the_offending_connection() {
    for playing in [false, true] {
        for interleaved in [false, true] {
            let state = test_state(test_config());
            let (address, server) = test_rtsp_server(state.clone()).await;
            let mut socket = BufReader::new(tokio::net::TcpStream::connect(address).await.unwrap());
            let uri = format!("rtsp://{address}/0123456789abcdef0123456789abcdef/audio");
            let mut healthy =
                BufReader::new(tokio::net::TcpStream::connect(address).await.unwrap());
            assert!(
                rtsp_request(&mut healthy, "OPTIONS", &uri, "")
                    .await
                    .0
                    .starts_with("RTSP/1.0 200")
            );
            assert!(
                rtsp_request(&mut socket, "OPTIONS", &uri, "")
                    .await
                    .0
                    .starts_with("RTSP/1.0 200")
            );
            if playing {
                assert!(
                    rtsp_request(&mut socket, "DESCRIBE", &uri, "")
                        .await
                        .0
                        .starts_with("RTSP/1.0 200")
                );
                assert!(
                    rtsp_request(
                        &mut socket,
                        "SETUP",
                        &format!("{uri}/trackID=0"),
                        "Transport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n",
                    )
                    .await
                    .0
                    .starts_with("RTSP/1.0 200")
                );
                assert!(
                    rtsp_request(&mut socket, "PLAY", &uri, "")
                        .await
                        .0
                        .starts_with("RTSP/1.0 200")
                );
            }
            let message: &[u8] = if interleaved {
                b"$\x01\x00\x08\x80\xc9\x00\x01\x00\x00\x00\x01"
            } else {
                b"OPTIONS * RTSP/1.0\r\nCSeq: 100\r\n\r\n"
            };
            let flood = message.repeat(1024);
            let result = tokio::time::timeout(Duration::from_secs(5), async {
                socket.get_mut().write_all(&flood).await?;
                socket.read_to_end(&mut Vec::new()).await
            })
            .await
            .expect("control flood was not disconnected");
            if let Err(error) = result {
                assert!(
                    matches!(
                        error.kind(),
                        std::io::ErrorKind::ConnectionReset
                            | std::io::ErrorKind::ConnectionAborted
                            | std::io::ErrorKind::BrokenPipe
                    ),
                    "{error}"
                );
            }
            tokio::time::timeout(Duration::from_secs(5), async {
                while state.active_connections.load(Ordering::Acquire) != 1 {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            assert_eq!(state.active_listeners.load(Ordering::Acquire), 0);
            assert!(state.channels.read().unwrap().is_empty());

            assert!(
                rtsp_request(&mut healthy, "OPTIONS", &uri, "")
                    .await
                    .0
                    .starts_with("RTSP/1.0 200")
            );
            server.abort();
        }
    }
}

async fn read_interleaved(socket: &mut TestSocket) -> (u8, Vec<u8>) {
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut header = [0; 4];
        socket.read_exact(&mut header).await.unwrap();
        assert_eq!(header[0], b'$');
        let mut body = vec![0; u16::from_be_bytes([header[2], header[3]]) as usize];
        socket.read_exact(&mut body).await.unwrap();
        (header[1], body)
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn audio_view_remains_audio_and_stays_connected_across_video_sessions() {
    let state = test_state(test_config());
    let key = "0123456789abcdef0123456789abcdef";
    let (channel, ()) = reserve_channel(&state, key, |_| ());
    let (address, server) = test_rtsp_server(state.clone()).await;
    let mut socket = BufReader::new(tokio::net::TcpStream::connect(address).await.unwrap());
    let uri = format!("rtsp://{address}/{key}/audio");
    let (status, sdp) = rtsp_request(
        &mut socket,
        "DESCRIBE",
        &uri,
        "User-Agent: AndroidXMedia3/1.8\r\n",
    )
    .await;
    assert!(status.starts_with("RTSP/1.0 200"));
    assert!(!sdp.contains("video"));
    assert!(!sdp.contains("H264"));
    assert!(sdp.contains("m=audio 0 RTP/AVP 97\r\n"));
    assert!(sdp.contains("a=control:trackID=0\r\n"));
    assert!(!sdp.contains("trackID=1"));
    let (status, _) = rtsp_request(
        &mut socket,
        "SETUP",
        &format!("{uri}/trackID=0"),
        "Transport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n",
    )
    .await;
    assert!(status.starts_with("RTSP/1.0 200"));
    assert_eq!(state.listeners.audio.load(Ordering::Acquire), 1);
    assert_eq!(state.listeners.video.load(Ordering::Acquire), 0);
    assert_eq!(state.active_streamers.load(Ordering::Acquire), 0);
    assert!(
        rtsp_request(&mut socket, "PLAY", &uri, "")
            .await
            .0
            .starts_with("RTSP/1.0 200")
    );
    let mut previous = None;
    for live in [false, true, false, true, false] {
        advance_stream_generation(&channel);
        channel.mode.store(
            if live { StreamMode::Video as u8 } else { 0 },
            Ordering::Release,
        );
        channel.set_video_fmtp(live.then(|| Arc::from(TEST_VIDEO_FMTP)));
        wake_media_listeners(&channel);
        // Ensure the listener has entered the new generation before publishing test audio.
        let (status, _) = rtsp_request(&mut socket, "OPTIONS", &uri, "").await;
        assert!(status.starts_with("RTSP/1.0 200"));
        let feeder = tokio::spawn({
            let channel = channel.clone();
            async move {
                if live {
                    for index in 0..20 {
                        let _ = channel.audio_tx.send(AudioMessage::Frame {
                            access_unit: Bytes::from_static(AAC_SILENCE_ACCESS_UNIT),
                            media_timestamp: index
                                * AAC_SAMPLES_PER_FRAME as u64
                                * MEDIA_CLOCK_RATE as u64
                                / AAC_SAMPLE_RATE as u64,
                            published_at: Instant::now(),
                        });
                        tokio::time::sleep(AAC_FRAME_DURATION).await;
                    }
                }
            }
        });
        loop {
            let (interleaved, packet) = read_interleaved(&mut socket).await;
            assert!(interleaved <= 1);
            if interleaved == 0 {
                assert_eq!(packet[1] & 0x7f, RTP_AUDIO_PAYLOAD_TYPE);
                let timestamp = u32::from_be_bytes(packet[4..8].try_into().unwrap());
                if let Some(previous) = previous {
                    assert!(timestamp.wrapping_sub(previous) < u32::MAX / 2);
                }
                previous = Some(timestamp);
                break;
            }
        }
        feeder.abort();
    }
    assert!(
        rtsp_request(&mut socket, "TEARDOWN", &uri, "")
            .await
            .0
            .starts_with("RTSP/1.0 200")
    );
    drop(socket);
    tokio::time::timeout(Duration::from_secs(5), async {
        while state.active_listeners.load(Ordering::Acquire) != 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(state.listeners.audio.load(Ordering::Acquire), 0);
    server.abort();
}

#[tokio::test]
async fn bare_audio_view_ends_when_video_starts() {
    let state = test_state(test_config());
    let key = "0123456789abcdef0123456789abcdef";
    let (address, server) = test_rtsp_server(state.clone()).await;
    let uri = format!("rtsp://{address}/{key}");
    let mut socket = BufReader::new(tokio::net::TcpStream::connect(address).await.unwrap());
    let (_, sdp) = rtsp_request(&mut socket, "DESCRIBE", &uri, "").await;
    assert!(!sdp.contains("m=video"));
    assert!(
        rtsp_request(
            &mut socket,
            "SETUP",
            &format!("{uri}/trackID=0"),
            "Transport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n"
        )
        .await
        .0
        .starts_with("RTSP/1.0 200")
    );
    assert!(
        rtsp_request(&mut socket, "PLAY", &uri, "")
            .await
            .0
            .starts_with("RTSP/1.0 200")
    );
    let (channel, ()) = reserve_channel(&state, key, |channel| {
        advance_stream_generation(channel);
        channel
            .mode
            .store(StreamMode::Video as u8, Ordering::Release);
    });
    wake_media_listeners(&channel);
    tokio::time::timeout(Duration::from_secs(5), socket.read_to_end(&mut Vec::new()))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(state.listeners.audio.load(Ordering::Acquire), 0);
    server.abort();
}

#[tokio::test]
async fn video_play_rejects_a_recreated_channel_after_describe() {
    let state = test_state(test_config());
    let key = "0123456789abcdef0123456789abcdef";
    let make_video = |channel: &Channel| {
        advance_stream_generation(channel);
        channel
            .mode
            .store(StreamMode::Video as u8, Ordering::Release);
        channel.set_video_fmtp(Some(Arc::from(TEST_VIDEO_FMTP)));
    };
    let (old, ()) = reserve_channel(&state, key, make_video);
    let (address, server) = test_rtsp_server(state.clone()).await;
    let uri = format!("rtsp://{address}/{key}");
    let mut socket = BufReader::new(tokio::net::TcpStream::connect(address).await.unwrap());
    assert!(
        rtsp_request(&mut socket, "DESCRIBE", &uri, "")
            .await
            .1
            .contains("m=video")
    );
    cleanup_channel(&state, key, &old);
    let (current, ()) = reserve_channel(&state, key, make_video);
    assert!(!Arc::ptr_eq(&old, &current));
    assert!(
        rtsp_request(
            &mut socket,
            "SETUP",
            &format!("{uri}/trackID=0"),
            "Transport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n"
        )
        .await
        .0
        .starts_with("RTSP/1.0 200")
    );
    assert!(
        rtsp_request(&mut socket, "PLAY", &uri, "")
            .await
            .0
            .starts_with("RTSP/1.0 455")
    );
    server.abort();
}

#[tokio::test]
async fn video_description_waits_for_real_configuration_and_playback_ends_on_disconnect() {
    let state = test_state(test_config());
    let key = "0123456789abcdef0123456789abcdef";
    let (channel, ()) = reserve_channel(&state, key, |channel| {
        channel
            .mode
            .store(StreamMode::Video as u8, Ordering::Release);
    });
    let (address, server) = test_rtsp_server(state.clone()).await;
    let mut socket = BufReader::new(tokio::net::TcpStream::connect(address).await.unwrap());
    let uri = format!("rtsp://{address}/{key}");
    let setter = tokio::spawn({
        let channel = channel.clone();
        async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            channel.set_video_fmtp(Some(Arc::from(TEST_VIDEO_FMTP)));
        }
    });
    let (status, sdp) = rtsp_request(&mut socket, "DESCRIBE", &uri, "").await;
    setter.await.unwrap();
    assert!(status.starts_with("RTSP/1.0 200"));
    assert!(sdp.contains(TEST_VIDEO_FMTP));
    assert!(sdp.contains("a=range:npt=now-\r\n"));
    assert!(sdp.contains("a=control:*\r\n"));
    assert!(sdp.contains("m=video 0 RTP/AVP 96\r\n"));
    assert!(sdp.contains("a=control:trackID=0\r\n"));
    assert!(sdp.contains("a=rtpmap:96 H264/90000\r\n"));
    assert!(sdp.contains("m=audio 0 RTP/AVP 97\r\n"));
    assert!(sdp.contains("a=control:trackID=1\r\n"));
    assert!(sdp.contains("a=rtpmap:97 mpeg4-generic/48000/2\r\n"));
    assert!(sdp.contains("config=1190"));
    assert!(sdp.find("m=video").unwrap() < sdp.find("m=audio").unwrap());
    for id in 0..2 {
        assert!(
            rtsp_request(
                &mut socket,
                "SETUP",
                &format!("{uri}/trackID={id}"),
                &format!(
                    "Transport: RTP/AVP/TCP;unicast;interleaved={}-{}\r\n",
                    id * 2,
                    id * 2 + 1
                )
            )
            .await
            .0
            .starts_with("RTSP/1.0 200")
        );
    }
    assert_eq!(state.listeners.video.load(Ordering::Acquire), 1);
    assert_eq!(state.listeners.audio.load(Ordering::Acquire), 0);
    assert!(
        rtsp_request(&mut socket, "PLAY", &uri, "")
            .await
            .0
            .starts_with("RTSP/1.0 200")
    );
    channel.mode.store(0, Ordering::Release);
    advance_stream_generation(&channel);
    wake_media_listeners(&channel);
    let mut rest = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), socket.read_to_end(&mut rest))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(state.active_listeners.load(Ordering::Acquire), 0);
    assert_eq!(state.listeners.video.load(Ordering::Acquire), 0);
    server.abort();
}

fn test_config() -> Config {
    Config {
        log_filter: "warn".to_owned(),
        server_name: "VRCast".to_owned(),
        server_description: "Test server".to_owned(),
        official_public: false,
        redirect_url: HeaderValue::from_static("https://vrcast.net"),
        bind_addr: "127.0.0.1:8080".parse().unwrap(),
        rtsp_bind_addr: "127.0.0.1:8554".parse().unwrap(),
        rtsp_public_base: None,
        tls_cert_path: None,
        tls_key_path: None,
        video_enabled: true,
        video_qualities: parse_video_qualities(DEFAULT_VIDEO_QUALITIES).unwrap(),
        max_h264_frame_bytes: H264_DEFAULT_MAX_ACCESS_UNIT_BYTES,
        video_ingest_burst_secs: DEFAULT_TOKEN_BUCKET_BURST_SECS,
        max_connections: 0,
        max_streamers: 1,
        max_streamers_per_ip: 3,
        max_listeners_total: 1,
        max_listeners_per_stream: 1,
        max_listeners_per_ip: 16,
        max_http_requests_per_ip: 120,
        rtsp_handshake_timeout: Duration::from_secs(30),
        http_rate_limit_window: Duration::from_secs(60),
        channel_buffer: 8,
        streamer_idle_timeout: Duration::from_secs(1),
        passwords: Vec::new(),
        allowed_origins: Vec::new(),
    }
}

fn test_state(config: Config) -> Arc<AppState> {
    Arc::new(AppState {
        config,
        channels: StdRwLock::new(HashMap::new()),
        stream_blacklist: StdRwLock::new(HashSet::new()),
        blocked_streamer_ips: StdRwLock::new(StreamerIpBans::default()),
        ip_limits: StdMutex::new(IpLimitTable::new()),
        streams: MediaCounts::default(),
        listeners: MediaCounts::default(),
        active_connections: AtomicUsize::new(0),
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
fn stream_id_log_only_exposes_suffix() {
    assert_eq!(
        stream_id_for_log("0123456789abcdef0123456789abcdef").to_string(),
        "...cdef"
    );
    assert_eq!(
        stream_id_for_log("not-a-stream-id").to_string(),
        "[invalid]"
    );
}

#[test]
fn stream_blacklist_parses_semicolons_whitespace_and_duplicates() {
    let entries = parse_stream_blacklist(
        "A85C0211C512828C4C52DC5716A79E3A;\n1dd5a1d78b07336b21496ccf7bf79b8a;\n\
         a85c0211c512828c4c52dc5716a79e3a",
    )
    .unwrap();

    assert_eq!(entries.len(), 2);
    assert!(entries.contains("a85c0211c512828c4c52dc5716a79e3a"));
    assert!(entries.contains("1dd5a1d78b07336b21496ccf7bf79b8a"));
    assert!(parse_stream_blacklist("not-a-stream-id").is_err());
}

#[test]
fn replacing_blacklist_notifies_active_streamers() {
    let state = test_state(test_config());
    let key = "a85c0211c512828c4c52dc5716a79e3a";
    let (channel, ()) = reserve_channel(&state, key, |channel| {
        channel.streamer.store(true, Ordering::Release);
    });

    let changed = replace_stream_blacklist(&state, HashSet::from([key.to_owned()]));
    assert_eq!(changed, Some((1, 1)));
    assert!(state.stream_blacklist.read().unwrap().contains(key));
    assert!(replace_stream_blacklist(&state, HashSet::from([key.to_owned()])).is_none());

    channel.streamer.store(false, Ordering::Release);
    cleanup_channel(&state, key, &channel);
}

#[test]
fn removing_blacklisted_stream_releases_its_ips() {
    let state = test_state(test_config());
    let key = "a85c0211c512828c4c52dc5716a79e3a";
    let ip: IpAddr = "203.0.113.42".parse().unwrap();
    let other_ip: IpAddr = "2001:db8::1".parse().unwrap();
    let entries = HashSet::from([key.to_owned()]);
    replace_stream_blacklist(&state, entries.clone());

    assert!(!streamer_ip_is_blocked(&state, ip));
    assert!(block_streamer_ip_if_blacklisted(&state, key, ip));
    assert!(block_streamer_ip_if_blacklisted(&state, key, other_ip));
    assert!(block_streamer_ip_if_blacklisted(&state, key, ip));
    assert!(replace_stream_blacklist(&state, entries.clone()).is_none());
    assert!(streamer_ip_is_blocked(&state, ip));
    assert!(streamer_ip_is_blocked(&state, other_ip));

    replace_stream_blacklist(&state, HashSet::new());
    assert!(!streamer_ip_is_blocked(&state, ip));
    assert!(!streamer_ip_is_blocked(&state, other_ip));
    assert!(!block_streamer_ip_if_blacklisted(&state, key, ip));
    assert!(!streamer_ip_is_blocked(&state, ip));

    replace_stream_blacklist(&state, entries);
    assert!(!streamer_ip_is_blocked(&state, ip));
    assert!(block_streamer_ip_if_blacklisted(&state, key, ip));
    assert!(streamer_ip_is_blocked(&state, ip));
}

#[test]
fn shared_ip_stays_blocked_until_all_its_stream_ids_are_removed() {
    let state = test_state(test_config());
    let first = "a85c0211c512828c4c52dc5716a79e3a";
    let second = "1dd5a1d78b07336b21496ccf7bf79b8a";
    let shared_ip: IpAddr = "203.0.113.42".parse().unwrap();
    let first_only_ip: IpAddr = "203.0.113.43".parse().unwrap();
    replace_stream_blacklist(&state, HashSet::from([first.to_owned(), second.to_owned()]));
    assert!(block_streamer_ip_if_blacklisted(&state, first, shared_ip));
    assert!(block_streamer_ip_if_blacklisted(&state, second, shared_ip));
    assert!(block_streamer_ip_if_blacklisted(
        &state,
        first,
        first_only_ip
    ));

    replace_stream_blacklist(&state, HashSet::from([second.to_owned()]));
    assert!(streamer_ip_is_blocked(&state, shared_ip));
    assert!(!streamer_ip_is_blocked(&state, first_only_ip));
    assert!(!block_streamer_ip_if_blacklisted(
        &state,
        first,
        first_only_ip
    ));
    assert!(!streamer_ip_is_blocked(&state, first_only_ip));

    replace_stream_blacklist(&state, HashSet::new());
    assert!(!streamer_ip_is_blocked(&state, shared_ip));
}

#[test]
fn concurrent_blacklist_removal_cannot_leave_a_stale_ip_ban() {
    let state = test_state(test_config());
    let key = "a85c0211c512828c4c52dc5716a79e3a";
    let ip: IpAddr = "203.0.113.42".parse().unwrap();
    let barrier = std::sync::Barrier::new(2);
    for _ in 0..32 {
        replace_stream_blacklist(&state, HashSet::from([key.to_owned()]));
        std::thread::scope(|scope| {
            scope.spawn(|| {
                barrier.wait();
                block_streamer_ip_if_blacklisted(&state, key, ip);
            });
            barrier.wait();
            replace_stream_blacklist(&state, HashSet::new());
        });
        assert!(!streamer_ip_is_blocked(&state, ip));
    }
}

#[test]
fn ip_ban_overflow_remains_linked_to_its_stream_id() {
    let state = test_state(test_config());
    let first = "a85c0211c512828c4c52dc5716a79e3a";
    let second = "1dd5a1d78b07336b21496ccf7bf79b8a";
    replace_stream_blacklist(&state, HashSet::from([first.to_owned(), second.to_owned()]));
    for index in 0..MAX_STREAMER_IP_BANS {
        let ip = IpAddr::V6((index as u128 + 1).into());
        assert!(block_streamer_ip_if_blacklisted(&state, first, ip));
    }
    let overflow_ip: IpAddr = "203.0.113.42".parse().unwrap();
    let other_ip: IpAddr = "203.0.113.43".parse().unwrap();
    assert!(block_streamer_ip_if_blacklisted(
        &state,
        second,
        overflow_ip
    ));
    assert!(streamer_ip_is_blocked(&state, overflow_ip));
    assert!(streamer_ip_is_blocked(&state, other_ip));
    assert_eq!(
        state.blocked_streamer_ips.read().unwrap().associations,
        MAX_STREAMER_IP_BANS
    );

    replace_stream_blacklist(&state, HashSet::from([second.to_owned()]));
    assert!(streamer_ip_is_blocked(&state, overflow_ip));
    assert!(streamer_ip_is_blocked(&state, other_ip));

    replace_stream_blacklist(&state, HashSet::new());
    assert!(!streamer_ip_is_blocked(&state, overflow_ip));
    assert!(!streamer_ip_is_blocked(&state, other_ip));
    assert_eq!(state.blocked_streamer_ips.read().unwrap().associations, 0);
}

async fn test_http_server(state: Arc<AppState>) -> (SocketAddr, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = http_router(state);
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });
    (address, server)
}

async fn test_stream_connect(
    address: SocketAddr,
    code: &str,
) -> (String, BufReader<tokio::net::TcpStream>) {
    let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
    let request = format!(
        "GET /stream?code={code} HTTP/1.1\r\nHost: {address}\r\n\
         Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n\
         Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
    );
    socket.write_all(request.as_bytes()).await.unwrap();
    let mut socket = BufReader::new(socket);
    let mut response = String::new();
    tokio::time::timeout(Duration::from_secs(5), socket.read_line(&mut response))
        .await
        .unwrap()
        .unwrap();
    loop {
        let mut header = String::new();
        socket.read_line(&mut header).await.unwrap();
        if header == "\r\n" || header.is_empty() {
            break;
        }
    }
    (response, socket)
}

#[tokio::test]
async fn rejected_ingest_remembers_each_blacklisted_id_for_the_same_ip() {
    let state = test_state(test_config());
    let first = "a".repeat(STREAM_CODE_BYTES);
    let second = "b".repeat(STREAM_CODE_BYTES);
    let third = "c".repeat(STREAM_CODE_BYTES);
    replace_stream_blacklist(
        &state,
        HashSet::from([hash_code(&first), hash_code(&second)]),
    );
    let (address, server) = test_http_server(state.clone()).await;
    for code in [&first, &second] {
        let (status, _) = test_stream_connect(address, code).await;
        assert!(status.starts_with("HTTP/1.1 403"));
    }
    replace_stream_blacklist(&state, HashSet::from([hash_code(&second)]));
    let (status, _) = test_stream_connect(address, &third).await;
    assert!(status.starts_with("HTTP/1.1 403"));
    assert_eq!(state.active_streamers.load(Ordering::Acquire), 0);
    replace_stream_blacklist(&state, HashSet::new());
    let (status, _) = test_stream_connect(address, &third).await;
    assert!(status.starts_with("HTTP/1.1 101"));

    server.abort();
    assert!(server.await.unwrap_err().is_cancelled());
}

#[tokio::test]
async fn blacklist_reload_bans_active_streamer_without_kicking_other_streams_from_its_ip() {
    let mut config = test_config();
    config.max_streamers = 2;
    config.streamer_idle_timeout = Duration::from_secs(30);
    let state = test_state(config);
    let first = "a".repeat(STREAM_CODE_BYTES);
    let second = "b".repeat(STREAM_CODE_BYTES);
    let (address, server) = test_http_server(state.clone()).await;
    let (status, mut first_socket) = test_stream_connect(address, &first).await;
    assert!(status.starts_with("HTTP/1.1 101"));
    let (status, mut second_socket) = test_stream_connect(address, &second).await;
    assert!(status.starts_with("HTTP/1.1 101"));

    start_test_stream(&mut first_socket, r#"{"mode":"audio"}"#).await;
    start_test_stream(&mut second_socket, r#"{"mode":"audio"}"#).await;
    assert_eq!(
        replace_stream_blacklist(&state, HashSet::from([hash_code(&first)])),
        Some((1, 1))
    );
    tokio::time::timeout(Duration::from_secs(5), async {
        while state.active_streamers.load(Ordering::Acquire) != 1 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(streamer_ip_is_blocked(&state, address.ip()));
    let second_channel = state.channels.read().unwrap()[&hash_code(&second)].clone();
    assert!(second_channel.streamer.load(Ordering::Acquire));

    replace_stream_blacklist(&state, HashSet::new());
    assert!(!streamer_ip_is_blocked(&state, address.ip()));
    drop((first_socket, second_socket));
    tokio::time::timeout(Duration::from_secs(5), async {
        while state.active_streamers.load(Ordering::Acquire) != 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(!streamer_ip_is_blocked(&state, address.ip()));

    server.abort();
    assert!(server.await.unwrap_err().is_cancelled());
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

#[tokio::test]
async fn rtsp_parser_accepts_bounded_request_line() {
    let input = b"OPTIONS rtspt://127.0.0.1/abc RTSP/1.0\r\nCSeq: 1\r\n\r\n";
    let mut reader = BufReader::new(&input[..]);
    let Some(RtspInput::Request(request)) = read_rtsp_input(&mut reader).await.unwrap() else {
        panic!("expected RTSP request");
    };
    assert_eq!(request.method, "OPTIONS");
    assert_eq!(request.uri, "rtspt://127.0.0.1/abc");
    assert_eq!(request.header("cseq"), Some("1"));
    assert!(read_rtsp_input(&mut reader).await.unwrap().is_none());
}

#[tokio::test]
async fn rtsp_parser_consumes_interleaved_client_data_before_next_request() {
    let input = b"\r\n$\x01\x00\x04testOPTIONS rtspt://127.0.0.1/abc RTSP/1.0\r\nCSeq: 2\r\nContent-Length: 4\r\n\r\nbodyOPTIONS * RTSP/1.0\r\nCSeq: 3\r\n\r\n";
    let mut reader = BufReader::new(&input[..]);
    assert!(matches!(
        read_rtsp_input(&mut reader).await.unwrap(),
        Some(RtspInput::Interleaved)
    ));
    let Some(RtspInput::Request(request)) = read_rtsp_input(&mut reader).await.unwrap() else {
        panic!("expected RTSP request");
    };
    assert_eq!(request.method, "OPTIONS");
    assert_eq!(request.header("cseq"), Some("2"));
    let Some(RtspInput::Request(request)) = read_rtsp_input(&mut reader).await.unwrap() else {
        panic!("expected the next request after the body");
    };
    assert_eq!(request.header("cseq"), Some("3"));
    assert!(read_rtsp_input(&mut reader).await.unwrap().is_none());
}

#[tokio::test]
async fn rtsp_parser_rejects_malformed_or_incomplete_messages() {
    for input in [
        "\r\n\r\n\r\n\r\n\r\n",
        "OPTIONS\r\n",
        "OPTIONS * HTTP/1.1\r\n\r\n",
        "OPTIONS * RTSP/1.0 extra\r\n\r\n",
        "OPTIONS * RTSP/1.0",
        "OPTIONS * RTSP/1.0\r\n",
        "OPTIONS * RTSP/1.0\r\nCSeq: 1\r\n",
        "OPTIONS * RTSP/1.0\r\nBroken header\r\n\r\n",
        "OPTIONS * RTSP/1.0\r\nCSeq: 1\rInjected: yes\r\n\r\n",
        "OPTIONS * RTSP/1.0\r\nContent-Length: nope\r\n\r\n",
        "OPTIONS * RTSP/1.0\r\nContent-Length: -1\r\n\r\n",
        "OPTIONS * RTSP/1.0\r\nContent-Length: +1\r\n\r\na",
        "OPTIONS * RTSP/1.0\r\nContent-Length: 999999999999999999999\r\n\r\n",
        "OPTIONS * RTSP/1.0\r\nContent-Length: 1\r\nContent-Length: 0\r\n\r\na",
        "OPTIONS * RTSP/1.0\r\nContent-Length: 4\r\n\r\nab",
    ] {
        assert!(
            read_rtsp_input(&mut BufReader::new(input.as_bytes()))
                .await
                .is_err(),
            "accepted {input:?}"
        );
    }
}

#[tokio::test]
async fn rtsp_write_timeout_cancels_stalled_work_and_releases_resources() {
    assert_eq!(with_write_timeout(async { Ok(42) }).await.unwrap(), 42);
    assert_eq!(
        with_write_timeout::<()>(async { Err("write failed".into()) })
            .await
            .unwrap_err()
            .to_string(),
        "write failed"
    );
    let state = Arc::new(test_state(test_config()));
    let error = tokio::time::timeout(
        Duration::from_secs(12),
        with_write_timeout(async {
            let _guard = try_acquire_connection(&state).unwrap();
            std::future::pending::<Result<(), Box<dyn std::error::Error + Send + Sync>>>().await
        }),
    )
    .await
    .expect("stalled write did not time out")
    .unwrap_err();
    assert_eq!(error.to_string(), "rtsp write timeout");
    assert_eq!(state.active_connections.load(Ordering::Acquire), 0);
}

#[tokio::test]
async fn rtsp_parser_rejects_oversized_interleaved_client_data() {
    let length = (RTSP_MAX_INTERLEAVED_BYTES + 1) as u16;
    let mut input = vec![b'$', 1];
    input.extend_from_slice(&length.to_be_bytes());
    let mut reader = BufReader::new(input.as_slice());
    let error = match read_rtsp_input(&mut reader).await {
        Ok(_) => panic!("oversized interleaved packet was accepted"),
        Err(error) => error,
    };
    assert!(error.to_string().contains("interleaved packet too large"));
}

#[tokio::test]
async fn rtsp_parser_rejects_unbounded_request_line() {
    let input = vec![b'A'; RTSP_MAX_LINE_BYTES + 1];
    let mut reader = BufReader::new(input.as_slice());
    let error = match read_rtsp_input(&mut reader).await {
        Ok(_) => panic!("oversized request line was accepted"),
        Err(error) => error,
    };
    assert!(error.to_string().contains("rtsp line too long"));
}

#[tokio::test]
async fn rtsp_parser_rejects_oversized_header_block() {
    let mut input = b"OPTIONS rtspt://127.0.0.1/abc RTSP/1.0\r\n".to_vec();
    let value = vec![b'A'; RTSP_MAX_LINE_BYTES - 6];
    for _ in 0..5 {
        input.extend_from_slice(b"X: ");
        input.extend_from_slice(&value);
        input.extend_from_slice(b"\r\n");
    }
    input.extend_from_slice(b"\r\n");
    let mut reader = BufReader::new(input.as_slice());
    let error = match read_rtsp_input(&mut reader).await {
        Ok(_) => panic!("oversized RTSP headers were accepted"),
        Err(error) => error,
    };
    assert!(error.to_string().contains("rtsp headers are too large"));
}

#[test]
fn video_quality_parser_accepts_custom_presets() {
    assert_eq!(
        parse_video_qualities("640x360*24/700, 3840X2160*60/12000").unwrap(),
        vec![
            VideoQuality {
                width: 640,
                height: 360,
                fps: 24,
                bitrate_kbps: 700,
            },
            VideoQuality {
                width: 3840,
                height: 2160,
                fps: 60,
                bitrate_kbps: 12000,
            },
        ]
    );
    assert!(parse_video_qualities("1280x720*30/0").is_err());
    assert!(parse_video_qualities("invalid").is_err());
}

#[test]
fn redirect_url_requires_absolute_http_url() {
    assert!(parse_redirect_url("https://vrcast.net/path").is_ok());
    assert!(parse_redirect_url("javascript:alert(1)").is_err());
    assert!(parse_redirect_url("/relative").is_err());
}

#[test]
fn media_rate_limiter_bounds_initial_burst() {
    let now = Instant::now();
    let mut limiter = TokenBucket::new();
    assert!(limiter.allow_at(now, 2000, 1000, 2));
    assert!(!limiter.allow_at(now, 1000, 1000, 2));
    assert_eq!(limiter.available_units(), 0);
    let later = now + Duration::from_secs(1);
    assert!(limiter.allow_at(later, 1000, 1000, 2));
    assert!(!limiter.allow_at(later, 1, 1000, 2));

    let mut larger_burst = TokenBucket::new();
    assert!(larger_burst.allow_at(now, 3000, 1000, 3));
    assert!(!larger_burst.allow_at(now, 1, 1000, 3));
}

#[test]
fn rtsp_control_budget_refills_without_a_lifetime_limit() {
    let mut limiter = TokenBucket::new();
    let mut now = Instant::now();
    let rate = RTSP_CONTROL_MESSAGES_PER_SECOND;
    let burst = RTSP_CONTROL_BURST_SECS;
    assert!(limiter.allow_at(now, 8, rate, burst));
    for _ in 0..10_000 {
        now += Duration::from_secs(60);
        assert!(limiter.allow_at(now, 1, rate, burst));
    }
    assert!(limiter.allow_at(now, rate * burst - 1, rate, burst));
    assert!(!limiter.allow_at(now, 1, rate, burst));
    now += Duration::from_secs(1);
    assert!(limiter.allow_at(now, rate, rate, burst));
    assert!(!limiter.allow_at(now, 1, rate, burst));
}

#[test]
fn video_quality_rate_matches_selected_bitrate() {
    let quality = VideoQuality {
        width: 1280,
        height: 720,
        fps: 30,
        bitrate_kbps: 2000,
    };
    assert_eq!(quality.video_bytes_per_second(), 250_000);
    assert_eq!(quality.max_ingest_frames_per_second(), 45);
}

#[test]
fn code_accepts_exact_length_printable_ascii_without_spaces() {
    assert!(validate_code("Abc123!@Abc123!@Abc123!@Abc123!@").is_ok());
    assert!(validate_code("Abc 123!Abc123!@Abc123!@Abc123!@").is_err());
    assert!(validate_code("short").is_err());
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
fn connection_limit_is_atomic_and_releases() {
    let mut config = test_config();
    config.max_connections = 2;
    let state = test_state(config);

    let first = try_acquire_connection(&state).unwrap();
    let second = try_acquire_connection(&state).unwrap();
    assert_eq!(state.active_connections.load(Ordering::Acquire), 2);
    assert!(try_acquire_connection(&state).is_err());

    drop(first);
    assert!(try_acquire_connection(&state).is_ok());
    drop(second);
}

#[test]
fn channel_reservation_cannot_race_cleanup() {
    let state = test_state(test_config());
    let (channel, ()) = reserve_channel(&state, "stream", |_| ());
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();

    let reserve_state = state.clone();
    let reserve = std::thread::spawn(move || {
        reserve_channel(&reserve_state, "stream", |channel| {
            entered_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            channel.listeners.fetch_add(1, Ordering::AcqRel);
        })
        .0
    });

    entered_rx.recv().unwrap();
    let cleanup_state = state.clone();
    let cleanup_channel_ref = channel.clone();
    let cleanup = std::thread::spawn(move || {
        cleanup_channel(&cleanup_state, "stream", &cleanup_channel_ref);
    });
    release_tx.send(()).unwrap();

    let reserved = reserve.join().unwrap();
    cleanup.join().unwrap();
    let channels = state
        .channels
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    assert!(Arc::ptr_eq(channels.get("stream").unwrap(), &reserved));
}

#[test]
fn websocket_message_limit_ignores_h264_size_when_video_is_disabled() {
    let mut config = test_config();
    config.max_h264_frame_bytes = 2 * 1024 * 1024;
    config.video_enabled = false;

    assert_eq!(
        max_ws_message_bytes(&config),
        AAC_MAX_ACCESS_UNIT_BYTES + MEDIA_FRAME_HEADER_BYTES
    );

    config.video_enabled = true;
    assert_eq!(
        max_ws_message_bytes(&config),
        config.max_h264_frame_bytes + MEDIA_FRAME_HEADER_BYTES
    );
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
fn websocket_origin_and_cors_share_one_policy() {
    let mut config = test_config();
    config.allowed_origins = vec!["https://client.example".to_owned()];
    let mut headers = HeaderMap::new();

    assert!(origin_allowed(&headers, &config));

    headers.insert(ORIGIN, HeaderValue::from_static("https://client.example"));
    assert!(origin_allowed(&headers, &config));
    assert!(cors_origin(&headers, &config).is_some());

    headers.insert(ORIGIN, HeaderValue::from_static("https://other.example"));
    headers.insert(HOST, HeaderValue::from_static("server.example"));
    assert!(!origin_allowed(&headers, &config));
    assert!(cors_origin(&headers, &config).is_none());

    headers.insert(ORIGIN, HeaderValue::from_static("https://server.example"));
    assert!(origin_allowed(&headers, &config));
    assert!(cors_origin(&headers, &config).is_some());

    headers.insert(ORIGIN, HeaderValue::from_static("https://other.example"));
    config.allowed_origins = vec!["https://*.example".to_owned()];
    assert!(!origin_allowed(&headers, &config));
    assert!(cors_origin(&headers, &config).is_none());

    for allowed in [vec!["*"], vec!["https://client.example", "*"]] {
        config.allowed_origins = allowed.into_iter().map(str::to_owned).collect();
        assert!(origin_allowed(&headers, &config));
        let mut response = HeaderMap::new();
        apply_http_cors(&mut response, &headers, &config);
        assert_eq!(response[ACCESS_CONTROL_ALLOW_ORIGIN], "*");
        assert_eq!(response[VARY], "Origin");
    }

    config.allowed_origins.clear();
    assert!(!origin_allowed(&headers, &config));
    assert!(cors_origin(&headers, &config).is_none());
}

#[test]
fn streamer_preserves_audio_source_timestamp() {
    let frame = Bytes::from_static(&[0x00, 0x12, 0x34, 0x56, 0x78, 0x21, 0x10, 0x56, 0xe5]);

    let StreamerMediaFrame::Audio {
        access_unit,
        source_timestamp,
    } = parse_streamer_media_frame(frame, &test_config()).unwrap()
    else {
        panic!("expected audio frame");
    };

    assert_eq!(source_timestamp, 0x1234_5678);
    assert_eq!(access_unit.as_ref(), &[0x21, 0x10, 0x56, 0xe5]);
}

#[test]
fn streamer_rejects_untyped_audio_frame() {
    assert!(matches!(
        parse_streamer_media_frame(
            Bytes::from_static(&[0x21, 0x10, 0x56, 0xe5]),
            &test_config()
        ),
        Err("unknown media frame type")
    ));
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
fn validator_accepts_standard_non_vcl_h264_nal_units() {
    for nal_type in 10..=12 {
        let access_unit = [0, 0, 0, 1, 0x65, 0x88, 0x84, 0, 0, 0, 1, nal_type, 0x80];
        assert!(
            inspect_h264_access_unit(&access_unit, true, H264_DEFAULT_MAX_ACCESS_UNIT_BYTES)
                .is_ok(),
            "NAL type {nal_type} should be accepted",
        );
    }
}

#[test]
fn validator_accepts_h264_prefix_nal_units() {
    let access_unit = [
        0, 0, 0, 1, 0x09, 0x30, 0, 0, 0, 1, 0x4e, 0x80, 0x80, 0x0f, 0x20, 0, 0, 0, 1, 0x41, 0x9a,
    ];

    assert!(
        inspect_h264_access_unit(&access_unit, false, H264_DEFAULT_MAX_ACCESS_UNIT_BYTES).is_ok()
    );
}

#[test]
fn validator_still_rejects_unapproved_h264_extension_nal_units() {
    let access_unit = [0, 0, 0, 1, 0x65, 0x88, 0x84, 0, 0, 0, 1, 0x0d, 0x80];
    assert_eq!(
        inspect_h264_access_unit(&access_unit, true, H264_DEFAULT_MAX_ACCESS_UNIT_BYTES),
        Err("unsupported h264 nal unit")
    );
}

#[test]
fn h264_sdp_uses_in_band_sps_and_pps() {
    let access_unit = [
        0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1f, 0, 0, 0, 1, 0x68, 0xce, 0x3c, 0x80, 0, 0, 1, 0x65,
        0x88, 0x84,
    ];
    let fmtp = h264_sdp_fmtp(&access_unit).unwrap();

    assert!(fmtp.contains("profile-level-id=42e01f"));
    assert!(fmtp.contains("sprop-parameter-sets=Z0LgHw==,aM48gA=="));
}

#[test]
fn streamer_preserves_video_source_timestamp() {
    let frame = Bytes::from_static(&[
        0x01, 0x12, 0x34, 0x56, 0x78, 0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1f, 0, 0, 1, 0x65, 0x88, 0x84,
    ]);

    let StreamerMediaFrame::Video {
        access_unit,
        keyframe,
        single_nal,
        source_timestamp,
    } = parse_streamer_media_frame(frame, &test_config()).unwrap()
    else {
        panic!("expected video frame");
    };

    assert!(keyframe);
    assert!(!single_nal);
    assert_eq!(source_timestamp, 0x1234_5678);
    assert_eq!(access_unit[4] & 0x1f, 7);
}

#[test]
fn streamer_marks_single_nal_video_frames() {
    let frame = Bytes::from_static(&[0x02, 0, 0, 0, 1, 0, 0, 0, 1, 0x41, 0x9a]);

    let StreamerMediaFrame::Video { single_nal, .. } =
        parse_streamer_media_frame(frame, &test_config()).unwrap()
    else {
        panic!("expected video frame");
    };

    assert!(single_nal);
}

#[test]
fn streamer_does_not_fast_path_a_trailing_h264_start_code() {
    let frame = Bytes::from_static(&[0x02, 0, 0, 0, 1, 0, 0, 0, 1, 0x41, 0x9a, 0, 0, 0, 1]);

    let StreamerMediaFrame::Video { single_nal, .. } =
        parse_streamer_media_frame(frame, &test_config()).unwrap()
    else {
        panic!("expected video frame");
    };

    assert!(!single_nal);
}

#[test]
fn streamer_applies_configured_h264_frame_limit() {
    let frame = Bytes::from_static(&[
        0x01, 0, 0, 0, 0, 0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1f, 0, 0, 1, 0x65, 0x88, 0x84,
    ]);
    let mut config = test_config();
    config.max_h264_frame_bytes = frame.len() - MEDIA_FRAME_HEADER_BYTES - 1;

    assert!(matches!(
        parse_streamer_media_frame(frame, &config),
        Err("h264 access unit is too large")
    ));
}

#[test]
fn streamer_rejects_video_frame_without_timestamp_header() {
    let frame = Bytes::from_static(&[0x01, 0, 0, 0]);

    assert!(matches!(
        parse_streamer_media_frame(frame, &test_config()),
        Err("video frame header is too small")
    ));
}

#[test]
fn shared_media_timeline_preserves_audio_video_offsets() {
    let started_at = TokioInstant::now();
    let audio_clock = RtpClock::new(0, AAC_SAMPLE_RATE, started_at);
    let video_clock = RtpClock::new(0, H264_CLOCK_RATE, started_at);
    let mut timeline = RtpMediaTimeline::default();

    let audio_start = timeline.map(1, 10_000, &audio_clock);
    let video_start = timeline.map(1, 10_000, &video_clock);
    let audio_later = timeline.map(1, 11_024, &audio_clock);
    let video_later = timeline.map(1, 11_024, &video_clock);

    assert_eq!(audio_later.wrapping_sub(audio_start), 1_024);
    assert_eq!(video_later.wrapping_sub(video_start), 1_920);

    let long_source = 10_000 + MEDIA_CLOCK_RATE as u64 * 31 * 60;
    let long_audio = timeline.map(1, long_source, &audio_clock);
    let long_video = timeline.map(1, long_source, &video_clock);
    let next_audio = timeline.map(1, long_source + 1_024, &audio_clock);
    let next_video = timeline.map(1, long_source + 1_024, &video_clock);
    assert_eq!(next_audio.wrapping_sub(long_audio), 1_024);
    assert_eq!(next_video.wrapping_sub(long_video), 1_920);

    let reset = timeline.map(2, 50, &audio_clock);
    let reset_later = timeline.map(2, 1_074, &audio_clock);
    assert_eq!(reset_later.wrapping_sub(reset), 1_024);
}

#[test]
fn media_timestamps_normalize_native_clock_rates_and_wrap() {
    let mut audio = MediaTimestampNormalizer::new(AAC_SAMPLE_RATE);
    let mut video = MediaTimestampNormalizer::new(H264_CLOCK_RATE);
    assert_eq!(audio.normalize(48_000), 48_000);
    assert_eq!(video.normalize(90_000), 48_000);

    let before_wrap = video.normalize(u32::MAX - 89_999);
    let after_wrap = video.normalize(0);
    assert_eq!(after_wrap - before_wrap, 48_000);
}

#[test]
fn streamer_rejects_video_frames_when_video_is_disabled() {
    let mut config = test_config();
    config.video_enabled = false;
    let frame = Bytes::from_static(&[
        0x01, 0, 0, 0, 0, 0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1f, 0, 0, 1, 0x65, 0x88, 0x84,
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
        inspect_h264_access_unit(&access_unit, true, H264_DEFAULT_MAX_ACCESS_UNIT_BYTES),
        Err("h264 keyframe has no idr slice")
    );
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

    let empty = RtspSession::default();
    assert_eq!(
        select_rtsp_interleaved_channel(&empty, RtspTrack::Video, Some(u8::MAX)),
        0
    );
}

#[test]
fn rtsp_live_tracks_match_advertised_order() {
    let session = RtspSession {
        video_advertised: true,
        video_setup: true,
        audio_setup: true,
        audio_channel: 2,
        video_rtp: RtpState {
            sequence: 10,
            timestamp: 20,
            ..RtpState::default()
        },
        audio_rtp: RtpState {
            sequence: 30,
            timestamp: 40,
            ..RtpState::default()
        },
        ..RtspSession::default()
    };
    assert_eq!(
        rtsp_rtp_info("rtsp://example.com/stream", &session),
        "url=rtsp://example.com/stream/trackID=0;seq=10;rtptime=20,url=rtsp://example.com/stream/trackID=1;seq=30;rtptime=40"
    );
    assert_eq!(
        select_rtsp_interleaved_channel(&session, RtspTrack::Video, None),
        0
    );
    assert_eq!(
        select_rtsp_interleaved_channel(&session, RtspTrack::Audio, None),
        2
    );

    let audio_only = RtspSession {
        audio_setup: true,
        audio_rtp: RtpState {
            sequence: 30,
            timestamp: 40,
            ..RtpState::default()
        },
        ..RtspSession::default()
    };
    assert_eq!(
        rtsp_rtp_info("rtsp://example.com/stream", &audio_only),
        "url=rtsp://example.com/stream/trackID=0;seq=30;rtptime=40"
    );
    assert_eq!(
        select_rtsp_interleaved_channel(&audio_only, RtspTrack::Audio, None),
        0
    );
}

#[test]
fn aac_rtp_timestamp_delta_is_one_access_unit() {
    let mut rtp = RtpState::default();
    rtp.advance_by(AAC_SAMPLES_PER_FRAME, 123);
    assert_eq!(rtp.timestamp, 1024);
    assert_eq!(rtp.sequence, 1);
    assert_eq!(rtp.packet_count, 1);
    assert_eq!(rtp.octet_count, 123);
}

#[tokio::test]
async fn batched_h264_keeps_rtp_packet_boundaries() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (client, accepted) =
        tokio::join!(tokio::net::TcpStream::connect(address), listener.accept());
    let mut client = client.unwrap();
    let (server, _) = accepted.unwrap();
    let (read_half, write_half) = server.into_split();
    drop(read_half);
    let writer = Arc::new(tokio::sync::Mutex::new(Some(write_half)));

    let mut access_unit = vec![0, 0, 0, 1, 0x65];
    access_unit.resize(4 + 1 + RTP_MAX_PAYLOAD_BYTES * 3, 0x55);
    let nal_payload_bytes = access_unit.len() - 5;
    let expected_packets = nal_payload_bytes.div_ceil(RTP_MAX_PAYLOAD_BYTES - 2);
    let mut rtp = RtpState {
        sequence: 10,
        timestamp: 90_000,
        ..RtpState::default()
    };
    let mut sender = RtpPacketWriter::new(2, 4 + 12 + RTP_MAX_PAYLOAD_BYTES);
    sender
        .send_h264_access_unit(&writer, &access_unit, true, &mut rtp)
        .await
        .unwrap();
    drop(sender);
    drop(writer);

    let mut bytes = Vec::new();
    client.read_to_end(&mut bytes).await.unwrap();
    let mut offset = 0usize;
    let mut packets = 0usize;
    while offset < bytes.len() {
        assert_eq!(bytes[offset], b'$');
        assert_eq!(bytes[offset + 1], 2);
        let packet_len = u16::from_be_bytes([bytes[offset + 2], bytes[offset + 3]]) as usize;
        let packet = &bytes[offset + 4..offset + 4 + packet_len];
        assert_eq!(packet[0], 0x80);
        assert_eq!(packet[1] & 0x7f, RTP_VIDEO_PAYLOAD_TYPE);
        assert_eq!(
            u16::from_be_bytes([packet[2], packet[3]]),
            10 + packets as u16
        );
        assert_eq!(
            u32::from_be_bytes([packet[4], packet[5], packet[6], packet[7]]),
            90_000
        );
        packets += 1;
        assert_eq!(packet[1] & 0x80 != 0, packets == expected_packets);
        offset += 4 + packet_len;
    }

    assert_eq!(packets, expected_packets);
    assert_eq!(rtp.packet_count as usize, expected_packets);
    assert_eq!(rtp.sequence, 10 + expected_packets as u16);
}

#[tokio::test]
async fn cancelling_a_media_write_closes_the_writer_before_other_writes() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut client = tokio::net::TcpStream::connect(listener.local_addr().unwrap())
        .await
        .unwrap();
    let (server, _) = listener.accept().await.unwrap();
    let (_read_half, write_half) = server.into_split();
    let writer = Arc::new(tokio::sync::Mutex::new(Some(write_half)));
    let mut packet_writer = RtpPacketWriter::new(2, 16 * 1024);
    let mut rtp = RtpState::default();
    let mut access_unit = vec![0x61; H264_HARD_MAX_ACCESS_UNIT_BYTES];
    access_unit[..4].copy_from_slice(&[0, 0, 0, 1]);
    {
        let send = packet_writer.send_h264_access_unit(&writer, &access_unit, true, &mut rtp);
        tokio::pin!(send);
        // Stop while the large write waits for socket readiness or a cooperative yield.
        let poll = std::future::poll_fn(|cx| {
            std::task::Poll::Ready(std::future::Future::poll(send.as_mut(), cx))
        })
        .await;
        assert!(poll.is_pending());
        assert!(writer.try_lock().is_err());
    }
    assert!(writer.lock().await.is_none());
    assert!(
        packet_writer
            .send_h264_access_unit(&writer, &[0, 0, 0, 1, 0x61], true, &mut rtp)
            .await
            .is_err()
    );
    tokio::time::timeout(Duration::from_secs(2), client.read_to_end(&mut Vec::new()))
        .await
        .unwrap()
        .unwrap();
}

#[test]
fn rtcp_sender_report_contains_counts_and_cname() {
    let rtp = RtpState {
        sequence: 7,
        timestamp: 9,
        packet_count: 11,
        octet_count: 13,
    };
    let mut packet = Vec::new();
    build_rtcp_sender_report(
        &mut packet,
        3,
        RTP_VIDEO_SSRC,
        (0x1122_3344, 0x5566_7788),
        0x99aa_bbcc,
        &rtp,
        "test",
    );

    assert_eq!(&packet[..4], &[b'$', 3, 0, 44]);
    assert_eq!(&packet[4..8], &[0x80, 200, 0, 6]);
    assert_eq!(&packet[8..12], &RTP_VIDEO_SSRC.to_be_bytes());
    assert_eq!(&packet[12..16], &0x1122_3344u32.to_be_bytes());
    assert_eq!(&packet[16..20], &0x5566_7788u32.to_be_bytes());
    assert_eq!(&packet[20..24], &0x99aa_bbccu32.to_be_bytes());
    assert_eq!(&packet[24..28], &11u32.to_be_bytes());
    assert_eq!(&packet[28..32], &13u32.to_be_bytes());
    assert_eq!(&packet[32..36], &[0x81, 202, 0, 3]);
    assert!(packet.windows(4).any(|bytes| bytes == b"test"));
}

#[test]
fn rtcp_rtp_timestamp_projects_from_latest_media_time() {
    assert_eq!(
        project_rtp_timestamp(90_000, Duration::from_millis(500), H264_CLOCK_RATE),
        135_000
    );
    assert_eq!(
        project_rtp_timestamp(u32::MAX - 9, Duration::from_secs(1), 10),
        0
    );
}
