# VRCStreamer

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
git clone https://github.com/vard88508/VRCStreamer.git
cd VRCStreamer/server
chmod +x build.sh create_service.sh kill_service.sh
./build.sh
```

The compiled executable is written to `VRCStreamer/server/VRCStreamer`.

## 3. Configure the Server

Create your local `.env` file from the provided example:

```bash
cp .env.example .env
nano .env
```

Before starting the server, check your TLS path settings:

- `TLS_CERT_PATH` and `TLS_KEY_PATH`: paths to the certificate and private key for your API domain. You can make them using Certbot

The complete list of settings is available in the [Environment](#environment) section.

## 4. Install the Service

```bash
./create_service.sh
```

The script creates `/etc/systemd/system/VRCStreamer.service`, enables automatic startup, and starts the server.

Useful commands:

```bash
systemctl status VRCStreamer
systemctl restart VRCStreamer
journalctl -u VRCStreamer -f
```

To stop the server and remove its systemd service:

```bash
./kill_service.sh
```

This does not delete the executable, `.env`, placeholders, or source files.

## 5. Start Streaming

Open [stream.vard.cc](https://stream.vard.cc), choose `Custom Server`, and enter your server's API address:

```text
https://example.com
```

## Updating

```bash
cd VRCStreamer
git pull
cd server
./build.sh
```

If the systemd service is installed, `build.sh` automatically restarts it after a successful build.

## Environment

The values below match `.env.example` and the server's built-in defaults. A limit of `0` disables that specific limit unless stated otherwise.

| Name | Default | Meaning |
| --- | ---: | --- |
| `SERVER_NAME` | `Self-Hosted Instance` | Server name shown by the web client |
| `SERVER_DESCRIPTION` | empty | Optional server description sent to the web client |
| `ROOT_REDIRECT_URL` | `https://stream.vard.cc` | Destination for visitors who open the API root `/` in a browser |
| `BIND_ADDR` | `0.0.0.0:443` | Address and port used by the HTTP/HTTPS API and streamer WebSocket |
| `TLS_CERT_PATH` | <code>/etc/letsencrypt/live/<br>example.com/fullchain.pem</code> | Path to the PEM certificate; set both TLS paths to `none` to disable TLS |
| `TLS_KEY_PATH` | <code>/etc/letsencrypt/live/<br>example.com/privkey.pem</code> | Path to the PEM private key; set both TLS paths to `none` to disable TLS |
| `RTSP_BIND_ADDR` | `0.0.0.0:554` | Address and port used by RTSP listeners |
| `RTSP_PUBLIC_BASE` | `none` | Public RTSPT base URL sent to clients; `none` derives it from the API hostname and RTSP port |
| `ALLOWED_ORIGINS` | `https://stream.vard.cc` | Comma-separated web client origins allowed to publish streams |
| `ALLOW_ANY_ORIGIN` | `false` | Allow publishing from any website; keep this `false` unless you specifically need it |
| `PASSWORD` | empty | Optional comma-separated publishing passwords; listeners do not need a password |
| `VIDEO` | `true` | Enable H.264 video publishing; `false` restricts publishers to audio |
| `AVALIABLE_VIDEO_QUALITY` | <code>1280x720*30/2000,<br>1280x720*60/4000,<br>1920x1080*30/3000,<br>1920x1080*60/6000</code> | Video presets in `widthxheight*fps/bitrate-kbps` format; each preset's bitrate is also its sustained ingest limit |
| `MAX_CONNECTIONS` | `320` | Maximum active streamers and RTSP listeners combined |
| `MAX_STREAMERS` | `0` | Maximum active streamers |
| `MAX_STREAMERS_PER_IP` | `3` | Maximum active streamers from one IP address |
| `MAX_LISTENERS_TOTAL` | `0` | Maximum active RTSP listeners across all streams |
| `MAX_LISTENERS_PER_STREAM` | `105` | Maximum RTSP listeners on one stream URL |
| `MAX_LISTENERS_PER_IP` | `6` | Maximum active RTSP listeners from one IP address |
| `EGRESS_KBPS_PER_LISTENER` | `384` | Per-listener value used only to estimate outgoing bandwidth in server statistics |
| `MAX_HTTP_REQUESTS_PER_IP` | `60` | Maximum `/healthz`, `/stats`, and `/ingest` handshake requests from one IP per rate-limit window |
| `HTTP_RATE_LIMIT_WINDOW_SECS` | `60` | HTTP rate-limit window in seconds |
| `MAX_RTSP_REQUESTS_PER_CONNECTION` | `4096` | Maximum RTSP commands on one TCP connection, including playback setup and keepalives |
| `RTSP_HANDSHAKE_TIMEOUT_SECS` | `30` | Seconds allowed for a new RTSP connection to complete `SETUP` |
| `CHANNEL_BUFFER` | `128` | Shared frame queue per stream; larger values tolerate more listener jitter but retain more media in memory |
| `STREAMER_IDLE_TIMEOUT_SECS` | `120` | Disconnect a streamer after this many seconds without a WebSocket message |
| `RUST_LOG` | `warn` | Server log level, such as `error`, `warn`, `info`, or `debug` |
