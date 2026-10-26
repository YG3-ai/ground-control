#!/usr/bin/env bash
# Render YG3 sync LaunchAgent plist to launchd/rendered (no launchctl).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$ROOT/launchd/rendered"
mkdir -p "$OUT_DIR" "$ROOT/logs"
chmod +x "$ROOT/scripts/run-yg3-sync.sh" "$ROOT/scripts/render-launchd-plist.sh" 2>/dev/null || true
"$ROOT/scripts/render-launchd-plist.sh" com.groundcontrol.yg3-sync > "$OUT_DIR/com.groundcontrol.yg3-sync.plist"
echo "prepare-yg3-launchagent: rendered launchd/rendered/com.groundcontrol.yg3-sync.plist"
