#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-VRCStreamer}"
SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SERVER_DIR"

if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo was not found. Install Rust first, then run this script again." >&2
  exit 1
fi

cargo build --release
install -m 755 "$SERVER_DIR/target/release/VRCStreamer" "$SERVER_DIR/VRCStreamer"

echo "Built $SERVER_DIR/VRCStreamer"

if command -v systemctl >/dev/null 2>&1 \
  && systemctl list-unit-files "$SERVICE_NAME.service" --no-legend 2>/dev/null | grep -q "$SERVICE_NAME.service"; then
  echo "Restarting existing service: $SERVICE_NAME"
  systemctl restart "$SERVICE_NAME"
  systemctl --no-pager --lines=20 status "$SERVICE_NAME"
else
  echo "Service is not installed yet. Configure .env, then run ./create_service.sh"
fi
