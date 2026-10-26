#!/usr/bin/env bash
# Remove only the YG3 background sync LaunchAgent (does not touch relay/worker/ngrok).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export GROUND_CONTROL_LAUNCH_AGENTS_DIR="${GROUND_CONTROL_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
node "$ROOT/scripts/uninstall-yg3-sync-launchagent.mjs"
