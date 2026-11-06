#!/usr/bin/env bash
# Foreground Mac worker for launchd KeepAlive.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# Use dotenv at process start.  Do not source .env: valid secret values can
# contain shell metacharacters and valid path values can contain spaces.
# nvm node MUST come first — Homebrew node breaks better-sqlite3 ABI
NVM_NODE="$HOME/.nvm/versions/node/v20.20.0/bin"
if [[ ! -x "$NVM_NODE/node" ]]; then
  echo "[worker] Node 20.20.0 is required at $NVM_NODE/node; install it with nvm before starting Ground Control" >&2
  exit 1
fi
export PATH="$NVM_NODE:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export npm_config_scripts_prepend_node_path="true"

PORT="${RELAY_PORT:-8787}"

if [[ -z "${PUBLIC_BASE_URL:-}" && -f "$ROOT/.env" ]]; then
  PUBLIC_BASE_URL="$("$NVM_NODE/node" --input-type=module -e "
import { parseLocalEnvFile } from './scripts/load-local-env.mjs';
const v = parseLocalEnvFile('$ROOT')?.PUBLIC_BASE_URL;
if (typeof v === 'string') process.stdout.write(v);
" 2>/dev/null || true)"
fi

HOST="${PUBLIC_BASE_URL#https://}"
HOST="${HOST#http://}"
HOST="${HOST%%/*}"

mkdir -p "$ROOT/logs" "$ROOT/data/worker"
if ! "$NVM_NODE/node" -e 'if (process.versions.node !== "20.20.0") process.exit(1)'; then
  echo "[worker] incompatible Node runtime: expected 20.20.0, got $($NVM_NODE/node --version)" >&2
  exit 1
fi
if ! "$NVM_NODE/node" -e 'try { require("better-sqlite3"); require("node-pty"); } catch (e) { console.error("[worker] incompatible native module for Node " + process.versions.node + ": " + e.message); process.exit(1); }'; then
  exit 1
fi

LOCK_ROOT="$ROOT/data/worker/.worker-instance.lock"
WORKER_LOCK_NODE="$NVM_NODE/node"
if [[ ! -x "$WORKER_LOCK_NODE" ]]; then
  WORKER_LOCK_NODE="$(command -v node || true)"
fi
# Singleton lock is held for the lifetime of the worker Node process (see worker CLI).
# Probe only — do not acquire here (a short-lived helper PID would make the lock useless).
if [[ -n "${WORKER_LOCK_NODE:-}" ]]; then
  LOCK_PROBE="$("$WORKER_LOCK_NODE" "$ROOT/scripts/worker-instance-lock.mjs" probe "$LOCK_ROOT" 2>/dev/null || true)"
  if [[ "$LOCK_PROBE" == *'"held":true'* ]]; then
    echo "[worker] another instance holds the worker lock ($LOCK_PROBE); exiting (launchd will keep single owner)" >&2
    exit 0
  fi
fi
export GROUND_CONTROL_WORKER_LOCK_ROOT="$LOCK_ROOT"

# Wait for local relay, then choose dial URL (boot races must not pick wss:///worker).
relay_up=false
for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
    relay_up=true
    break
  fi
  sleep 2
done

if $relay_up; then
  export RELAY_URL="ws://127.0.0.1:${PORT}/worker"
elif [[ -n "$HOST" ]]; then
  export RELAY_URL="wss://${HOST}/worker"
else
  echo "[worker] relay not reachable and PUBLIC_BASE_URL unset; exiting for launchd retry" >&2
  exit 1
fi

exec "$NVM_NODE/node" --require dotenv/config --import tsx packages/worker/src/cli.ts
