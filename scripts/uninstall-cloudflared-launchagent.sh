#!/usr/bin/env bash
set -euo pipefail
UID_NUM="$(id -u)"
DOMAIN="gui/${UID_NUM}"
AGENT_DIR="$HOME/Library/LaunchAgents"
LABEL="com.groundcontrol.cloudflared"

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
rm -f "$AGENT_DIR/${LABEL}.plist"
echo "Removed $LABEL"
