# Ground mobile rollout (mission a0e4110f)

Goal: the phone board at `/board` feels like a mobile app — 4 persistent tabs (Now / Growth / Skills / Notes) — backed by the same data as funnels.yg3.ai and the canonical Second Brain vault.

## Backend (this change set)

- `board-extensions/lifecycle.ts` — invokes `scripts/lifecycle.ts queue --json` directly via bounded `execFile` (`node --import tsx`), avoiding the `npm run` banner that broke `JSON.parse`. Freshness (`stale`) is computed from the source's own `asOf` age (>24h = stale), not cache age.
- `board-extensions/growth.ts` — `outbound.replies` is labelled as leads with recorded status `replied` (per `lib/outbound-dashboard.ts`), explicitly *not* a verified human-written count. Freshness from source `generatedAt`. Unavailable sources never zero-fill.
- `board-extensions/skills.ts` — the hardcoded catalog is gone. Capabilities are read from the canonical Brain note `projects/ground-capabilities` via the brain CLI (`brain.py read`), parsed from `## name` + `- key: value` fields, deduped by id. Level = distinct `verified` capabilities; `composite_of` groupings never double-count. Missing note → `ok:false`, `level:null` (never invented).
- `board-extensions/brain.ts` — `BRAIN_VAULT` is pinned from `paths.brainVault` on every CLI call (brain.py resolves its vault from env, not cwd), so tests isolate into temp vaults and never write the real one. Capture rejects over-limit input (`body_too_long` >8000, `title_too_long` >200) instead of silently truncating. Search parser matches brain.py's real tab-separated `slug\ttitle\ttags=...\t[how]` output. `n` limits are finite-integer validated.
- `board-extensions/routes.ts` — POST capture validates body shape/length before dereferencing (400/413); `n` params return 400 on non-integers. All extension routes stay behind `boardAuth`; all exec is bounded `execFile`, no shell.
- `board-extensions/mission-filters.ts` — no id/title suppression: terminal statuses (done/cancelled/blocked) live in History only; a future Terrane mission appears normally.
- `paths.ts` — adds `brainVault` and `lifecycleQueueScript`.

## Canonical Brain catalog

`/Users/partha/second-brain/vault/projects/ground-capabilities.md` is the single source of truth for Skills. Seeded with recorded proof only: live worker RPC, hotloader (d362b6d3, done), Sri receipt/reply confirmed, owner capture readback. `health:` is `Not checked` unless an actual source check was performed and timestamped (worker RPC, Brain search+read, growth report load, lifecycle queue read — all 2026-10-23).

## Frontend

`src/board.html` is root-owned (final QA at 320/390/430/1280 passed by root).

## Verification

- `npm run typecheck` — clean.
- `npm run build` — clean (copies board.html/manifest/icon to dist).
- `npx vitest run` — 16 passed, 8 skipped; `src/e2e.test.ts` suite fails only because the Docker daemon is not running (mock image build); pre-existing environmental dependency, unrelated to this change set. Log: /tmp/ground-vitest.log.

## Deploy (root-owned)

One relay-only reload when idle; preserve worker PID/PTY ids/jobs. Then authenticated live checks + one real Brain capture via the endpoint with readback.

## Final live verification 2026-10-23T22:45:18.023Z

Relay reloaded once; listener PID 65136. Worker 52209 and terminal 62441 preserved; genuine Ground RPC recovered. Authenticated Growth, lifecycle, Skills, Notes recent/search/read passed. Seven unauthenticated requests rejected; five invalid capture bodies rejected. Real Notes capture/readback persisted in Second Brain. Root interaction QA passed draft persistence, full plan, decline confirmation, duplicate guard, 409, cookie init, offline-worker tabs, and long draft preservation. Growth and queue capabilities promoted after live evidence; authority recorded separately from proof and readiness.

Final deployed UI version: ca11daca64646c47. Final build exit 0. Canonical 7-day and 30-day live ranges verified (7: Oct17-Oct23;30: Sep24-Oct23), including legacy 30d alias. Final deployed-source fixture QA passed all four widths, note metadata stripping, range requests, and safety/draft checks. Listener PID65136 remained unchanged during final UI, runner and Brain updates. Skills live endpoint reflects six verified distinct capabilities from the canonical vault.
