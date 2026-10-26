#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
for name in worker relay ngrok; do
  if [[ -f "logs/${name}.pid" ]]; then
    pid="$(cat "logs/${name}.pid")"
    if kill -0 "$pid" 2>/dev/null; then
      echo "stopping $name ($pid)"
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "logs/${name}.pid"
  fi
done
echo "stopped"
