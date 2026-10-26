#!/usr/bin/env bash
# Restore ngrok as the public edge. Does not delete Cloudflare tunnel credentials or Ground data.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UID_NUM="$(id -u)"
DOMAIN="gui/${UID_NUM}"

echo "Stopping cloudflared LaunchAgent (if installed)..."
"$ROOT/scripts/uninstall-cloudflared-launchagent.sh" 2>/dev/null || true

echo "Re-enabling ngrok LaunchAgent..."
PLIST="$HOME/Library/LaunchAgents/com.groundcontrol.ngrok.plist"
if [[ ! -f "$PLIST" ]]; then
  cp "$ROOT/launchd/com.groundcontrol.ngrok.plist" "$PLIST"
fi
launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null || true
launchctl enable "$DOMAIN/com.groundcontrol.ngrok" 2>/dev/null || true
launchctl kickstart "$DOMAIN/com.groundcontrol.ngrok" 2>/dev/null || launchctl kickstart -k "$DOMAIN/com.groundcontrol.ngrok" 2>/dev/null || true

echo
echo "Ensure .env PUBLIC_BASE_URL points at your stable ngrok hostname, then restart relay and worker:"
echo "  launchctl kickstart -k $DOMAIN/com.groundcontrol.relay"
echo "  launchctl kickstart -k $DOMAIN/com.groundcontrol.worker"
echo
echo "ChatGPT MCP URL: \${PUBLIC_BASE_URL}/mcp"
