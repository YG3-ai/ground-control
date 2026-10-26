#!/usr/bin/env bash
# Foreground stable ngrok tunnel for launchd KeepAlive.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
set -a && source "$ROOT/.env" && set +a
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
# (ngrok only — no Node ABI concerns)

HOST="${PUBLIC_BASE_URL#https://}"
HOST="${HOST#http://}"
HOST="${HOST%%/*}"
PORT="${RELAY_PORT:-8787}"

if [[ -z "$HOST" || "$HOST" == *"127.0.0.1"* ]]; then
  echo "PUBLIC_BASE_URL must be your stable ngrok domain" >&2
  exit 1
fi

mkdir -p "$ROOT/logs"
exec ngrok http --url "https://$HOST" "$PORT" --log=stdout
