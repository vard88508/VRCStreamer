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
2. The main page transfers PCM blocks to `client/aac-worker.js`.
3. The Worker encodes AAC-LC with native WebCodecs AAC when available, otherwise with the vendored WASM encoder. The WASM path targets 320 kbps; the native path tries 320 kbps first and may choose a lower browser-supported AAC bitrate such as 192 kbps on Windows.
4. Browser sends raw AAC access units over WebSocket to `GET /ingest?code=...`.
5. Server validates and relays those raw AAC frames as RTSP/RTP `mpeg4-generic`.

The server does not run `ffmpeg`, does not transcode, and does not store stream links. The hidden code and stream URL are derived with `SHA-256(code)` on both client and server.

Output stream shape:

- RTSP path: `/live/<sha256(code)>`
- Codec: AAC-LC
- Sample rate: 48000 Hz
- Channels: stereo
- Bitrate: 320 kbps target for WASM; native WebCodecs may use a lower browser-supported AAC bitrate
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

During streaming, the status text shows whether the browser is using native WebCodecs AAC or the WASM fallback. Native AAC support is browser/platform dependent even when `AudioEncoder` exists; on Windows, Chromium may reject 320 kbps because the system AAC encoder supports a limited bitrate set. The client tries lower native bitrates before falling back to WASM 320 kbps and shows the exact reason when fallback is used.

Keep the streaming tab visible for the most stable realtime output. Chromium can throttle or freeze hidden/minimized tabs at the browser's discretion. The client requests a screen wake lock and keeps a very quiet monitor output connected to reduce background throttling, but a web page cannot force realtime priority when fully minimized. For guaranteed background streaming, use a native desktop encoder instead of a browser page.

The AAC encoder runs in a module Worker so WebCodecs/WASM work and PCM conversion stay off the page's main thread.

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

## Simple Deploy Without Nginx

The Rust backend can terminate HTTPS/WSS directly. No nginx is required for `/stats` or `/ingest`.

Example `client/servers.json` entry:

```json
{
  "name": "Vard's EU Server",
  "apiBase": "https://example.com",
  "rtspBase": "rtsp://example.com"
}
```

Because `rtspBase` has no explicit port, AVPro/RTSP clients will use the default RTSP port `554`.

Important: the Rust server still does not host `client/`. Host `client/` on static HTTPS hosting. Set `ALLOWED_ORIGINS` to the exact origin where the client page is opened. If the client is opened at `https://example.com`, use `ALLOWED_ORIGINS=https://example.com`.

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

Place your existing certificate files on the server:

```bash
sudo mkdir -p /etc/ssl/vrc-audio-streamer
sudo cp example.com.pem /etc/ssl/vrc-audio-streamer/example.com.pem
sudo cp example.com.key /etc/ssl/vrc-audio-streamer/example.com.key
sudo chmod 600 /etc/ssl/vrc-audio-streamer/example.com.key
```

Production `server/.env` example:

```env
BIND_ADDR=0.0.0.0:443
TLS_CERT_PATH=/etc/ssl/vrc-audio-streamer/example.com.pem
TLS_KEY_PATH=/etc/ssl/vrc-audio-streamer/example.com.key
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

Ports `443` and `554` are privileged ports on Linux. Give the binary bind permission once after each rebuild:

```bash
sudo setcap 'cap_net_bind_service=+ep' /opt/vrc-audio-streamer/server/target/release/vrc-audio-streamer
```

Install and start it:

```bash
sudo nano /etc/systemd/system/vrc-audio-streamer.service
sudo systemctl daemon-reload
sudo systemctl enable --now vrc-audio-streamer
sudo systemctl status vrc-audio-streamer
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

If you use RTSP port `8554` instead of `554`, then change `RTSP_BIND_ADDR` and include the port in `rtspBase`:

```env
RTSP_BIND_ADDR=0.0.0.0:8554
```

```json
{
  "name": "Vard's EU Server",
  "apiBase": "https://example.com",
  "rtspBase": "rtsp://example.com:8554"
}
```

If `TLS_CERT_PATH` and `TLS_KEY_PATH` are not set, the API runs as plain HTTP/WS. That is useful for local tests, but not for a public HTTPS client because browsers can block non-secure WebSocket connections from HTTPS pages.

## Server Endpoints

- `GET /healthz` - health check.
- `GET /stats` - JSON counters: active publishers, listeners, streams.
- `GET /ingest?code=<hidden-code>` - WebSocket AAC ingest.
- `RTSP /live/<sha256>` - AVPro/VRChat playback URL.
- `RTSP /stream/<sha256>` - alternate playback path.

## Server Environment

| Name | Default | Meaning |
| --- | ---: | --- |
| `BIND_ADDR` | `0.0.0.0:8080` | HTTP/HTTPS API and WebSocket ingest listen address |
| `TLS_CERT_PATH` | empty | PEM certificate path; enables HTTPS/WSS when set with `TLS_KEY_PATH` |
| `TLS_KEY_PATH` | empty | PEM private key path; enables HTTPS/WSS when set with `TLS_CERT_PATH` |
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

`client/vendor/mediabunny-aac.js` is the fallback AAC encoder build from `@mediabunny/aac-encoder`, transformed from CommonJS to a browser ESM default export so it can be loaded by `client/aac-worker.js` without a bundler.

The vendored encoder is MPL-2.0 licensed; the license text is included at `client/vendor/mediabunny-aac.LICENSE.txt`.
