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

The values below match `.env.example` and the server's built-in defaults.

| Name | Meaning |
| --- | --- |
| `SERVER_NAME` | Server name shown by the web client<br>Default value: `Self-Hosted Instance` |
| `SERVER_DESCRIPTION` | Optional server description sent to the web client<br>Default value: empty |
| `ROOT_REDIRECT_URL` | Destination for visitors who open the API root `/` in a browser<br>Default value: `https://stream.vard.cc` |
| `BIND_ADDR` | Address and port used by the HTTP/HTTPS API and streamer WebSocket<br>Default value: `0.0.0.0:443` |
| `TLS_CERT_PATH` | Path to the PEM certificate; set both TLS paths to `none` to disable TLS<br>Default value: `/etc/letsencrypt/live/example.com/fullchain.pem` |
| `TLS_KEY_PATH` | Path to the PEM private key; set both TLS paths to `none` to disable TLS<br>Default value: `/etc/letsencrypt/live/example.com/privkey.pem` |
| `RTSP_BIND_ADDR` | Address and port used by RTSP listeners<br>Default value: `0.0.0.0:554` |
| `RTSP_PUBLIC_BASE` | Public RTSPT base URL sent to clients; `none` derives it from the API hostname and RTSP port<br>Default value: `none` |
| `ALLOWED_ORIGINS` | Comma-separated web client origins allowed to publish streams<br>Default value: `https://stream.vard.cc` |
| `ALLOW_ANY_ORIGIN` | Allow publishing from any website; keep this `false` unless you specifically need it<br>Default value: `false` |
| `PASSWORD` | Optional comma-separated publishing passwords; listeners do not need a password<br>Default value: empty |
| `VIDEO` | Enable H.264 video publishing; `false` restricts publishers to audio<br>Default value: `true` |
| `AVALIABLE_VIDEO_QUALITY` | Video presets in `widthxheight*fps/bitrate-kbps` format; each preset's bitrate is also its sustained ingest limit<br>Default value: <code>1280x720&#42;30/2000,<br>1280x720&#42;60/4000,<br>1920x1080&#42;30/3000,<br>1920x1080&#42;60/6000</code> |
| `MAX_CONNECTIONS` | Maximum active streamers and RTSP listeners combined. Set to `0` to disable this limit<br>Default value: `320` |
| `MAX_STREAMERS` | Maximum active streamers. Set to `0` to disable this limit<br>Default value: `0` |
| `MAX_STREAMERS_PER_IP` | Maximum active streamers from one IP address. Set to `0` to disable this limit<br>Default value: `3` |
| `MAX_LISTENERS_TOTAL` | Maximum active RTSP listeners across all streams. Set to `0` to disable this limit<br>Default value: `0` |
| `MAX_LISTENERS_PER_STREAM` | Maximum RTSP listeners on one stream URL. Set to `0` to disable this limit<br>Default value: `105` |
| `MAX_LISTENERS_PER_IP` | Maximum active RTSP listeners from one IP address. Set to `0` to disable this limit<br>Default value: `6` |
| `EGRESS_KBPS_PER_LISTENER` | Per-listener value used only to estimate outgoing bandwidth in server statistics<br>Default value: `384` |
| `MAX_HTTP_REQUESTS_PER_IP` | Maximum `/healthz`, `/stats`, and `/ingest` handshake requests from one IP per rate-limit window. Set to `0` to disable this limit<br>Default value: `60` |
| `HTTP_RATE_LIMIT_WINDOW_SECS` | HTTP rate-limit window in seconds<br>Default value: `60` |
| `MAX_RTSP_REQUESTS_PER_CONNECTION` | Maximum RTSP commands on one TCP connection, including playback setup and keepalives. Set to `0` to disable this limit<br>Default value: `4096` |
| `RTSP_HANDSHAKE_TIMEOUT_SECS` | Seconds allowed for a new RTSP connection to complete `SETUP`<br>Default value: `30` |
| `CHANNEL_BUFFER` | Shared frame queue per stream; larger values tolerate more listener jitter but retain more media in memory<br>Default value: `128` |
| `STREAMER_IDLE_TIMEOUT_SECS` | Disconnect a streamer after this many seconds without a WebSocket message<br>Default value: `120` |
| `RUST_LOG` | Server log level, such as `error`, `warn`, `info`, or `debug`<br>Default value: `warn` |
