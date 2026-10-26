#!/usr/bin/env bash
# Start relay + stable ngrok URL + worker.
# Requires PUBLIC_BASE_URL to be a fixed https host (not an ephemeral ngrok URL).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  echo "Missing .env — copy .env.example and set secrets + PUBLIC_BASE_URL"
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

if [[ -z "${PUBLIC_BASE_URL:-}" || "${PUBLIC_BASE_URL}" == *"127.0.0.1"* ]]; then
  echo "Set PUBLIC_BASE_URL in .env to your stable https URL first."
  echo "Claim a free static domain: https://dashboard.ngrok.com/domains"
  echo "Example: PUBLIC_BASE_URL=https://your-name.ngrok-free.app"
  exit 1
fi

HOST="${PUBLIC_BASE_URL#https://}"
HOST="${HOST#http://}"
HOST="${HOST%%/*}"

if [[ "$HOST" == *".ngrok-free.app" || "$HOST" == *".ngrok.app" || "$HOST" == *".ngrok.dev" ]]; then
  :
else
  echo "Note: PUBLIC_BASE_URL host is $HOST (not ngrok). This script still starts local relay/worker;"
  echo "start your own stable tunnel/proxy to port ${RELAY_PORT:-8787}."
fi

mkdir -p data/relay data/worker logs

echo "[1/3] starting relay on ${RELAY_HOST:-127.0.0.1}:${RELAY_PORT:-8787}"
npm run relay >logs/relay.log 2>&1 &
echo $! >logs/relay.pid
sleep 1

if [[ "$HOST" == *ngrok* ]]; then
  echo "[2/3] starting ngrok on fixed url https://$HOST -> ${RELAY_PORT:-8787}"
  # Kill any prior ngrok for this project carefully
  if [[ -f logs/ngrok.pid ]] && kill -0 "$(cat logs/ngrok.pid)" 2>/dev/null; then
    kill "$(cat logs/ngrok.pid)" 2>/dev/null || true
    sleep 1
  fi
  ngrok http --url "https://$HOST" "${RELAY_PORT:-8787}" >logs/ngrok.log 2>&1 &
  echo $! >logs/ngrok.pid
  sleep 2
fi

export RELAY_URL="wss://${HOST}/worker"
echo "[3/3] starting worker -> $RELAY_URL"
npm run worker >logs/worker.log 2>&1 &
echo $! >logs/worker.pid

sleep 2
echo
curl -s "http://127.0.0.1:${RELAY_PORT:-8787}/healthz" | python3 -m json.tool || true
echo
echo "MCP URL (stable): ${PUBLIC_BASE_URL}/mcp"
echo "Logs under $ROOT/logs — stop with: scripts/stop-stable.sh"
