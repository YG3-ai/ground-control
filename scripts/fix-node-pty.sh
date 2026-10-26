#!/usr/bin/env bash
# node-pty prebuild spawn-helper sometimes lands non-executable after npm install.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
shopt -s nullglob
for helper in "$ROOT"/node_modules/node-pty/prebuilds/*/spawn-helper \
              "$ROOT"/packages/*/node_modules/node-pty/prebuilds/*/spawn-helper; do
  if [[ -f "$helper" && ! -x "$helper" ]]; then
    chmod +x "$helper"
    echo "[fix-node-pty] chmod +x $helper"
  fi
done
