#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="VRCast"
SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$SERVER_DIR/VRCast"
ENV_FILE="$SERVER_DIR/.env"
CONF_FILE="$SERVER_DIR/VRCast.conf"
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

if [ ! -f "$ENV_FILE" ] && [ ! -f "$CONF_FILE" ]; then
  if [ -f "$SERVER_DIR/.env.example" ]; then
    cp "$SERVER_DIR/.env.example" "$ENV_FILE"
  fi
  echo "Created $ENV_FILE. Edit it, then run ./create_service.sh again." >&2
  exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this script as root." >&2
  exit 1
fi

tee "$UNIT_FILE" >/dev/null <<SERVICE
[Unit]
Description=VRCast
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$SERVER_DIR
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

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"
systemctl --no-pager --lines=30 status "$SERVICE_NAME"
