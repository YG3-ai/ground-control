#!/usr/bin/env bash
# Start relay, ngrok, and worker via launchd (install agents on first run).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_DIR="$HOME/Library/LaunchAgents"
UID_NUM="$(id -u)"
DOMAIN="gui/${UID_NUM}"
PORT="${RELAY_PORT:-8787}"

# Always refresh plists and bootstrap any missing agents without stopping running processes.
node "$ROOT/scripts/groundcontrol-launchagents.mjs" --stage \
  --root "$ROOT" \
  --launch-agents-dir "$AGENT_DIR" \
  --domain "$DOMAIN" \
  --bootstrap-missing >/dev/null

kick_label() {
  local label="$1"
  local force="${2:-0}"
  local plist="$AGENT_DIR/${label}.plist"
  if [[ "$force" == "1" ]]; then
    launchctl kickstart -k "$DOMAIN/$label" 2>/dev/null && return 0
  fi
  if launchctl kickstart "$DOMAIN/$label" 2>/dev/null; then
    return 0
  fi
  if [[ -f "$plist" ]]; then
    launchctl bootstrap "$DOMAIN" "$plist" 2>/dev/null || true
  fi
  launchctl kickstart "$DOMAIN/$label" 2>/dev/null || launchctl kickstart -k "$DOMAIN/$label" 2>/dev/null || true
}

wait_relay() {
  for _ in $(seq 1 45); do
    if curl -sf "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_worker() {
  for _ in $(seq 1 45); do
    if curl -sf "http://127.0.0.1:${PORT}/healthz" | grep -q '"connected":true'; then
      return 0
    fi
    sleep 1
  done
  return 1
}

use_cloudflared=false
if [[ -f "$AGENT_DIR/com.groundcontrol.cloudflared.plist" ]]; then
  use_cloudflared=true
fi

# Order matters: relay → tunnel → worker (worker dials relay; avoid killing relay while ChatGPT is active).
if ! curl -sf "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
  kick_label "com.groundcontrol.relay" 1
  wait_relay || kick_label "com.groundcontrol.relay" 1
  wait_relay || true
else
  kick_label "com.groundcontrol.relay" 0
fi

if $use_cloudflared; then
  kick_label "com.groundcontrol.cloudflared" 0
else
  kick_label "com.groundcontrol.ngrok" 0
fi

if ! curl -sf "http://127.0.0.1:${PORT}/healthz" | grep -q '"connected":true'; then
  kick_label "com.groundcontrol.worker" 0
  wait_worker || kick_label "com.groundcontrol.worker" 0
  wait_worker || true
else
  kick_label "com.groundcontrol.worker" 0
fi
