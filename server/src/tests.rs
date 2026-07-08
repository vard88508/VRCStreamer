use super::limits::{allow_http_request, try_acquire_listener_ip, try_acquire_streamer_ip};
use super::media::{
    VideoMessage, parse_streamer_media_frame, validate_aac_access_unit, validate_h264_access_unit,
};
use super::rtsp::{
    RtpState, RtspSession, RtspTrack, VideoStreamState, channel_video_state, key_from_rtsp_uri,
    read_rtsp_request, rtsp_sdp, select_rtsp_interleaved_channel,
};
use super::websocket::{StreamerTextCommand, is_websocket_disconnect_noise, streamer_text_command};
use super::*;
use tokio::io::BufReader;

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
        let input = b"OPTIONS rtsp://127.0.0.1/abc RTSP/1.0\r\nCSeq: 1\r\n\r\n";
        let mut reader = BufReader::new(&input[..]);
        let request = read_rtsp_request(&mut reader).await.unwrap().unwrap();

        assert_eq!(request.method, "OPTIONS");
        assert_eq!(request.uri, "rtsp://127.0.0.1/abc");
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

    assert!(matches!(rx.try_recv().unwrap(), VideoMessage::Wake));
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
        streamer_hello_message(&config, 7, "rtsp://example.com"),
        "{\"type\":\"hello\",\"name\":\"Name \\\"A\\\"\",\"description\":\"Line\\nTwo\",\"rtsp_base\":\"rtsp://example.com\",\"video\":true,\"listeners\":7}"
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
        key_from_rtsp_uri("rtsp://example.com:8554/a85c0211c512828c4c52dc5716a79e3a?x=1"),
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

    assert!(streamer_hello_message(&config, 0, "rtsp://example.com").contains("\"video\":false"));
    assert!(rtsp_sdp().contains("m=video 0 RTP/AVP 97\r\n"));
}
