#!/usr/bin/env bash
# Render a LaunchAgent plist from launchd/templates (stdout). No install side effects.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="${1:?usage: render-launchd-plist.sh com.groundcontrol.relay}"
TEMPLATE="$ROOT/launchd/templates/${LABEL}.plist.template"
if [[ ! -f "$TEMPLATE" ]]; then
  echo "missing template: $TEMPLATE" >&2
  exit 1
fi
MENUBAR_APP="${GROUND_CONTROL_MENUBAR_APP:-}"
sed \
  -e "s|__GROUND_CONTROL_ROOT__|$ROOT|g" \
  -e "s|__MENUBAR_APP_BUNDLE__|$MENUBAR_APP|g" \
  "$TEMPLATE"
