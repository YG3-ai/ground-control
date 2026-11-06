#!/usr/bin/env bash
# Restart relay / tunnel / worker via launchd (local operator or menu bar).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec "$ROOT/scripts/ensure-services.sh"
