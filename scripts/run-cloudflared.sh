#!/usr/bin/env bash
# Foreground Cloudflare Tunnel for launchd KeepAlive.
# Exposes only the relay (127.0.0.1:8787), never the worker local port.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CONFIG="${CLOUDFLARED_CONFIG:-$HOME/.cloudflared/config.yml}"
TUNNEL_NAME="${CLOUDFLARED_TUNNEL_NAME:-ground-control}"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared not found. Install: brew install cloudflared" >&2
  exit 1
fi
if [[ ! -f "$CONFIG" ]]; then
  echo "Missing $CONFIG — complete tunnel login and copy config/cloudflared.yml.example" >&2
  exit 1
fi

mkdir -p "$ROOT/logs"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
exec cloudflared tunnel --config "$CONFIG" run "$TUNNEL_NAME"
