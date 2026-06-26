# VRCStreamer
Minimal Rust WebSocket-to-RTSP audio server for VRChat.

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

If the `VRCStreamer` systemd service already exists, `build.sh` restarts it after a successful build.

## 3. Configure `.env`

On the first install:

```bash
cp .env.example .env
nano .env
```

Example:

```env
BIND_ADDR=0.0.0.0:443
TLS_CERT_PATH=/etc/letsencrypt/live/example.com/fullchain.pem
TLS_KEY_PATH=/etc/letsencrypt/live/example.com/privkey.pem
RTSP_BIND_ADDR=0.0.0.0:554
RTSP_EXTRA_BIND_ADDR=
ALLOWED_ORIGINS=https://vard.cc
MAX_PUBLISHERS=500
MAX_PUBLISHERS_PER_IP=3
MAX_LISTENERS_TOTAL=2500
MAX_LISTENERS_PER_STREAM=85
MAX_HTTP_REQUESTS_PER_IP=120
HTTP_RATE_LIMIT_WINDOW_SECS=60
MAX_TRACKED_IPS=8192
MAX_AAC_FRAME_BYTES=4096
MAX_INGEST_BYTES_PER_SEC=98304
CHANNEL_BUFFER=128
PUBLISHER_IDLE_TIMEOUT_SECS=120
CODE_MIN_BYTES=8
CODE_MAX_BYTES=128
RUST_LOG=warn
```

Set your real domain in `TLS_CERT_PATH`, `TLS_KEY_PATH`, and `ALLOWED_ORIGINS`.

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
https://vard.cc/VRCStreamer
```

Choose `Custom` and enter your server addresses:

```text
API:  https://example.com
RTSP: rtsp://example.com
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
| `BIND_ADDR` | `0.0.0.0:443` | HTTP/HTTPS API and WebSocket ingest listen address |
| `TLS_CERT_PATH` | `/etc/letsencrypt/live/example.com/fullchain.pem` | PEM certificate path |
| `TLS_KEY_PATH` | `/etc/letsencrypt/live/example.com/privkey.pem` | PEM private key path |
| `RTSP_BIND_ADDR` | `0.0.0.0:554` | RTSP listen address |
| `RTSP_EXTRA_BIND_ADDR` | empty | Optional second RTSP listen address |
| `ALLOWED_ORIGINS` | `https://vard.cc` | Comma-separated browser origins allowed to publish |
| `ALLOW_ANY_ORIGIN` | `false` | Disable Origin protection when `true` |
| `MAX_PUBLISHERS` | `500` | Max simultaneous publishers |
| `MAX_PUBLISHERS_PER_IP` | `3` | Max simultaneous publishers from one IP; `0` disables this limit |
| `MAX_LISTENERS_TOTAL` | `2500` | Max simultaneous RTSP clients |
| `MAX_LISTENERS_PER_STREAM` | `85` | Max RTSP clients per stream |
| `MAX_HTTP_REQUESTS_PER_IP` | `120` | Max HTTP/WebSocket handshake requests from one IP per window; `0` disables this limit |
| `HTTP_RATE_LIMIT_WINDOW_SECS` | `60` | HTTP request rate-limit window |
| `MAX_TRACKED_IPS` | `8192` | Max IP entries kept by the in-memory limiter; `0` disables the cap |
| `MAX_AAC_FRAME_BYTES` | `4096` | Max WebSocket AAC access unit size |
| `MAX_INGEST_BYTES_PER_SEC` | `98304` | Average AAC ingest byte limit per publisher |
| `CHANNEL_BUFFER` | `128` | Per-stream AAC frame broadcast buffer |
| `PUBLISHER_IDLE_TIMEOUT_SECS` | `120` | Disconnect idle publishers |
| `CODE_MIN_BYTES` | `8` | Min hidden code length |
| `CODE_MAX_BYTES` | `128` | Max hidden code length |
| `RUST_LOG` | `warn` | Server log level |
