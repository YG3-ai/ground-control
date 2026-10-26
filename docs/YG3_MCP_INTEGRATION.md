# YG3 MCP integration (read-only foundation)

Ground Control can connect to the official YG3 MCP endpoint for marketing data. This path is **disabled by default**; legacy `GROUND_CONTROL_WORK_ROOT` adapters continue to serve owner dashboards until you opt in.

## Enable

1. Set in `.env`:
   - `YG3_MCP_ENABLED=1`
   - `YG3_MCP_URL=https://mcp.yg3.ai/mcp` (override only for mock/tests)
2. Run `npm run yg3:login` on the Mac (opens browser, loopback callback on an ephemeral port).
3. Run `npm run doctor` — checks connection state **without printing secrets**.

OAuth tokens are stored in the macOS Keychain. Non-secret client registration metadata lives under `data/relay/yg3/` (gitignored).

## Workspace selection (role-aware)

After `yg3:login`, pick the **client** workspace (never the agency org row when names collide):

| Principal | Flow |
|-----------|------|
| Client-scoped user | Auto-selected on sync from `scope_client_id` (no picker). |
| Agency user | `npm run yg3:workspaces:search -- "query"` (client rows only) → `npm run yg3:select -- --ref N` |
| Super admin | `yg3:workspaces:search` shows `accountKind` + `slugNormalized` for disambiguation → `yg3:select --ref`, `--slug`, or `--name` |

- `npm run yg3:workspaces:status` — bound selection metadata (no workspace IDs).
- Selection persists under `data/relay/yg3/workspace-selection.json` (mode `600`, tenant/principal-bound). Sync revalidates before use.

## Sync (Slice 3B2)

- `npm run yg3:sync` — one bounded read-only discovery sync (owner-only); writes normalized `snapshot-v1.json` and raw envelopes under `data/relay/yg3/raw/` (mode `600`, release-forbidden).
- `npm run yg3:sync-final` — resolves one workspace via `list_clients`, then runs client-scoped read tools for that workspace only (Slice 3B2C).
- `npm run yg3:purge-raw` — deletes **only** `data/relay/yg3/raw/` (never touches normalized snapshot or OAuth metadata).
- Owner feeds (growth, yg3-accounts, lifecycle) prefer a fresh MCP snapshot when enabled; legacy work-root runners remain fallback when MCP is off or unavailable.
- Cache-on-read with TTL, single-flight lock, stale last-known-good fallback. No background polling.

## Scope

- Read-only tool allowlist (whoami and dashboard-oriented reads).
- No write tools, no `confirm` / idempotency arguments.
- Public/anonymous board routes never instantiate the YG3 client or read snapshot/raw files.

## Security

- Treat MCP tool output as untrusted (size/depth limits).
- Do not enable MCP on shared machines without reviewing Keychain access.
- Public demo feeds remain synthetic fixtures.

## Related

- [SETUP_MAC.md](SETUP_MAC.md) — first-run checklist
