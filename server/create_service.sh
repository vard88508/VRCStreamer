#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-vrc-audio-streamer}"
SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$SERVER_DIR/vrc-audio-streamer"
ENV_FILE="$SERVER_DIR/.env"
UNIT_FILE="/etc/systemd/system/$SERVICE_NAME.service"

case "$SERVER_DIR" in
  *[[:space:]]*)
    echo "Install path must not contain spaces: $SERVER_DIR" >&2
    exit 1
    ;;
esac

if [ ! -x "$BIN" ]; then
  echo "Missing executable: $BIN" >&2
  echo "Run ./build.sh first." >&2
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  if [ -f "$SERVER_DIR/.env.example" ]; then
    cp "$SERVER_DIR/.env.example" "$ENV_FILE"
  fi
  echo "Created $ENV_FILE. Edit it, then run ./create_service.sh again." >&2
  exit 1
fi

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  SUDO="sudo"
fi

$SUDO tee "$UNIT_FILE" >/dev/null <<SERVICE
[Unit]
Description=VRC Audio Streamer relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$SERVER_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$BIN
Restart=always
RestartSec=2
LimitNOFILE=65535
NoNewPrivileges=true
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
SERVICE

$SUDO systemctl daemon-reload
$SUDO systemctl enable "$SERVICE_NAME"
$SUDO systemctl restart "$SERVICE_NAME"
$SUDO systemctl --no-pager --lines=30 status "$SERVICE_NAME"
