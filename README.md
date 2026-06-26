# VRC Audio Streamer

Minimal browser-to-RTSP audio relay for AVPro/VRChat.

## Layout

- `client/` - static browser client. Host these files on any normal static hosting.
- `client/client.js` - browser UI and streaming logic.
- `client/servers.json` - list of relay servers shown in the client dropdown.
- `server/` - Rust backend, WebSocket ingest API, stats API, and RTSP relay.

The Rust server intentionally does not host the client. Deploy the client and server separately.

## Architecture

1. Browser captures 48 kHz stereo audio with `AudioWorklet`.
2. Browser encodes AAC-LC 320 kbps in a module Worker using the vendored WASM encoder.
3. Browser sends raw AAC access units over WebSocket to `GET /ingest?code=...`.
4. Server validates and relays those raw AAC frames as RTSP/RTP `mpeg4-generic`.

The server does not run `ffmpeg`, does not transcode, and does not store stream links. The hidden code and stream URL are derived with `SHA-256(code)` on both client and server.

Output stream shape:

- RTSP path: `/live/<sha256(code)>`
- Codec: AAC-LC
- Sample rate: 48000 Hz
- Channels: stereo
- Bitrate: 320 kbps target
- RTP payload: `mpeg4-generic`, payload type `96`, `trackID=0`
- SDP config: `1190`

## Client Servers

Edit `client/servers.json` before hosting the client:

```json
[
  {
    "name": "Vard's EU Server",
    "apiBase": "https://example.com",
    "rtspBase": "rtsp://example.com"
  }
]
```

The browser uses `apiBase` for `/stats` and WebSocket `/ingest`. The generated VRChat URL uses `rtspBase`.

The client dropdown always also has `Custom`, where a user can enter custom API and RTSP addresses manually.

If the client page is hosted over HTTPS, `apiBase` should also be HTTPS/WSS-capable; otherwise browsers may block the WebSocket/fetch as mixed content. `rtspBase` is separate because AVPro/VRChat consumes that URL, not the browser.

## Run Locally

Terminal 1, backend:

```powershell
cd server
$env:BIND_ADDR='127.0.0.1:8081'
$env:RTSP_BIND_ADDR='0.0.0.0:554'
$env:RTSP_EXTRA_BIND_ADDR='0.0.0.0:8554'
$env:ALLOWED_ORIGINS='http://127.0.0.1:8080,http://localhost:8080'
cargo run --release
```

Terminal 2, static client:

```powershell
cd client
python -m http.server 8080
```

Open:

```text
http://127.0.0.1:8080/
```

The default `servers.json` points to `http://127.0.0.1:8081` and can generate either:

```text
rtsp://127.0.0.1/live/<hash>
rtsp://127.0.0.1:8554/live/<hash>
```

If binding port `554` is not available on your OS, use the `Local 8554` option.

## Simple Deploy

This deploy example uses one public domain for the client and WebSocket API:

```json
{
  "name": "Example Server",
  "apiBase": "https://example.com",
  "rtspBase": "rtsp://example.com"
}
```

Because `rtspBase` has no explicit port, AVPro/RTSP clients will use the default RTSP port `554`.

Build the server on the Linux host:

```bash
sudo mkdir -p /opt/vrc-audio-streamer
sudo chown "$USER":"$USER" /opt/vrc-audio-streamer
cp -r server /opt/vrc-audio-streamer/
cd /opt/vrc-audio-streamer/server
cargo build --release
cp .env.example .env
nano .env
```

Production `server/.env` example:

```env
BIND_ADDR=127.0.0.1:8080
RTSP_BIND_ADDR=0.0.0.0:554
RTSP_EXTRA_BIND_ADDR=
ALLOWED_ORIGINS=https://example.com
MAX_PUBLISHERS=500
MAX_LISTENERS_TOTAL=2500
MAX_LISTENERS_PER_STREAM=85
MAX_AAC_FRAME_BYTES=4096
MAX_INGEST_BYTES_PER_SEC=98304
CHANNEL_BUFFER=128
PUBLISHER_IDLE_TIMEOUT_SECS=120
CODE_MIN_BYTES=8
CODE_MAX_BYTES=128
RUST_LOG=warn
```

The server reads process environment variables. It does not load `.env` by itself. Load it from systemd or from your deploy script.

Create a systemd service:

```ini
[Unit]
Description=VRC Audio Streamer relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/vrc-audio-streamer/server
EnvironmentFile=/opt/vrc-audio-streamer/server/.env
ExecStart=/opt/vrc-audio-streamer/server/target/release/vrc-audio-streamer
Restart=always
RestartSec=2
LimitNOFILE=65535
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

Install and start it:

```bash
sudo nano /etc/systemd/system/vrc-audio-streamer.service
sudo systemctl daemon-reload
sudo systemctl enable --now vrc-audio-streamer
sudo systemctl status vrc-audio-streamer
```

Binding RTSP port `554` as a non-root service needs this once after each binary rebuild:

```bash
sudo setcap 'cap_net_bind_service=+ep' /opt/vrc-audio-streamer/server/target/release/vrc-audio-streamer
sudo systemctl restart vrc-audio-streamer
```

Host the client files separately:

```bash
sudo mkdir -p /var/www/vrc-audio-streamer/client
sudo cp -r client/* /var/www/vrc-audio-streamer/client/
```

Edit `/var/www/vrc-audio-streamer/client/servers.json`:

```json
[
  {
    "name": "Vard's EU Server",
    "apiBase": "https://example.com",
    "rtspBase": "rtsp://example.com"
  }
]
```

If you use RTSP port `8554` instead of `554`, then `rtspBase` must include it:

```json
{
  "name": "Vard's EU Server",
  "apiBase": "https://example.com",
  "rtspBase": "rtsp://example.com:8554"
}
```

## Nginx HTTPS/WSS

Yes, if the client is hosted over HTTPS, the WebSocket API should also be HTTPS/WSS. The Rust server does not terminate TLS; put nginx in front of it. With the `example.com` config above, the browser opens `https://example.com`, fetches `https://example.com/stats`, and streams to `wss://example.com/ingest`.

Place your existing certificate files on the server:

```bash
sudo mkdir -p /etc/ssl/vrc-audio-streamer
sudo cp example.com.pem /etc/ssl/vrc-audio-streamer/example.com.pem
sudo cp example.com.key /etc/ssl/vrc-audio-streamer/example.com.key
sudo chmod 600 /etc/ssl/vrc-audio-streamer/example.com.key
```

Nginx for the static client, backend API, and WebSocket on one domain:

```nginx
server {
    listen 80;
    server_name example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name example.com;

    ssl_certificate /etc/ssl/vrc-audio-streamer/example.com.pem;
    ssl_certificate_key /etc/ssl/vrc-audio-streamer/example.com.key;

    root /var/www/vrc-audio-streamer/client;
    index index.html;

    location = /servers.json {
        add_header Cache-Control "no-store";
        try_files $uri =404;
    }

    location = /client.js {
        try_files $uri =404;
    }

    location = /aac-worker.js {
        try_files $uri =404;
    }

    location /vendor/ {
        try_files $uri =404;
    }

    location /healthz {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /stats {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /ingest {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
        proxy_buffering off;
        proxy_request_buffering off;
    }

    location / {
        try_files $uri =404;
    }
}
```

RTSP is not proxied by nginx. Open the RTSP port directly in the firewall:

```bash
sudo ufw allow 443/tcp
sudo ufw allow 554/tcp
```

## Server Endpoints

- `GET /healthz` - health check.
- `GET /stats` - JSON counters: active publishers, listeners, streams.
- `GET /ingest?code=<hidden-code>` - WebSocket AAC ingest.
- `RTSP /live/<sha256>` - AVPro/VRChat playback URL.
- `RTSP /stream/<sha256>` - alternate playback path.

## Server Environment

| Name | Default | Meaning |
| --- | ---: | --- |
| `BIND_ADDR` | `0.0.0.0:8080` | HTTP API and WebSocket ingest listen address |
| `RTSP_BIND_ADDR` | `0.0.0.0:8554` | RTSP listen address |
| `RTSP_EXTRA_BIND_ADDR` | empty | Optional second RTSP listen address, useful for also binding `0.0.0.0:554` |
| `MAX_PUBLISHERS` | `500` | Max simultaneous broadcasters |
| `MAX_LISTENERS_TOTAL` | `2500` | Max simultaneous RTSP clients |
| `MAX_LISTENERS_PER_STREAM` | `85` | Max RTSP clients per stream |
| `MAX_AAC_FRAME_BYTES` | `4096` | Max WebSocket AAC access unit size |
| `MAX_INGEST_BYTES_PER_SEC` | `98304` | Average AAC ingest byte limit per publisher |
| `CHANNEL_BUFFER` | `128` | Per-stream AAC frame broadcast buffer |
| `PUBLISHER_IDLE_TIMEOUT_SECS` | `120` | Disconnect idle publishers |
| `CODE_MIN_BYTES` | `8` | Min code length |
| `CODE_MAX_BYTES` | `128` | Max code length |
| `ALLOWED_ORIGINS` | empty | Comma-separated allowed browser origins |
| `ALLOW_ANY_ORIGIN` | `false` | Disable Origin protection when set to `true` |

## Abuse Limits

- One active publisher per code/hash.
- Codes are printable ASCII only, 8 to 128 bytes by default.
- Stream IDs must be 64 hex chars.
- WebSocket publishers may send binary messages only.
- WebSocket binary messages must be raw AAC access units, not ADTS, video, or container data.
- Input byte rate and frame size are bounded.
- Slow RTSP clients drop old queued frames instead of growing latency.
- Offline streams fail at RTSP `SETUP` and do not create channels.

## Vendored WASM

`client/vendor/mediabunny-aac.js` is the AAC encoder build from `@mediabunny/aac-encoder`, transformed from CommonJS to a browser ESM default export so it can be loaded by `client/aac-worker.js` without a bundler.

The vendored encoder is MPL-2.0 licensed; the license text is included at `client/vendor/mediabunny-aac.LICENSE.txt`.
