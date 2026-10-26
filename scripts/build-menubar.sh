#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_SRC="$ROOT/apps/menu-bar"
DIST="$ROOT/apps/menu-bar/dist"
APP="$DIST/Ground Control.app"
BIN_DIR="$APP/Contents/MacOS"
RES_DIR="$APP/Contents/Resources"

rm -rf "$DIST"
mkdir -p "$BIN_DIR" "$RES_DIR"

python3 "$APP_SRC/scripts/generate-icons.py"

cd "$APP_SRC"
swift build -c release --product GroundControlMenu
BIN="$(swift build -c release --show-bin-path)/GroundControlMenu"
cp "$BIN" "$BIN_DIR/GroundControlMenu"
cp "$APP_SRC/Info.plist" "$APP/Contents/Info.plist"
cp "$APP_SRC/Resources/AppIcon.icns" "$RES_DIR/"
cp "$APP_SRC/Resources/MenuBarIcon.png" "$RES_DIR/"
cp "$APP_SRC/Resources/MenuBarIcon@2x.png" "$RES_DIR/"
chmod +x "$BIN_DIR/GroundControlMenu"

# Ad-hoc sign so Gatekeeper is less annoying for local use
codesign --force --deep --sign - "$APP" 2>/dev/null || true

echo "Built: $APP"
