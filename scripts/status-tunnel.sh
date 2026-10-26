#!/usr/bin/env bash
# Local + public tunnel status (no secrets printed).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
if [[ -f "$ROOT/.env" ]]; then set -a && source "$ROOT/.env" && set +a; fi

PORT="${RELAY_PORT:-8787}"
UID_NUM="$(id -u)"
DOMAIN="gui/${UID_NUM}"

echo "=== LaunchAgents ==="
for label in com.groundcontrol.relay com.groundcontrol.cloudflared com.groundcontrol.ngrok com.groundcontrol.worker; do
  if launchctl print "$DOMAIN/$label" &>/dev/null; then
    state="$(launchctl print "$DOMAIN/$label" 2>/dev/null | awk -F'= ' '/state =/{print $2; exit}')"
    echo "  $label: loaded (${state:-unknown})"
  else
    echo "  $label: not loaded"
  fi
done

echo
echo "=== Local relay (127.0.0.1:${PORT}) ==="
if curl -sf "http://127.0.0.1:${PORT}/healthz" | python3 -m json.tool; then
  :
else
  echo "  healthz unreachable"
fi

if [[ -n "${PUBLIC_BASE_URL:-}" ]]; then
  echo
  echo "=== Public (PUBLIC_BASE_URL) ==="
  echo "  base: ${PUBLIC_BASE_URL}"
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 12 "${PUBLIC_BASE_URL}/healthz" || echo "000")"
  echo "  GET /healthz HTTP ${code}"
fi
