# Cloudflare Tunnel (ngrok replacement)

Ground exposes **only** the relay on `127.0.0.1:8787` (MCP, board, worker WebSocket). The worker local control port (`8788`) stays loopback-only.

## Hostname (owner choice required)

Do **not** set a production hostname until:

1. `cloudflared tunnel login` (browser) is complete.
2. Zones in **your** Cloudflare account are listed and you pick a subdomain.

Placeholder until then: `ground.YOUR_VERIFIED_ZONE_PLACEHOLDER` (see `config/cloudflared.yml.example`).

We do not create or modify DNS until you explicitly approve a hostname from that verified list.

## Prerequisites

```bash
brew install cloudflared
```

## One-time setup (after owner approves checkpoint)

```bash
cloudflared tunnel login
cloudflared tunnel create ground-control
# Edit ~/.cloudflared/config.yml from config/cloudflared.yml.example
cloudflared tunnel route dns ground-control ground.<your-chosen-zone>
```

Test in foreground before launchd:

```bash
cloudflared tunnel run ground-control
```

Update **only** local `.env` (not committed):

```bash
PUBLIC_BASE_URL=https://ground.<your-chosen-zone>
```

Restart order: **relay → cloudflared → worker**

```bash
launchctl kickstart -k "gui/$(id -u)/com.groundcontrol.relay"
./scripts/install-cloudflared-launchagent.sh
launchctl kickstart -k "gui/$(id -u)/com.groundcontrol.worker"
```

## Install / status / rollback

| Script | Purpose |
|--------|---------|
| `./scripts/install-cloudflared-launchagent.sh` | Install KeepAlive cloudflared agent |
| `./scripts/uninstall-cloudflared-launchagent.sh` | Remove cloudflared agent only |
| `./scripts/status-tunnel.sh` | LaunchAgent + local/public health |
| `./scripts/rollback-to-ngrok.sh` | Disable cloudflared, re-enable ngrok |

Ngrok LaunchAgents and `scripts/run-ngrok.sh` remain in the repo until cutover is verified.

## ChatGPT after cutover

Reconnect the Ground MCP plugin with:

`https://<your-chosen-host>/mcp`

OAuth issuer URLs follow `PUBLIC_BASE_URL`; existing `WORKER_TOKEN`, `RELAY_JWT_SECRET`, and approval secrets stay unless a compatibility issue appears.

## Secrets

Keep `~/.cloudflared/*.json`, `cert.pem`, and tunnel tokens **outside** git (`chmod 600`). Never commit `.env`.
