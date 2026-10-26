#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
docker build -t agent-control-mock:local "$ROOT/docker/mock-agent"
echo "built agent-control-mock:local"
