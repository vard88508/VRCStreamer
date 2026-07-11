#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-VRCStreamer}"
UNIT_FILE="/etc/systemd/system/$SERVICE_NAME.service"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this script as root." >&2
  exit 1
fi

case "$SERVICE_NAME" in
  *[!A-Za-z0-9_.@-]* | "")
    echo "Invalid service name: $SERVICE_NAME" >&2
    exit 1
    ;;
esac

if [ ! -f "$UNIT_FILE" ]; then
  echo "Service is not installed: $SERVICE_NAME"
  exit 0
fi

systemctl disable --now "$SERVICE_NAME.service"
rm -f -- "$UNIT_FILE"
systemctl daemon-reload
systemctl reset-failed "$SERVICE_NAME.service" 2>/dev/null || true

echo "Removed service: $SERVICE_NAME"
