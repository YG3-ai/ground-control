#!/usr/bin/env bash
# Local + public tunnel status (no secrets printed).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NVM_NODE="$HOME/.nvm/versions/node/v20.20.0/bin/node"
READ_ENV_NODE="${NVM_NODE}"
if [[ ! -x "$READ_ENV_NODE" ]]; then
  READ_ENV_NODE="$(command -v node || true)"
fi
if [[ -n "${READ_ENV_NODE:-}" ]]; then
  eval "$("$READ_ENV_NODE" --input-type=module -e "
import { parseLocalEnvFile } from './scripts/load-local-env.mjs';
const env = parseLocalEnvFile('$ROOT') ?? {};
const esc = (s) => \"'\" + String(s).replace(/'/g, \"'\\\\''\") + \"'\";
if (env.PUBLIC_BASE_URL) console.log('export PUBLIC_BASE_URL=' + esc(env.PUBLIC_BASE_URL));
if (env.RELAY_PORT) console.log('export RELAY_PORT=' + esc(env.RELAY_PORT));
" 2>/dev/null || true)"
fi

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
