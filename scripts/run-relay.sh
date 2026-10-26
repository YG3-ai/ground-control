#!/usr/bin/env bash
# Foreground relay for launchd KeepAlive.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
set -a && source "$ROOT/.env" && set +a
# nvm node MUST be explicit — launchd PATH can still pick Homebrew node (breaks better-sqlite3)
NVM_NODE="$HOME/.nvm/versions/node/v20.20.0/bin"
export PATH="$NVM_NODE:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export npm_config_scripts_prepend_node_path="true"
mkdir -p "$ROOT/logs" "$ROOT/data/relay"
exec "$NVM_NODE/npm" run relay
