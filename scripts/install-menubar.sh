#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
chmod +x "$ROOT/scripts/ensure-services.sh" 2>/dev/null || true
"$ROOT/scripts/install-launchagents.sh" --stage
"$ROOT/scripts/build-menubar.sh"

APP_SRC="$ROOT/apps/menu-bar/dist/Ground Control.app"
APP_DST="/Applications/Ground Control.app"
AGENT_DIR="$HOME/Library/LaunchAgents"
LABEL="com.groundcontrol.menubar"
UID_NUM="$(id -u)"
DOMAIN="gui/${UID_NUM}"

mkdir -p "$AGENT_DIR"

install_to() {
  local dst="$1"
  mkdir -p "$(dirname "$dst")"
  rm -rf "$dst"
  cp -R "$APP_SRC" "$dst"
}

if install_to "/Applications/Ground Control.app" 2>/dev/null; then
  APP_DST="/Applications/Ground Control.app"
else
  echo "Installing to ~/Applications (use sudo $0 for /Applications)" >&2
  APP_DST="$HOME/Applications/Ground Control.app"
  install_to "$APP_DST"
fi

# LaunchAgent so the icon returns at login — quitting the menu does NOT stop the worker
cat > "$AGENT_DIR/${LABEL}.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0 //EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>/usr/bin/open</string>
      <string>-a</string>
      <string>${APP_DST}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <!-- Do NOT KeepAlive: user may quit the menu while Ground Control keeps running -->
  </dict>
</plist>
EOF

# Fix accidental space in DOCTYPE if any
sed -i '' 's/DTD PLIST 1.0 \/\/EN/DTD PLIST 1.0\/\/EN/' "$AGENT_DIR/${LABEL}.plist"

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
if ! launchctl bootstrap "$DOMAIN" "$AGENT_DIR/${LABEL}.plist" 2>/dev/null; then
  sleep 1
  launchctl bootstrap "$DOMAIN" "$AGENT_DIR/${LABEL}.plist"
fi
open -a "$APP_DST"

echo "Menu bar installed. Quit menu only keeps relay/worker running."
echo "Stop services (when idle): menu → Stop Ground Control services…"
