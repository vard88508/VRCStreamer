# VRCStreamer
Minimal Rust WebSocket-to-RTSP audio/video server for VRChat.

This install guide has only been checked on Debian 13 with the root user.

## 1. Install Rust

```bash
apt install -y curl build-essential
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
. "$HOME/.cargo/env"
```

## 2. Clone And Build

Clone the repo wherever you want to keep it:

```bash
git clone https://github.com/vard88508/VRCStreamer.git
cd VRCStreamer/server
chmod +x build.sh create_service.sh
./build.sh
```

`build.sh` compiles the Rust server and writes:

```text
VRCStreamer/server/VRCStreamer
```

## 3. Configure `.env`

On the first install:

```bash
cp .env.example .env
nano .env
```

Set your domain certificates in `TLS_CERT_PATH`, `TLS_KEY_PATH`.

## 4. Create Service

```bash
./create_service.sh
```

The script writes `/etc/systemd/system/VRCStreamer.service`, enables it, and starts/restarts the service.

Check logs:

```bash
journalctl -u VRCStreamer -f
```

## 5. Start Streaming

Open:

```text
https://stream.vard.cc
```

Choose `Custom Server` and enter your API server address:

```text
HTTP API Address: https://example.com
```

## Updating

```bash
cd VRCStreamer
git pull
cd server
./build.sh
```

## Environment

| Name | Default | Meaning |
| --- | ---: | --- |
| `SERVER_NAME` | `Self-Hosted Instance` | Public server name sent to clients |
| `SERVER_DESCRIPTION` | empty | Public server description sent to clients |
| `BIND_ADDR` | `0.0.0.0:443` | HTTP/HTTPS API and WebSocket ingest listen address |
| `TLS_CERT_PATH` | `/etc/letsencrypt/live/example.com/fullchain.pem` | PEM certificate path |
| `TLS_KEY_PATH` | `/etc/letsencrypt/live/example.com/privkey.pem` | PEM private key path |
| `RTSP_BIND_ADDR` | `0.0.0.0:554` | RTSP listen address |
| `RTSP_PUBLIC_BASE` | `none` | Public RTSP URL sent by `/stats` and streamer hello; `none` derives from API Host header and `RTSP_BIND_ADDR` |
| `ALLOWED_ORIGINS` | `https://vard.cc` | Comma-separated browser origins allowed to stream |
| `ALLOW_ANY_ORIGIN` | `false` | Disable Origin protection when `true` |
| `VIDEO` | `false` | Allow browser streamers to send H.264 video; `false` makes clients audio-only while RTSP still keeps one-shot placeholders |
| `MAX_CONNECTIONS` | `320` | Max simultaneously active streamers + RTSP listeners; `0` disables this limit |
| `MAX_STREAMERS` | `0` | Max simultaneously active streamers; `0` disables this limit |
| `MAX_STREAMERS_PER_IP` | `3` | Max simultaneous streamers from one IP; `0` disables this limit |
| `MAX_LISTENERS_TOTAL` | `0` | Max simultaneously connected RTSP listeners; `0` disables this limit |
| `MAX_LISTENERS_PER_STREAM` | `85` | Max RTSP listeners connected to one stream URL |
| `MAX_LISTENERS_PER_IP` | `6` | Max RTSP listeners from one IP; `0` disables this limit |
| `EGRESS_KBPS_PER_LISTENER` | `384` | Estimated bandwidth cost of one RTSP listener in kilobits/sec; if `MAX_LISTENERS_TOTAL` is non-zero, estimated max outgoing bandwidth is `MAX_LISTENERS_TOTAL * EGRESS_KBPS_PER_LISTENER` |
| `MAX_HTTP_REQUESTS_PER_IP` | `120` | Max `/healthz`, `/stats`, and `/ingest` WebSocket handshake requests from one IP per window; `0` disables this limit |
| `MAX_RTSP_REQUESTS_PER_CONNECTION` | `4096` | Max RTSP commands on one TCP connection; normal playback uses `DESCRIBE`, `SETUP`, `PLAY`, and keepalives; `0` disables this limit |
| `RTSP_HANDSHAKE_TIMEOUT_SECS` | `30` | Max seconds a raw RTSP TCP connection may stay open before `SETUP` |
| `HTTP_RATE_LIMIT_WINDOW_SECS` | `60` | HTTP request rate-limit window |
| `MAX_TRACKED_IPS` | `8192` | Max IP entries kept by the in-memory limiter; `0` disables the cap |
| `MAX_AAC_FRAME_BYTES` | `4096` | Max size of one raw AAC access unit from a streamer WebSocket frame |
| `MAX_INGEST_BYTES_PER_SEC` | `98304` | Max average incoming AAC bytes/sec per streamer |
| `MAX_H264_FRAME_BYTES` | `524288` | Max size of one Annex-B H.264 access unit from a streamer WebSocket frame |
| `MAX_VIDEO_INGEST_BYTES_PER_SEC` | `1048576` | Max average incoming H.264 bytes/sec per streamer |
| `CHANNEL_BUFFER` | `128` | Per-stream frame queue for RTSP listeners; higher tolerates more listener jitter but uses more memory per active stream |
| `STREAMER_IDLE_TIMEOUT_SECS` | `120` | Disconnect a streamer if no WebSocket messages arrive for this many seconds |
| `PASSWORD` | empty | Optional comma-separated passwords; empty disables password auth |
| `RUST_LOG` | `warn` | Server log level |
