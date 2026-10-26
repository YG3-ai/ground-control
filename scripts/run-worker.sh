#!/usr/bin/env bash
# Foreground Mac worker for launchd KeepAlive.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
set -a && source "$ROOT/.env" && set +a
# nvm node MUST come first — Homebrew node breaks better-sqlite3 ABI
NVM_NODE="$HOME/.nvm/versions/node/v20.20.0/bin"
export PATH="$NVM_NODE:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export npm_config_scripts_prepend_node_path="true"

HOST="${PUBLIC_BASE_URL#https://}"
HOST="${HOST#http://}"
HOST="${HOST%%/*}"
PORT="${RELAY_PORT:-8787}"

mkdir -p "$ROOT/logs" "$ROOT/data/worker"

LOCK_ROOT="$ROOT/data/worker/.worker-instance.lock"
WORKER_LOCK_NODE="$NVM_NODE/node"
if [[ ! -x "$WORKER_LOCK_NODE" ]]; then
  WORKER_LOCK_NODE="$(command -v node || true)"
fi
release_worker_lock() {
  [[ -n "${WORKER_LOCK_NODE:-}" ]] && "$WORKER_LOCK_NODE" "$ROOT/scripts/worker-instance-lock.mjs" release "$LOCK_ROOT" 2>/dev/null || true
}
if ! "$WORKER_LOCK_NODE" "$ROOT/scripts/worker-instance-lock.mjs" acquire "$LOCK_ROOT" >/dev/null; then
  echo "[worker] another instance holds the worker lock; exiting (launchd will keep single owner)" >&2
  exit 0
fi
trap release_worker_lock EXIT INT TERM HUP

# Prefer loopback relay — avoids tunnel WebSocket churn for the co-located Mac worker.
if curl -sf "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
  export RELAY_URL="ws://127.0.0.1:${PORT}/worker"
else
  export RELAY_URL="wss://${HOST}/worker"
fi

# Wait for local relay before dialing (boot / restart races)
for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

exec "$NVM_NODE/npm" run worker
