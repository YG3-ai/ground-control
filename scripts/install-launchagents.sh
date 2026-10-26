#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_DIR="$HOME/Library/LaunchAgents"
UID_NUM="$(id -u)"
DOMAIN="gui/${UID_NUM}"
MODE="${1:-}"

mkdir -p "$AGENT_DIR" "$ROOT/logs"
chmod +x "$ROOT/scripts"/run-*.sh "$ROOT/scripts"/ensure-services.sh "$ROOT/scripts"/install-launchagents.sh "$ROOT/scripts"/uninstall-launchagents.sh "$ROOT/scripts"/install-cloudflared-launchagent.sh "$ROOT/scripts"/uninstall-cloudflared-launchagent.sh "$ROOT/scripts"/status-tunnel.sh "$ROOT/scripts"/rollback-to-ngrok.sh "$ROOT/scripts"/render-launchd-plist.sh "$ROOT/scripts"/worker-instance-lock.mjs 2>/dev/null || true

stage_plists() {
  node "$ROOT/scripts/groundcontrol-launchagents.mjs" --stage \
    --root "$ROOT" \
    --launch-agents-dir "$AGENT_DIR" \
    --domain "$DOMAIN" \
    --bootstrap-missing
}

if [[ "$MODE" == "--stage" || "$MODE" == "--plists-only" ]]; then
  stage_plists
  echo
  echo "LaunchAgent plists rendered under $AGENT_DIR (no running processes were stopped)."
  echo "When you are ready to hand off the foreground worker to launchd:"
  echo "  launchctl bootstrap $DOMAIN \"$AGENT_DIR/com.groundcontrol.worker.plist\"  # if not loaded"
  echo "  launchctl kickstart $DOMAIN/com.groundcontrol.worker"
  echo "Stop with: $ROOT/scripts/uninstall-launchagents.sh"
  exit 0
fi

if [[ "$MODE" == "--disruptive" ]]; then
  # Operator-only: stop ad-hoc processes that would fight launchd for the port
  pkill -f "ngrok http --url" 2>/dev/null || true
  lsof -tiTCP:8787 -sTCP:LISTEN | xargs kill 2>/dev/null || true
  pkill -f "${ROOT}.*npm run worker" 2>/dev/null || true
  pkill -f "${ROOT}.*npm run relay" 2>/dev/null || true
  pkill -f "agent-control/scripts/run-" 2>/dev/null || true
  sleep 2
fi

for name in relay ngrok worker; do
  label="com.groundcontrol.${name}"
  dst="$AGENT_DIR/${label}.plist"
  "$ROOT/scripts/render-launchd-plist.sh" "$label" > "$dst"
  if [[ "$MODE" == "--disruptive" ]]; then
    launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$dst"
    launchctl enable "$DOMAIN/$label" 2>/dev/null || true
    launchctl kickstart -k "$DOMAIN/$label" 2>/dev/null || true
    echo "installed $label"
  fi
done

if [[ "$MODE" != "--disruptive" ]]; then
  stage_plists
  echo "installed plists (safe stage; use --disruptive to restart all services)"
  exit 0
fi

echo
echo "Waiting for health..."
for _ in $(seq 1 30); do
  if curl -sf http://127.0.0.1:8787/healthz >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl -s http://127.0.0.1:8787/healthz | python3 -m json.tool || true
echo
echo "Ground Control will now start at login and restart on crash."
echo "Stop with: $ROOT/scripts/uninstall-launchagents.sh"
