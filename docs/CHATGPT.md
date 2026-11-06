# Project coordination
Jacqueline's Advisor architecture is the coordination source of truth. Use
submit_mission_plan to persist the plan revision and approve_mission after
owner authorization. Pass mission_id on managed jobs; implementation requires
the current revision's approval. For multi-step projects, persist the contract
and let the durable queue advance it through acceptance and review. Carry the
recorded handoff forward, observe actual job progress, and preserve owner stop
and release decisions. Do not substitute a manual stream of unlinked jobs for
this workflow. Routine in-scope work uses the owner's existing authorization.

# Connect ChatGPT (mobile) to agent-control

Official references:

- [Add custom MCP server](https://developers.openai.com/api/docs/guides/custom-mcp-server)
- [Connecting custom MCP servers](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt)
- [Plugin authentication](https://developers.openai.com/plugins/build/auth)

## Critical networking fact

ChatGPT’s **servers** call your MCP URL. Your phone is only the UI.

- Hosting the relay on `127.0.0.1` is fine for local tests.
- For ChatGPT, `PUBLIC_BASE_URL` must be **public HTTPS**.
- A VPN that only runs on your phone does **not** expose the Mac to ChatGPT.
- Use a tunnel (Cloudflare Tunnel, ngrok, etc.) or host the relay on a VPS; keep the worker on the Mac dialing out.

Desktop-local MCP config (e.g. Cursor `mcp.json`) does **not** automatically apply on ChatGPT mobile.

## Steps

1. Set secrets in `.env` (`WORKER_TOKEN`, `RELAY_JWT_SECRET`, `OWNER_APPROVAL_SECRET`, `PUBLIC_BASE_URL`).
2. Set `ALLOW_DEV_TOKEN=0` for any reachable deploy.
3. Start relay so it is reachable at `https://…/mcp`.
4. Start the Mac worker (`npm run worker`) so it connects outbound to `wss://…/worker`.
5. In ChatGPT (web or app with Plugins support):
   - Plugins → **Add custom MCP server**
   - Server URL: `https://your-relay.example.com/mcp`
   - Authentication: **OAuth**
   - Acknowledge the risk warning → create plugin → install it
6. Complete the browser approval page using `OWNER_APPROVAL_SECRET`.
7. In a chat, `@` the plugin and try `list_projects`.

## Account / product limitations

- Workspace policies, Lockdown, or plan tier may block custom MCP plugins.
- Tool write actions usually require confirmation in ChatGPT.
- Refresh tokens require `offline_access` (advertised by this relay). If ChatGPT loses access after expiry, re-authorize.
- Exact mobile UI labels change; if Plugins is missing on phone, complete add/install on web first, then use the installed plugin on mobile.

## Smoke test without ChatGPT

```bash
# with ALLOW_DEV_TOKEN=1 on localhost only
curl -s -X POST http://127.0.0.1:8787/oauth/dev/token \
  -H 'content-type: application/json' \
  -d '{"approval_secret":"YOUR_OWNER_APPROVAL_SECRET"}'
```

Use the access token as `Authorization: Bearer …` against `/mcp`. Prefer the automated relay e2e tests.

## Worker disconnected (phone-only recovery)

If ChatGPT tools fail with **Mac worker is not connected** but the plugin still loads:

1. Call **`get_mac_connectivity`** (relay-side; no worker required).
2. Call **`recover_mac_services`** with **`scope=worker`** (default). This runs `launchctl kickstart` on the Mac worker LaunchAgent and waits for the WebSocket to reconnect **without restarting the relay** (so your ChatGPT MCP session stays up).
3. Use **`scope=relay_and_worker`** only if local `/healthz` is down — that restarts the relay and **drops** the active MCP connection until you send another message.

Local fallback on the Mac: `./scripts/restart-ground-control.sh`
