# Worker activation checkpoint (2026-10-25)

**Status:** **ACTIVATED** — owner **GO** received; single worker restart executed.

## Pre-activation (2026-10-25 ~00:24 local)

| Item | Result |
|------|--------|
| Worker `npm run build` + `tsc --noEmit` | **clean** |
| Relay `npm run build` + `verify-board-shell` | **ok** (~91943 chars) |
| Relay vitest | **70 passed**, 8 skipped (e2e — no Docker) |
| Worker `meaning.test.ts` | **15 passed** |
| launchd | `com.groundcontrol.worker` PID **43639**, `com.groundcontrol.relay` running; no other ground worker jobs |
| Issue | Live worker lacked `world_*` RPC + evidence `source_ref` in running process |

## Activation command (executed once)

```bash
launchctl kickstart -k "gui/$(id -u)/com.groundcontrol.worker"
```

- **Not** restarted: relay, tunnel, DNS, OAuth, config, secrets, endpoints
- Expected: brief WS blip; Cursor PTY tied to old worker may exit

## What the new worker process loads

- World: `world_summary`, `list_world_entities`, `get_world_entity`
- Meaning detail: `EvidenceSummary.source_ref` (+ existing object/state fields)
- Relay shell (already hot-loaded): Home identity/world pulse, Evolution evidence/list resolution

## Changed paths (full effort)

- `packages/relay/src/board.html`, `board-html-loader.ts`, extension routes, public-redact
- `packages/relay/src/board-home-mission.ts`, `board-evolution-resolve.ts` + tests
- `packages/worker/src/service.ts`, `meaning/types.ts`, `meaning/meaning.test.ts`

## Post-activation verification (owner — cloud browser, no secrets in logs)

```bash
curl -s https://my.parthaunnava.com/healthz
# expect worker.connected: true

curl -s -o /dev/null -w "%{http_code}\n" https://my.parthaunnava.com/api/board/world
# expect 401 without key — NOT world_unavailable

# With owner unlock:
# - World tab: entity groups (not worker-update message)
# - Evolution: turning-point list shows mission · Proposed; evidence taps or static rows
# - Home: World pulse when index has data
# - /board: owner session + feeds
```

## Post-restart probe (automated, if shell survives)

See **Post-restart results** section below (filled immediately after kickstart).

## Not done

- No meaning rebuild / candidate mutation
- No relay `kickstart`
- No install/ensure scripts
