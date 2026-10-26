# Event spine ("Ground Life Mirror", Phase 1)

Doctrine: **real events first; interpretations later.** No XP, badges, or levels.
Second Brain stays the canonical memory — the event store is a derived,
fully rebuildable projection, never a competing source of truth. Local-first
and private: events carry **references + small safe metadata only** — never
prompt bodies, note bodies, email bodies, logs, or approval detail text.

## Decision

A separate append-only SQLite store, `events.db`, lives under the worker data
dir beside `usage.db` (WAL mode, opened the same way as `UsageLedger`).
Implementation: `packages/worker/src/events/store.ts`.

Rejected alternatives:

- **Derived on-read view** — cannot capture ephemeral sources (terminal
  sessions whose state vanishes on worker restart) or overwritten history
  (status transitions between `updated_at` bumps are lost).
- **Embed in `jobs.db`** — couples event lifecycle to job schema migrations;
  not rebuildable in place from other source stores.
- **JSONL file** — no indexed queries; weaker atomicity than the SQLite WAL
  pattern used everywhere else in this repo.

## Source inventory

| Source | Store | Ids | Timestamps | Retention | Privacy | Rebuildable? |
| --- | --- | --- | --- | --- | --- | --- |
| Missions | `missions.db` (MissionStore) | `mission:<id>` | created_at, updated_at, approved_at, completed_at | persistent | goal/plan text is content → excluded; status internal | yes |
| Jobs | `jobs.db` (JobStore) | `job:<id>` | created_at, started_at, finished_at, updated_at | persistent | prompt/logs are content → excluded; whole source private | yes |
| Approvals | `approvals/approvals.json` (ApprovalManager) | `approval:<id>` | created_at, resolved_at | history capped (50) | title/detail/note are content → excluded; kind + status only, private | yes (within history cap) |
| Terminal sessions | in-memory TerminalSessionManager | session id | created/closed | dies with worker process | cwd/workspace metadata only | **no** — live hooks only |
| Usage ledger | `usage.db` (UsageLedger) | job id refs | created_at | persistent | model/tier metadata | yes |
| Clients | `clients.db` (ClientRequestStore) | `request:<id>` | created_at | persistent | subject/body are content → excluded | yes |
| Second Brain | external (canonical memory) | note ids | n/a | canonical | references only, never note bodies | n/a — canonical elsewhere |
| Growth/interpretations | Phase 3 | derived | n/a | n/a | user-confirmed before persistence | derived, never in events |

"Rebuildable" means `EventStore.rebuildFrom()` can re-derive the events from
the source store after `events.db` is deleted.

## Event contract

Table `events` (one row per fact, append-only):

- `event_id TEXT PRIMARY KEY` — deterministic UUID formatting of the SHA-256
  of `adapterVersion|source|sourceRef|verb|dedupeKey` (8-4-4-4-12 hex).
  Stable across rebuilds → `INSERT OR IGNORE` gives idempotent materialization.
- `occurred_at` (when it happened, from source timestamps) and
  `observed_at` (when the adapter wrote it), both ISO.
- `source` (`missions` | `jobs` | `approvals` | `sessions` | `usage` |
  `growth` | `second_brain` …), `source_ref` (stable entity id).
- `actor` (`owner` | `system` | `agent:<name>` | null), `verb`
  (`mission.created`, `mission.status_changed`, `job.created`,
  `job.status_changed`, `approval.requested`, `approval.resolved`, …),
  `object_type`, `object_id`.
- `from_state`, `to_state` (nullable).
- `evidence_refs` — JSON array of strings like `mission:<uuid>`,
  `approval:<uuid>`, `job:<uuid>`. References, never content.
- `confidence REAL DEFAULT 1.0`.
- `sensitivity TEXT DEFAULT 'internal'` — `public` | `internal` | `private`.
  Jobs/approvals/client-derived events default `private`; mission status
  events `internal`; nothing stores raw content regardless of level.
- `schema_version`, `adapter_version` (both default 1).
- `corrects` — nullable `event_id` this event supersedes.
- Indexes: `(occurred_at DESC)`, `(source, source_ref)`,
  `(verb, occurred_at DESC)`.

## Emission

Two paths:

1. **Live hooks.** `JobStore`, `MissionStore`, and `ApprovalManager` each
   expose an optional `onEvent` sink (kept optional so existing tests that
   construct the stores directly keep working). `WorkerService` wires all
   three to the `EventStore` in its constructor. Events fire at the single
   choke points: `create`/`update` (missions), `createJob`/`updateJob`
   (jobs), `request`/`finish` (approvals — kind + final status only).
2. **Deterministic rebuild.** `EventStore.rebuildFrom({ jobs, missions,
   approvals })` scans the source stores and `INSERT OR IGNORE`s derived
   events: `mission.created` (from `created_at`), `mission.status_current`
   (current status at `updated_at`), `mission.status_changed` for
   `approved`/`done` (from `approved_at`/`completed_at`), `job.created`,
   `job.status_changed` (from `started_at`/`finished_at` + current status),
   `approval.requested`/`approval.resolved` (from `approvals.json` pending +
   history). Because `event_id`s are deterministic, rebuild is idempotent and
   `events.db` can simply be deleted and re-materialized. The only events a
   rebuild cannot reproduce are live-hook events from ephemeral sources
   (terminal sessions) — those exist only while their source process lives.

## Read-only query surface

- `EventStore.list({ limit?, since?, source?, verb?, includePrivate? })` —
  ordered by `occurred_at DESC`; `sensitivity='private'` rows are excluded
  unless `includePrivate=true`.
- Loopback control server: `GET /api/events?limit=&since=&source=&verb=&includePrivate=1`
  (loopback only, no relay exposure of raw data beyond the same filters).
- Worker relay-client method `list_events` (+ `rebuild_events`).
- MCP tool `list_events` (readOnly) registered in the relay; it becomes
  active on the next natural relay restart.

## Sensitivity + redaction model

No raw content is ever stored — no prompt bodies, note bodies, email bodies,
logs, or approval detail. Privacy is enforced structurally (there is nothing
to leak), and the `private` sensitivity level adds query-time filtering on
top: private rows only surface when the caller explicitly asks.

## Corrections

Rows are never UPDATEd. A correction is a new immutable event whose
`corrects` points at the superseded `event_id`; both rows remain queryable
so the audit trail survives.

## Phase 2/3 seam

Phase 2 (world graph) and Phase 3 (capability inference, adaptive UI) consume
this spine read-only. Interpretations are expressed as
`InterpretationCandidate` (see `packages/worker/src/events/types.ts`):
derived from `basis_event_ids`, proposed to the owner, and persisted only
after explicit confirmation — never written into the events table, so facts
and meaning stay separable and re-derivable.
