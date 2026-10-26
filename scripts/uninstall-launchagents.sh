#!/usr/bin/env bash
set -euo pipefail
UID_NUM="$(id -u)"
DOMAIN="gui/${UID_NUM}"
AGENT_DIR="$HOME/Library/LaunchAgents"

for name in worker ngrok relay; do
  label="com.groundcontrol.${name}"
  launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
  rm -f "$AGENT_DIR/${label}.plist"
  echo "removed $label"
done
echo "Ground Control launch agents removed."
