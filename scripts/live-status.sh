#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
echo "Local health:"
curl -s http://127.0.0.1:8787/healthz | python3 -m json.tool
echo
if [[ -f .env ]]; then
  # shellcheck disable=SC1091
  set -a && source .env && set +a
  echo "PUBLIC_BASE_URL=${PUBLIC_BASE_URL:-unset}"
  echo "MCP URL: ${PUBLIC_BASE_URL:-}/mcp"
  echo "Approval secret is in .env as OWNER_APPROVAL_SECRET"
fi
