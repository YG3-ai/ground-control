#!/usr/bin/env bash
# Restore Ground Control public edge via Cloudflare Tunnel (my.parthaunnava.com).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_DIR="$HOME/Library/LaunchAgents"
UID_NUM="$(id -u)"
DOMAIN="gui/${UID_NUM}"
CF_DIR="$HOME/.cloudflared"
CONFIG="$CF_DIR/config.yml"
TUNNEL_NAME="${CLOUDFLARED_TUNNEL_NAME:-ground-control}"
HOSTNAME="${GROUND_PUBLIC_HOSTNAME:-my.parthaunnava.com}"
RELAY_PORT="${RELAY_PORT:-8787}"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "Install cloudflared: brew install cloudflared" >&2
  exit 1
fi

mkdir -p "$CF_DIR" "$ROOT/logs"
chmod 700 "$CF_DIR"

if [[ ! -f "$CF_DIR/cert.pem" ]]; then
  echo "cloudflared is not logged in to the Cloudflare account that owns $HOSTNAME." >&2
  echo "Run: cloudflared tunnel login" >&2
  echo "Then re-run: $ROOT/scripts/restore-cloudflare-tunnel.sh" >&2
  exit 1
fi

echo "Named tunnels in this account:"
cloudflared tunnel list

TUNNEL_ID=""
while read -r id name _rest; do
  [[ "$name" == "ID" ]] && continue
  if [[ "$name" == "$TUNNEL_NAME" ]]; then
    TUNNEL_ID="$id"
    break
  fi
done < <(cloudflared tunnel list)

if [[ -z "$TUNNEL_ID" ]]; then
  echo "Creating tunnel $TUNNEL_NAME..."
  cloudflared tunnel create "$TUNNEL_NAME"
  TUNNEL_ID="$(cloudflared tunnel list | awk -v n="$TUNNEL_NAME" '$2 == n { print $1; exit }')"
fi

CREDS="$CF_DIR/${TUNNEL_ID}.json"
if [[ ! -f "$CREDS" ]]; then
  echo "Missing credentials file $CREDS — re-run: cloudflared tunnel create $TUNNEL_NAME" >&2
  exit 1
fi

cat >"$CONFIG" <<EOF
tunnel: $TUNNEL_ID
credentials-file: $CREDS

ingress:
  - hostname: $HOSTNAME
    service: http://127.0.0.1:$RELAY_PORT
  - service: http_status:404
EOF
chmod 600 "$CONFIG" "$CREDS"

echo "Ensuring DNS route for $HOSTNAME..."
cloudflared tunnel route dns "$TUNNEL_NAME" "$HOSTNAME" 2>/dev/null || true

install_user_launchagent() {
  echo "Installing cloudflared LaunchAgent..."
  "$ROOT/scripts/install-cloudflared-launchagent.sh"
}

install_system_service() {
  local token
  token="$(cloudflared tunnel token "$TUNNEL_NAME")"
  if [[ -z "$token" ]]; then
    echo "Failed to read tunnel token for $TUNNEL_NAME" >&2
    return 1
  fi
  echo "Reinstalling system cloudflared service (com.cloudflare.cloudflared)..."
  if [[ "$(id -u)" -eq 0 ]]; then
    cloudflared service install "$token"
    launchctl kickstart -k system/com.cloudflare.cloudflared 2>/dev/null || true
  elif command -v sudo >/dev/null 2>&1; then
    sudo cloudflared service install "$token"
    sudo launchctl kickstart -k system/com.cloudflare.cloudflared 2>/dev/null || true
  else
    echo "Need sudo to restore /Library/LaunchDaemons/com.cloudflare.cloudflared" >&2
    return 1
  fi
}

if [[ -f /Library/LaunchDaemons/com.cloudflare.cloudflared.plist ]]; then
  install_system_service
else
  install_user_launchagent
fi

echo "Disabling ngrok LaunchAgent (Cloudflare is the public edge)..."
launchctl bootout "$DOMAIN/com.groundcontrol.ngrok" 2>/dev/null || true
launchctl disable "$DOMAIN/com.groundcontrol.ngrok" 2>/dev/null || true

echo "Restarting relay → cloudflared → worker..."
launchctl kickstart -k "$DOMAIN/com.groundcontrol.relay" 2>/dev/null || true
sleep 2
if [[ -f "$AGENT_DIR/com.groundcontrol.cloudflared.plist" ]]; then
  launchctl kickstart -k "$DOMAIN/com.groundcontrol.cloudflared" 2>/dev/null || true
  sleep 3
fi
launchctl kickstart -k "$DOMAIN/com.groundcontrol.worker" 2>/dev/null || true

for _ in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:${RELAY_PORT}/healthz" | grep -q '"connected":true'; then
    break
  fi
  sleep 1
done

echo
"$ROOT/scripts/status-tunnel.sh"
