use super::limits::{
    TokenBucket, allow_http_request, try_acquire_listener_ip, try_acquire_streamer_ip,
};
use super::media::{
    StreamerMediaFrame, VideoMessage, h264_sdp_fmtp, parse_streamer_media_frame,
    validate_aac_access_unit, validate_h264_access_unit,
};
use super::rtsp::{
    RtpState, RtpTimestampMapper, RtspSession, RtspTrack, VideoStreamState,
    build_rtcp_sender_report, channel_video_state, key_from_rtsp_uri, placeholder_access_unit,
    read_rtsp_request, rtcp_requests_keyframe, rtsp_sdp, select_rtsp_interleaved_channel,
};
use super::websocket::{StreamerTextCommand, is_websocket_disconnect_noise, streamer_text_command};
use super::*;
use tokio::io::BufReader;

const TEST_VIDEO_FMTP: &str =
    "packetization-mode=1; profile-level-id=42e01f; sprop-parameter-sets=Z0LgHw==,aM48gA==";

fn test_config() -> Config {
    Config {
        server_name: "VRCStreamer".to_owned(),
        server_description: "Test server".to_owned(),
        redirect_url: HeaderValue::from_static("https://stream.vard.cc"),
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
        max_rtsp_requests_per_connection: 4096,
        rtsp_handshake_timeout: Duration::from_secs(30),
        http_rate_limit_window: Duration::from_secs(60),
        egress_kbps_per_listener: 384,
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
        ip_limits: StdMutex::new(IpLimitTable::new()),
        placeholders: Placeholders {
            offline_video: Bytes::new(),
            audio_only_video: Bytes::new(),
            offline_fmtp: Arc::from(TEST_VIDEO_FMTP),
            audio_only_fmtp: Arc::from(TEST_VIDEO_FMTP),
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
fn rtsp_parser_rejects_oversized_header_block() {
    run_async_test(async {
        let mut input = b"OPTIONS rtspt://127.0.0.1/abc RTSP/1.0\r\n".to_vec();
        let value = vec![b'A'; RTSP_MAX_LINE_BYTES - 6];
        for _ in 0..5 {
            input.extend_from_slice(b"X: ");
            input.extend_from_slice(&value);
            input.extend_from_slice(b"\r\n");
        }
        input.extend_from_slice(b"\r\n");

        let mut reader = BufReader::new(input.as_slice());
        let error = match read_rtsp_request(&mut reader).await {
            Ok(_) => panic!("oversized RTSP headers were accepted"),
            Err(error) => error,
        };

        assert!(error.to_string().contains("rtsp headers are too large"));
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
    assert!(matches!(
        streamer_text_command("video_reset"),
        Some(StreamerTextCommand::VideoReset)
    ));
    assert!(matches!(
        streamer_text_command("video_quality:3"),
        Some(StreamerTextCommand::VideoQuality(3))
    ));
    assert!(streamer_text_command("video_quality:nope").is_none());
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
    assert!(parse_redirect_url("https://stream.vard.cc/path").is_ok());
    assert!(parse_redirect_url("javascript:alert(1)").is_err());
    assert!(parse_redirect_url("/relative").is_err());
}

#[test]
fn media_rate_limiter_bounds_initial_burst() {
    let mut limiter = TokenBucket::new();
    assert!(limiter.allow(2000, 1000, 2));
    assert!(!limiter.allow(1000, 1000, 2));
    assert_eq!(limiter.available_units(), 0);

    let mut larger_burst = TokenBucket::new();
    assert!(larger_burst.allow(3000, 1000, 3));
    assert!(!larger_burst.allow(1, 1000, 3));
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
fn video_keyframe_requests_are_coalesced() {
    let channel = Channel::new(8);
    channel.streamer.store(true, Ordering::Release);
    channel.video_active.store(true, Ordering::Release);

    assert!(request_video_keyframe(&channel));
    assert!(channel.keyframe_pending.load(Ordering::Acquire));
    assert!(!request_video_keyframe(&channel));
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
        streamer_hello_message(&config, 7, "rtspt://example.com"),
        "{\"type\":\"hello\",\"name\":\"Name \\\"A\\\"\",\"description\":\"Line\\nTwo\",\"rtsp_base\":\"rtspt://example.com\",\"video\":true,\"video_qualities\":[\"1280x720*30/2000\",\"1280x720*60/4000\",\"1920x1080*30/3000\",\"1920x1080*60/6000\"],\"listeners\":7}"
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
fn validator_accepts_raw_aac_access_unit() {
    assert!(validate_aac_access_unit(&[0x21, 0x10, 0x56, 0xe5]).is_ok());
}

#[test]
fn streamer_preserves_audio_rtp_timestamp() {
    let frame = Bytes::from_static(&[0x00, 0x12, 0x34, 0x56, 0x78, 0x21, 0x10, 0x56, 0xe5]);

    let StreamerMediaFrame::Audio {
        access_unit,
        rtp_timestamp,
    } = parse_streamer_media_frame(frame, &test_config()).unwrap()
    else {
        panic!("expected audio frame");
    };

    assert_eq!(rtp_timestamp, 0x1234_5678);
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
fn validator_accepts_annex_b_h264_keyframe() {
    let access_unit = [
        0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1f, 0, 0, 1, 0x65, 0x88, 0x84,
    ];
    assert!(
        validate_h264_access_unit(&access_unit, true, H264_DEFAULT_MAX_ACCESS_UNIT_BYTES).is_ok()
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
fn streamer_preserves_video_rtp_timestamp() {
    let frame = Bytes::from_static(&[
        0x01, 0x12, 0x34, 0x56, 0x78, 0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1f, 0, 0, 1, 0x65, 0x88, 0x84,
    ]);

    let StreamerMediaFrame::Video {
        access_unit,
        keyframe,
        rtp_timestamp,
    } = parse_streamer_media_frame(frame, &test_config()).unwrap()
    else {
        panic!("expected video frame");
    };

    assert!(keyframe);
    assert_eq!(rtp_timestamp, 0x1234_5678);
    assert_eq!(access_unit[4] & 0x1f, 7);
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
fn rtp_timestamp_mapper_preserves_gaps_and_wraps() {
    let mut timestamps = RtpTimestampMapper::default();
    assert_eq!(timestamps.map(90_000), None);

    let output = u32::MAX - 100;
    timestamps.start(90_000, output);
    assert_eq!(timestamps.map(90_000), Some(output));
    assert_eq!(timestamps.map(93_000), Some(output.wrapping_add(3_000)));

    timestamps.reset();
    assert_eq!(timestamps.map(93_000), None);
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
        validate_h264_access_unit(&access_unit, true, H264_DEFAULT_MAX_ACCESS_UNIT_BYTES),
        Err("h264 keyframe has no idr slice")
    );
}

#[test]
fn rtsp_uri_parser_extracts_hash() {
    let key = "a85c0211c512828c4c52dc5716a79e3a";

    assert_eq!(
        key_from_rtsp_uri("rtspt://example.com/a85c0211c512828c4c52dc5716a79e3a"),
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
    rtp.advance_by(AAC_SAMPLES_PER_FRAME, 123);
    assert_eq!(rtp.timestamp, 1024);
    assert_eq!(rtp.sequence, 1);
    assert_eq!(rtp.packet_count, 1);
    assert_eq!(rtp.octet_count, 123);
}

#[test]
fn rtcp_feedback_detects_pli_and_fir() {
    let pli = [0x81, 206, 0, 2, 0, 0, 0, 1, 0x56, 0x52, 0x43, 0x56];
    let fir = [
        0x84, 206, 0, 4, 0, 0, 0, 1, 0, 0, 0, 0, 0x56, 0x52, 0x43, 0x56, 1, 0, 0, 0,
    ];
    let receiver_report = [0x80, 201, 0, 1, 0, 0, 0, 1];
    let mut compound = receiver_report.to_vec();
    compound.extend_from_slice(&pli);

    assert!(rtcp_requests_keyframe(&pli));
    assert!(rtcp_requests_keyframe(&fir));
    assert!(rtcp_requests_keyframe(&compound));
    assert!(!rtcp_requests_keyframe(&receiver_report));
    assert!(!rtcp_requests_keyframe(&[0x81, 206, 0, 10]));
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
fn rtsp_sdp_matches_topaz_audio_shape() {
    let sdp = rtsp_sdp(TEST_VIDEO_FMTP);

    assert!(sdp.contains("m=audio 0 RTP/AVP 96\r\n"));
    assert!(sdp.contains("a=control:trackID=0\r\n"));
    assert!(sdp.contains("a=rtpmap:96 mpeg4-generic/48000/2\r\n"));
    assert!(sdp.contains("config=1190"));
    assert!(sdp.contains("m=video 0 RTP/AVP 97\r\n"));
    assert!(sdp.contains("a=control:trackID=1\r\n"));
    assert!(sdp.contains("a=rtpmap:97 H264/90000\r\n"));
    assert!(sdp.contains(TEST_VIDEO_FMTP));
}

#[test]
fn streamer_video_flag_is_independent_from_rtsp_placeholder_track() {
    let mut config = test_config();
    config.video_enabled = false;

    assert!(streamer_hello_message(&config, 0, "rtspt://example.com").contains("\"video\":false"));
    assert!(rtsp_sdp(TEST_VIDEO_FMTP).contains("m=video 0 RTP/AVP 97\r\n"));
}

#[test]
fn active_video_never_selects_a_placeholder() {
    let placeholders = Placeholders {
        offline_video: Bytes::from_static(b"offline"),
        audio_only_video: Bytes::from_static(b"audio"),
        offline_fmtp: Arc::from(TEST_VIDEO_FMTP),
        audio_only_fmtp: Arc::from(TEST_VIDEO_FMTP),
    };
    assert!(placeholder_access_unit(&placeholders, VideoStreamState::Offline).is_some());
    assert!(placeholder_access_unit(&placeholders, VideoStreamState::AudioOnly).is_some());
    assert!(placeholder_access_unit(&placeholders, VideoStreamState::Video).is_none());
}
