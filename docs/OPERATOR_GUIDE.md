# Operator guide (development reference)

Personal agent control: **ChatGPT on your phone** coordinates **Cursor CLI** and **Kimi** on your always-on Mac through **your own authenticated remote MCP relay** — not OpenAI’s native remote computer use.

For public release onboarding, start with the root [README](../README.md) and [SETUP_MAC.md](SETUP_MAC.md).

## What this is for

ChatGPT on your phone **directs local Cursor and Kimi**, checks in on jobs, and sends follow-ups. You do **not** register every git repo — pick a workspace under `allowed_roots` (e.g. `ycrm` or `Winning/ycrm`). Cursor/Kimi keep their normal codebase/git access.

## Architecture

```
ChatGPT (phone) --HTTPS + OAuth--> Relay (public MCP + OAuth AS)
                                         ^
                                         | outbound WSS + WORKER_TOKEN
                                      Mac Worker (SQLite jobs)
                                         |
              ┌──────────────────────────┴──────────────────────────┐
              │ host: managed `agent` / `kimi` in live workspaces   │
              │ docker: mock isolation demo only                      │
              └───────────────────────────────────────────────────────┘
```

### Material tradeoffs

1. **Default `agent_execution: host`** — Cursor/Kimi run as managed local CLIs in real checkouts (what you want for day-to-day direction). Scope ≈ what those CLIs can already do when you run them yourself.
2. **Docker isolation** remains for the mock agent / strict demos; not required for Cursor/Kimi coordination.
3. **Outbound-only worker** — relay must be **public HTTPS** for ChatGPT; phone VPN alone is not enough.
4. Jobs are durable; ChatGPT does **not** keep thinking after a turn. `supervisor.enabled` stays false until configured.

Verified on this Mac: arm64, Docker Desktop, Node 20, Cursor `agent` 2026.10.19, Kimi 2.2.0.

## Status

| Phase | State |
| --- | --- |
| 1. Mock agent + durable jobs | ✅ |
| 2. Docker isolation + sentinel proof | ✅ |
| 3. Cursor / Kimi adapters | ✅ scaffolded (disabled until you opt in + Linux image) |
| 4. Authenticated relay + MCP tools | ✅ |
| 5. ChatGPT mobile connection | ⏳ needs your public HTTPS URL / tunnel |

Automated checks: path/symlink guards, redaction bounds, authz, idempotency, concurrent jobs, cancel, restart recovery, Docker sentinel invisibility, relay auth + worker RPC e2e.

## Quick start (local)

```bash
cd ~/Projects/agent-control
cp .env.example .env
# edit .env — set WORKER_TOKEN, RELAY_JWT_SECRET, OWNER_APPROVAL_SECRET
# for local only you may set:
#   PUBLIC_BASE_URL=http://127.0.0.1:8787
#   ALLOW_DEV_TOKEN=1
#   and config.yaml relay.url=ws://127.0.0.1:8787/worker

npm install
./scripts/build-mock-image.sh
npm test

# terminal A
npm run relay

# terminal B
npm run worker
```

Cursor + Kimi are enabled. Point `allowed_roots` at the parent folders you care about (already set to `~/Winning`, `~/Projects`, `~/Developer`).

## MCP tools

Managed jobs: `list_projects` · `list_tasks` · `start_task` · `get_task` · `get_task_output` · `send_followup` · `cancel_task`

Interactive PTYs (survive chat turns; die on worker restart): `terminal_capabilities` · `create_terminal_session` · `list_terminal_sessions` · `get_terminal_session` · `read_terminal_output` · `write_terminal_input` · `resize_terminal_session` · `interrupt_terminal_session` · `close_terminal_session`

Awareness / local Mac control: `get_situation` · `request_local_approval` · `list_approvals` · `get_approval` · `notify_owner` · `open_url`

Missions (research → plan → approve → ship): `create_mission` · `list_missions` · `get_mission` · `update_mission` · `approve_mission` · `complete_mission`

Mac whiteboard: [http://127.0.0.1:8788/](http://127.0.0.1:8788/) · Phone Ground / Life Mirror: `https://YOUR_PUBLIC_HOST/` (see [docs/PHONE_BOARD.md](docs/PHONE_BOARD.md))

Usage / client bugfix: `get_usage` · `ingest_client_request` · `run_next_bugfix` · `draft_client_update` · `list_client_requests`

Example: start Cursor on a folder under `allowed_roots` with `agent=cursor`, `workspace=ycrm`, and a prompt. No per-repo config entry. For a live shell/CLI session use `create_terminal_session`.

## Docs

- [What worker/agents can access](docs/ACCESS.md)
- [ChatGPT connection steps](docs/CHATGPT.md)
- [Interactive terminal sessions](docs/TERMINAL_SESSIONS.md)
- [Local awareness, approvals, browser](docs/LOCAL_CONTROL.md)
- [Missions + whiteboard](docs/MISSIONS.md)
- [Credits + Kimi 5h window](docs/USAGE.md)
- [Event spine (Ground Life Mirror)](docs/EVENT_SPINE.md)
- Always-on LaunchAgents: `./scripts/install-launchagents.sh`
- Cloudflare Tunnel (ngrok replacement): [docs/CLOUDFLARE_TUNNEL.md](docs/CLOUDFLARE_TUNNEL.md)

## Start / stop / uninstall

```bash
./scripts/install-launchagents.sh     # always-on: relay + ngrok + worker (login + KeepAlive)
./scripts/uninstall-launchagents.sh   # stop and remove
curl -s http://127.0.0.1:8787/healthz # expect worker.connected=true

# wipe local data + image (optional)
rm -rf data/worker data/policy data/relay
docker rmi agent-control-mock:local 2>/dev/null || true
```

## Remaining setup actions

1. Keep LaunchAgents installed (done on this Mac).
2. Leave `supervisor.enabled: false` until cost limits are set.
3. Rotate the ngrok API key that was pasted in chat when convenient.
