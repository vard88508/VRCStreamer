# VRCast

WebSocket-to-RTSP audio/video server for VRChat.

This installation guide has only been tested on Debian 13. All commands below assume that you are using the root user.

## 1. Install Rust

```bash
apt install -y curl build-essential
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
. "$HOME/.cargo/env"
```

## 2. Clone and Build

Clone the repository into the directory where you want to keep the server, then build it:

```bash
git clone https://github.com/vard88508/VRCast.git
cd VRCast/server
chmod +x build.sh create_service.sh kill_service.sh
./build.sh
```

The compiled executable is written to `VRCast/server/VRCast`.

## 3. Configure the Server

Create your local `.env` file from the provided example:

```bash
cp .env.example .env
nano .env
```

Alternatively, name the file `VRCast.conf`; it uses the same `KEY=value` format. Both files are optional and are read once at startup from the server's working directory (the executable's directory when using the service).

Priority, from highest to lowest: process environment variables, `.env`, `VRCast.conf`, built-in defaults. `.env` only overrides keys it contains; an explicitly empty value also overrides the lower-priority file. Invalid or unreadable files stop startup rather than silently falling back. Restart the service after changing settings.

Use one `KEY=value` per line, with comments on separate lines starting with `#`. Unquoted values are literal, so spaces, `$`, `#` and Windows paths do not need escaping. Optional single quotes preserve the text inside; double quotes support JSON escapes such as `\"` and `\\`. Shell commands and variable expansion are not supported.

When switching an existing installation to `VRCast.conf` without `.env`, rerun `./create_service.sh` to update the service definition. The server now reads both files itself.

Before starting the server, check your TLS path settings:

- `TLS_CERT_PATH` and `TLS_KEY_PATH`: paths to the certificate and private key for your API domain. You can make them using Certbot

The complete list of settings is available in the [Environment](#environment) section.

## 4. Install the Service

```bash
./create_service.sh
```

The script creates `/etc/systemd/system/VRCast.service`, enables automatic startup, and starts the server.

Useful commands:

```bash
systemctl status VRCast
systemctl restart VRCast
journalctl -u VRCast -f
```

To stop the server and remove its systemd service:

```bash
./kill_service.sh
```

This does not delete the executable, `.env`, `VRCast.conf` or source files.

## 5. Start Streaming

Open [vrcast.net](https://vrcast.net), choose `Custom Server`, and enter your server's API address:

```text
https://example.com
```

Choose **Audio** or **Audio + Video**, select the encoder and video preset, then choose a source to start. The mode and encoding settings remain fixed until Stop. You can still change sources, volume and mute while streaming.

The copied URL uses `rtspt://host/stream-id/audio` in Audio mode and `rtspt://host/stream-id` in Video mode. The `/audio` suffix is a playback option: it plays only audio from either type of stream. Without the suffix, the player receives the active stream's tracks.

Audio-only playback stays connected with silence while the streamer is offline. Video playback ends when that streamer disconnects; reconnect the player to join the next session. A bare URL opened while no video is active must also be reopened when video starts. There are no server-side image placeholders. In Video mode, a missing or hidden source is replaced by the client's image, encoded through the same video pipeline.

## Architecture

- `client/scripts/client.js`: settings, storage, server discovery and application events.
- `client/scripts/ui.js` and `client/lang/`: rendering and translations.
- `client/scripts/streamer.js`: capture, audio mixing, session lifecycle and WebSocket transport.
- `audio-worklet.js`, `aac-worker.js`, `video-worker.js`: audio clock, AAC encoding, and normalized H.264 video with adaptive quantization.
- `server/src/main.rs`: startup, HTTP API and shared stream state.
- `config.rs`: configuration files, environment overrides, defaults and video presets.
- `websocket.rs`: authenticated publishing, validation and ingest limits.
- `rtsp.rs`: playback sessions and RTP/RTCP over TCP; no transcoding.
- `media.rs`, `limits.rs`, `tests.rs`: frame parsing, admission/rate limits, and server tests.

Media buffers are shared between listeners, with bounded per-stream queues. Slow listeners discard stale media; video resumes at a keyframe rather than replaying an old queue. Audio and video use the same audio-driven timeline. Socket disconnects release admission reservations automatically.

Each RTSP connection allows 16 incoming control messages per second, with a burst capacity of 32. This includes RTSP commands and interleaved client RTCP, not outgoing media packets. Excess traffic closes that connection; normal keepalives do not impose a maximum playback duration.

RTSP response and media writes have a 10-second deadline, including time waiting for the socket writer. A stalled write closes only that listener's connection; partially written packets are never skipped and followed by more media on the same connection.

### HTTP and WebSocket

- `GET /status`: plain `ok`.
- `GET /info`: `name`, `description`, `rtsp_base`, `video`, `video_qualities`, and the four counters `audio_streams`, `video_streams`, `audio_listeners`, `video_listeners`. `official_public` is present only when true. Totals are sums of the respective counters; pending handshakes still count toward admission limits.
- `GET /stream?code=...&password=...`: WebSocket upgrade. The password is optional. The first message, within 10 seconds, must be one of:

```json
{"mode":"audio"}
```

```json
{"mode":"video","video_quality":"1280x720*30/2000"}
```

The video preset must exactly match one advertised by `/info`. The server replies with `{"type":"ready","listeners":0}`, then sends `listeners` updates when that count changes. All subsequent client messages are binary media: one type byte (`0` AAC, `1` H.264 IDR, `2` H.264 delta), a big-endian 32-bit source timestamp, then the access unit. AAC timestamps use 48 kHz; H.264 timestamps use 90 kHz. The initial video keyframe must include SPS/PPS. Sending video in Audio mode or attempting to reconfigure the connection is rejected.

Unknown HTTP paths return a `302` redirect to `ROOT_REDIRECT_URL`. All HTTP paths, including redirects and rejected upgrades, share the per-IP request limit.

HTTP/1 request headers must arrive within 10 seconds. This deadline ends at the WebSocket upgrade; it does not limit stream duration. `MAX_CONNECTIONS` covers streamer WebSockets and RTSP sockets, not pending HTTP/TLS connections, so public deployments also need connection limits at the firewall or reverse proxy.

### 3.0 Migration

The executable and systemd service are now named `VRCast`. Stop and disable the previously named service before building and installing the new one. Update existing `ROOT_REDIRECT_URL` and `ALLOWED_ORIGINS` settings to use `https://vrcast.net` where appropriate; existing `.env` files are not overwritten.

Browser settings are migrated to the new storage prefix on the same origin. Moving to a different domain does not transfer local browser settings or saved servers.

Deploy the client and server together: the old endpoints and runtime reconfiguration commands are removed. Remove `POLICIES_LINK`, `REPORT_ABUSE_LINK`, and `EGRESS_KBPS_PER_LISTENER` from existing environments. Use `AVAILABLE_VIDEO_QUALITY` (the old misspelling is no longer supported). Server placeholder files are no longer used. Update health checks to `/status`.

Remove `ALLOW_ANY_ORIGIN`; use `ALLOWED_ORIGINS=*` only when publishing from any website is intended. Explicit origin lists still work as before. Remove `MAX_RTSP_REQUESTS_PER_CONNECTION`; RTSP now uses an internal per-connection rate limit instead of a lifetime command count.

## Updating

```bash
cd VRCast
git pull
cd server
./build.sh
```

If the systemd service is installed, `build.sh` automatically restarts it after a successful build.

## Stream Blacklist

To block publishing to specific stream URLs, create `blacklist.txt` next to the `VRCast` executable. Add the 32-character stream IDs from the URLs, separated by semicolons or new lines:

```text
a85c0211c512828c4c52dc5716a79e3a;1dd5a1d78b07336b21496ccf7bf79b8a
```

The server reloads the file every minute. Newly blocked streamers are disconnected, and their IP addresses are blocked from starting new streams. Attempting to publish to an already blocked stream ID also blocks that streamer's IP. Each IP block is linked to the stream IDs that caused it: removing an ID releases its IPs unless another blacklisted ID also blocks them. Removing the file or leaving it empty clears both the stream ID blacklist and its IP blocks. Invalid updates are ignored so the previous valid list remains active.

IP blocks are stored only in RAM and cleared on restart. Other active streams from the same IP and RTSP listeners are unaffected. Logs identify connections with anonymous peer IDs, without exposing IP addresses.

The server stores at most 65,536 stream ID/IP associations. If another association cannot be stored, new streams are rejected until all IDs that overflowed this limit are removed from the blacklist or the server restarts.

## Environment

The values below match `.env.example` and the server's built-in defaults. The same keys work in `VRCast.conf`, `.env`, or the process environment.

| Name | Meaning |
| --- | --- |
| `SERVER_NAME` | Server name shown by the web client<br>Default value: `Self-Hosted Instance` |
| `SERVER_DESCRIPTION` | Optional server description sent to the web client<br>Default value: empty |
| `OFFICIAL_PUBLIC` | Show the client's fixed Policies and Report Abuse links. Only `true` is included in `/info`; false or unset is omitted<br>Default value: `false` |
| `ROOT_REDIRECT_URL` | 302 redirect destination for any unimplemented HTTP path<br>Default value: `https://vrcast.net` |
| `BIND_ADDR` | Address and port used by the HTTP/HTTPS API and streamer WebSocket<br>Default value: `0.0.0.0:443` |
| `TLS_CERT_PATH` | Path to the PEM certificate; set both TLS paths to `none` to disable TLS<br>Default value: `/etc/letsencrypt/live/example.com/fullchain.pem` |
| `TLS_KEY_PATH` | Path to the PEM private key; set both TLS paths to `none` to disable TLS<br>Default value: `/etc/letsencrypt/live/example.com/privkey.pem` |
| `RTSP_BIND_ADDR` | Address and port used by RTSP listeners<br>Default value: `0.0.0.0:554` |
| `RTSP_PUBLIC_BASE` | Public RTSPT base URL sent to clients; `none` derives it from the API hostname and RTSP port<br>Default value: `none` |
| `ALLOWED_ORIGINS` | Comma-separated web client origins allowed to publish streams. Use `*` to allow any origin; prefer explicit origins for public deployments<br>Default value: `https://vrcast.net` |
| `PASSWORD` | Optional comma-separated publishing passwords; listeners do not need a password<br>Default value: empty |
| `VIDEO` | Enable H.264 video publishing; `false` restricts publishers to audio<br>Default value: `true` |
| `AVAILABLE_VIDEO_QUALITY` | Video presets in `widthxheight*fps/bitrate-kbps` format; each preset's bitrate is also its sustained ingest limit<br>Default value: <code>1280x720&#42;30/2000,<br>1280x720&#42;60/4000,<br>1920x1080&#42;30/3000,<br>1920x1080&#42;60/6000</code> |
| `MAX_H264_FRAME_BYTES` | Maximum size of one H.264 access unit. Values above `8388608` are rejected to bound single-message memory use<br>Default value: `524288` |
| `VIDEO_INGEST_BURST_SECS` | Video byte/frame token-bucket capacity measured in seconds at the selected preset. Higher values allow longer short-term delivery spikes without changing the encoder target or allocating a media queue<br>Default value: `2` |
| `MAX_CONNECTIONS` | Maximum concurrent streamer WebSockets and accepted RTSP connections, including pending RTSP handshakes. Set to `0` to disable this limit<br>Default value: `320` |
| `MAX_STREAMERS` | Maximum active streamers. Set to `0` to disable this limit<br>Default value: `0` |
| `MAX_STREAMERS_PER_IP` | Maximum active streamers from one IP address. Set to `0` to disable this limit<br>Default value: `3` |
| `MAX_LISTENERS_TOTAL` | Maximum active RTSP listeners across all streams. Set to `0` to disable this limit<br>Default value: `0` |
| `MAX_LISTENERS_PER_STREAM` | Maximum RTSP listeners on one stream URL. Set to `0` to disable this limit<br>Default value: `105` |
| `MAX_LISTENERS_PER_IP` | Maximum accepted RTSP connections from one IP address, including pending handshakes. Set to `0` to disable this limit<br>Default value: `6` |
| `MAX_HTTP_REQUESTS_PER_IP` | Maximum HTTP requests, including `/status`, `/info`, `/stream` handshakes and unknown paths, from one IP per rate-limit window. Set to `0` to disable this limit<br>Default value: `60` |
| `HTTP_RATE_LIMIT_WINDOW_SECS` | HTTP rate-limit window in seconds<br>Default value: `60` |
| `RTSP_HANDSHAKE_TIMEOUT_SECS` | Seconds allowed for a new RTSP connection to complete setup and start playback<br>Default value: `30` |
| `CHANNEL_BUFFER` | Shared frame queue per stream, not per listener; larger values tolerate more listener jitter but retain more media in memory for every active stream<br>Default value: `128` |
| `STREAMER_IDLE_TIMEOUT_SECS` | Disconnect a streamer after this many seconds without valid media (ping and control messages do not reset it)<br>Default value: `120` |
| `RUST_LOG` | Server log level, such as `error`, `warn`, `info`, `debug`, or `trace`; `trace` also logs RTSP request headers with sensitive values redacted<br>Default value: `warn` |
