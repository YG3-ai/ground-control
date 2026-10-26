#!/usr/bin/env bash
# Idempotent first-time / CI-safe bootstrap (no service start, no secret output).
set -euo pipefail
if [[ -n "${GROUND_CONTROL_BOOTSTRAP_ROOT:-}" ]]; then
  ROOT="$GROUND_CONTROL_BOOTSTRAP_ROOT"
else
  ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fi
cd "$ROOT"

SKIP_INSTALL=0
SKIP_BUILD=0
SKIP_DIRS=0

for arg in "$@"; do
  case "$arg" in
    --skip-install) SKIP_INSTALL=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --skip-dirs) SKIP_DIRS=1 ;;
    --only-dirs) SKIP_INSTALL=1; SKIP_BUILD=1 ;;
  esac
done

created=()
if [[ ! -f .env ]]; then
  cp .env.example .env
  created+=(".env")
fi
if [[ ! -f config.yaml ]]; then
  cp config.example.yaml config.yaml
  created+=("config.yaml")
fi

if [[ ${#created[@]} -gt 0 ]]; then
  echo "bootstrap: created ${created[*]}"
else
  echo "bootstrap: config files already present"
fi

if [[ "$SKIP_DIRS" == "0" ]]; then
  mkdir -p data/relay data/worker data/policy logs
  echo "bootstrap: runtime directories ready"
fi

if [[ "$SKIP_INSTALL" == "0" ]]; then
  if [[ -f package-lock.json ]]; then
    npm ci
  else
    npm install
  fi
  echo "bootstrap: dependencies installed"
fi

if [[ "$SKIP_BUILD" == "0" ]]; then
  npm run build
  echo "bootstrap: build complete"
fi

echo "bootstrap: done (edit .env and config.yaml, then npm run doctor)"
