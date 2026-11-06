#!/usr/bin/env bash
# Foreground relay for launchd KeepAlive.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# Load .env with dotenv instead of sourcing it as shell.  Board secrets and
# filesystem paths are valid dotenv values but need not be valid shell syntax
# (for example, scrypt hashes include `$` and paths may contain spaces).
# nvm node MUST be explicit — launchd PATH can still pick Homebrew node (breaks better-sqlite3)
NVM_NODE="$HOME/.nvm/versions/node/v20.20.0/bin"
if [[ ! -x "$NVM_NODE/node" ]]; then
  echo "[relay] Node 20.20.0 is required at $NVM_NODE/node; install it with nvm before starting Ground Control" >&2
  exit 1
fi
export PATH="$NVM_NODE:$ROOT/.venv/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export npm_config_scripts_prepend_node_path="true"
mkdir -p "$ROOT/logs" "$ROOT/data/relay"
if ! "$NVM_NODE/node" -e 'if (process.versions.node !== "20.20.0") process.exit(1)'; then
  echo "[relay] incompatible Node runtime: expected 20.20.0, got $($NVM_NODE/node --version)" >&2
  exit 1
fi
if ! "$NVM_NODE/node" -e 'try { require("better-sqlite3"); } catch (e) { console.error("[relay] incompatible native module better-sqlite3 for Node " + process.versions.node + ": " + e.message); process.exit(1); }'; then
  exit 1
fi
exec "$NVM_NODE/node" --require dotenv/config --import tsx packages/relay/src/cli.ts
