#!/usr/bin/env bash
# YG3 workspace-verified read-only sync (launchd / manual). No install side effects.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [[ $# -eq 0 ]]; then
  set -- --trigger run_at_load
fi
exec node --import tsx packages/relay/src/yg3-mcp/background-sync-cli.ts "$@"
