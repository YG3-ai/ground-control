#!/usr/bin/env bash
# Install cloudflared LaunchAgent only (does not disable ngrok or change DNS).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_DIR="$HOME/Library/LaunchAgents"
UID_NUM="$(id -u)"
DOMAIN="gui/${UID_NUM}"
LABEL="com.groundcontrol.cloudflared"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "Install cloudflared first: brew install cloudflared" >&2
  exit 1
fi
if [[ ! -f "$HOME/.cloudflared/config.yml" ]]; then
  echo "Missing ~/.cloudflared/config.yml — see docs/CLOUDFLARE_TUNNEL.md" >&2
  exit 1
fi

mkdir -p "$AGENT_DIR" "$ROOT/logs"
chmod +x "$ROOT/scripts/run-cloudflared.sh" "$ROOT/scripts/render-launchd-plist.sh"

"$ROOT/scripts/render-launchd-plist.sh" "$LABEL" > "$AGENT_DIR/${LABEL}.plist"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$AGENT_DIR/${LABEL}.plist"
launchctl enable "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl kickstart "$DOMAIN/$LABEL" 2>/dev/null || launchctl kickstart -k "$DOMAIN/$LABEL" 2>/dev/null || true
echo "Installed $LABEL (ngrok LaunchAgent unchanged until you disable it after verification)."
