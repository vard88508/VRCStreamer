# VRC Audio Streamer Server

Minimal Rust WebSocket-to-RTSP audio relay for AVPro/VRChat.

This server deploy guide has only been checked on Debian.

## 1. Install Rust

```bash
sudo apt install -y curl build-essential
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
. "$HOME/.cargo/env"
```

If `git` is not installed on the server:

```bash
sudo apt install -y git
```

## 2. Clone And Build

```bash
sudo mkdir -p /opt
cd /opt
sudo git clone https://github.com/vard88508/VRCStreamer.git vrc-audio-streamer
sudo chown -R "$USER":"$USER" /opt/vrc-audio-streamer
cd /opt/vrc-audio-streamer/server
chmod +x build.sh create_service.sh
./build.sh
```

`build.sh` compiles the Rust server and copies the executable to:

```text
/opt/vrc-audio-streamer/server/vrc-audio-streamer
```

If the `vrc-audio-streamer` systemd service already exists, `build.sh` restarts it after a successful build.

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

Use your real domain in `TLS_CERT_PATH`, `TLS_KEY_PATH`, and `ALLOWED_ORIGINS`.

## 4. Create Service

```bash
./create_service.sh
```

The script writes `/etc/systemd/system/vrc-audio-streamer.service`, enables it, and starts/restarts the service.

Check logs:

```bash
journalctl -u vrc-audio-streamer -f
```

Open firewall ports:

```bash
sudo ufw allow 443/tcp
sudo ufw allow 554/tcp
```

Smoke test:

```bash
curl https://example.com/healthz
curl https://example.com/stats
```

## Updating

```bash
cd /opt/vrc-audio-streamer
git pull
cd server
./build.sh
```

## Environment

| Name | Default | Meaning |
| --- | ---: | --- |
| `BIND_ADDR` | `0.0.0.0:8080` | HTTP/HTTPS API and WebSocket ingest listen address |
| `TLS_CERT_PATH` | empty | PEM certificate path; enables HTTPS/WSS with `TLS_KEY_PATH` |
| `TLS_KEY_PATH` | empty | PEM private key path; enables HTTPS/WSS with `TLS_CERT_PATH` |
| `RTSP_BIND_ADDR` | `0.0.0.0:8554` | RTSP listen address |
| `RTSP_EXTRA_BIND_ADDR` | empty | Optional second RTSP listen address |
| `ALLOWED_ORIGINS` | empty | Comma-separated browser origins allowed to publish |
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

## Endpoints

- `GET /healthz` - health check.
- `GET /stats` - JSON counters: active listeners and streams.
- `GET /ingest?code=<hidden-code>` - WebSocket raw AAC ingest.
- `RTSP /<hash32>` - AVPro/VRChat playback URL.

On fatal server errors and panics, the service logs the error reason plus the current listener count and stream count when available.
