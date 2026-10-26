#!/usr/bin/env bash
# Read-only: verify cloudflared login and list tunnels (no DNS changes).
set -euo pipefail

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared not installed. Run: brew install cloudflared" >&2
  exit 1
fi
if [[ ! -f "$HOME/.cloudflared/cert.pem" ]]; then
  echo "Not logged in. Run: cloudflared tunnel login" >&2
  exit 1
fi

echo "cloudflared account cert: present"
echo
echo "Named tunnels in this account:"
cloudflared tunnel list
echo
echo "Choose a hostname only from zones you control in the Cloudflare dashboard."
echo "After you pick a zone, set ingress hostname in ~/.cloudflared/config.yml (see config/cloudflared.yml.example)."
