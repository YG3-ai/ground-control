# Meaning engine ("Ground Life Mirror", Phase 3)

Doctrine unchanged: **real events first; interpretations later.** The meaning
engine derives *interpretation candidates* from the event spine and the world
projection, proposes them to the owner, and keeps them strictly separate from
raw events (Phase 1) and provable facts (Phase 2). Candidates are
descriptions of the past — they carry **no permission, authority, or
capability-to-act fields**, and no rule may emit them. No XP, badges, or
levels in v1: `badge` stays in the `CandidateKind` union for future use, but
no rule emits it (badges are doctrine-suspect).

Implementation:

- `packages/worker/src/meaning/types.ts` — candidate + decision contracts.
- `packages/worker/src/meaning/rules.ts` — versioned, pure rule catalogue.
- `packages/worker/src/meaning/store.ts` — `MeaningStore` (`meaning.db`, WAL,
  beside `events.db`/`world.db`).
- `packages/worker/src/meaning/engine.ts` — `runRules()` + `rebuildMeaning()`.

## Contracts

`InterpretationCandidate` is durable but **derived**: wiped and regenerated on
rebuild. Key fields:

- `candidate_id` — deterministic UUID-shaped SHA-256 of
  `candidate | rule_id | rule_version | kind | sorted entity_ids | sorted
  evidence_event_ids`. Same inputs → same id, across rebuilds and store wipes.
- `kind` — `capability | turning_point | chapter | badge`.
- `proposed_label` — generic and content-free. NEVER derived from mission
  titles, note bodies, or any raw content (e.g. `"Reliable mission delivery"`).
- `status` — `proposed | accepted | dismissed | corrected | superseded`.
- `confidence` — deterministic 0..1, a pure function of counts/ratios stated
  in the rule's explanation.
- `maturity` — `acquired | reliable | hardened`, capability kind only.
- `sensitivity` — the MAX sensitivity of its evidence events: any private
  evidence event makes the candidate private.
- `proposed_at` / `updated_at` — min/max `occurred_at` of the evidence
  events. Derived, never wall clock, so rebuilds are byte-stable.
- Correction links: `accepted_at`, `corrected_label`, `correction_note`,
  `supersedes`, `corrects` (nullable; unused by v1 rules).

`InterpretationDecision` is the **durable owner overlay** — the only part of
meaning.db that is never wiped: `candidate_id`, `decision`
(`accept | dismiss | correct`), `corrected_label`, `correction_note`,
`decided_at`, `decided_by`. An append-only `decision_log` table keeps the full
history.

Every rule exports `rule_id`, `rule_version`, a human-readable `explanation`,
and its `thresholds` (see `RULE_CATALOG`).

## Rule catalogue (v1)

### `recovery_after_failure` (turning_point) — v1

One candidate per mission where a linked job failed or was interrupted
(`job.status_changed` to `failed | timed_out | cancelled` for a job referenced
by `job:<id>` evidence on the completion event) followed chronologically by
the mission reaching `done` (`mission.status_changed`, `to_state = done`).
Evidence = the failure event(s) + the completion event.

`confidence = min(0.9, 0.6 + 0.05·min(failures, 4) + proximity)` where
`proximity` is `0.1` when completion lands within 24h of the last failure,
`0.05` within 7 days, else `0`.

### `reliable_delivery` (capability, maturity ladder) — v1

Counts DISTINCT missions that reached `done` WITH successful job evidence (a
linked job that has a `job.status_changed` to `succeeded` event). Maturity:
`acquired` at ≥3, `reliable` at ≥7, `hardened` at ≥15 completed missions AND
≥1 observed `recovery_after_failure` pattern. Emits ONE candidate (owner
entity) at the highest justified maturity; nothing below `acquired`.
Confidence is fixed per maturity: 0.6 / 0.75 / 0.9.

### `self_running_system` (capability, hardened only) — v1

Emitted only when ≥10 distinct missions completed with successful job
evidence, ≥80% of them completed with NO linked job failure events at all, and
≥2 recovery patterns were observed. If any condition is not provable, nothing
is emitted. `confidence = min(0.95, round2(0.7 + 0.25 · clean_fraction))`.

### Shared guarantees

- **Superseded events excluded**: an event targeted by another event's
  `corrects` is removed before rules run; corrections therefore rewrite the
  meaning derived from the spine.
- **Evidence integrity**: evidence ids always exist in the input event set
  (rules build candidates from the events they read).
- **Conservatism**: rules prefer zero candidates over weak ones — thresholds
  are hard gates, not scores.
- **Job ↔ mission linkage**: mission events carry `job:<id>` evidence refs
  (emitted from `missions.linked_job_ids` on both the live emit path and the
  events rebuild derivation). This is metadata-only; event ids are unchanged.

## Corrections, supersession, and the decision overlay

- Candidates regenerate as `proposed`; the overlay then re-applies: `accept` →
  `accepted` (+ `accepted_at`), `dismiss` → `dismissed`, `correct` →
  `corrected` with `corrected_label`/`correction_note` added — the original
  `proposed_label` is NEVER mutated.
- Overlay rows key on the deterministic `candidate_id`. A rebuild that
  regenerates the same candidate re-applies the decision; a candidate whose
  evidence changed gets a new id and starts as `proposed` again; decisions for
  vanished candidates stay in the table (harmless) and re-apply if the id ever
  regenerates.
- Every decision also emits a content-free spine event: source `meaning`,
  verb `candidate.accepted | candidate.dismissed | candidate.corrected`,
  `object_type = interpretation_candidate`, `evidence_refs` = the candidate's
  evidence ids. **Note text never enters the spine** — notes live only in the
  overlay table; a decision carrying a note is marked at least `internal`
  (`private` when the candidate is private). These events are idempotent
  appends; `events.rebuildFrom()` inserts, never wipes, so they persist.

## Privacy

Sensitivity propagates as max-of-evidence. `listCandidates` and
`getCandidate` exclude `private` unless `includePrivate` is passed; the same
flag gates evidence summaries. Job-derived candidates are typically `private`
because job events are private.

## Rebuild & determinism

`rebuildMeaning()` = `projectWorld(events)` → `runRules()` → wipe + rewrite
`candidates` → re-apply overlays → return COUNTS ONLY (`by_kind`,
`by_sensitivity`, `by_rule_id`). Two consecutive rebuilds over unchanged
events produce identical candidate rows. `meaning.db` may be deleted and
regenerated from `events.db`; only the decisions/log tables are irreplaceable.

## Loopback API (127.0.0.1 only — never on the public relay)

Same auth posture as the approvals routes (owner-gated via the service):

- `GET /api/meaning/candidates?kind=&status=&sensitivity=&includePrivate=1`
- `GET /api/meaning/candidate?id=&includePrivate=1` — candidate + overlay +
  evidence summaries (`event_id`, `verb`, `occurred_at`, `sensitivity` only).
- `GET /api/meaning/summary?includePrivate=1`
- `POST /api/meaning/candidates/:id/:action` — action ∈ `accept | dismiss |
  correct`; JSON body `{ label?, note? }` (`correct` requires label or note).
- `POST /api/meaning/rebuild`

503 `meaning unavailable` when not wired, matching the existing error style.

## Phase 4 presentation seam

UI must treat candidates as proposals, not facts: read `listCandidates` /
`getCandidate`, render `proposed_label` (or `corrected_label` when status is
`corrected`), show `confidence`, `maturity`, and the rule `explanation`, and
link evidence through the summaries only. UI never writes candidates directly
— only the three decision actions — and must respect `includePrivate` gating.
Badges/chapters: do not build presentation for kinds no rule emits yet.

### Phone board (relay, owner-only)

Evolution routes live on the public relay host but are **not** public data.
Every path uses `boardWriteAuth` (valid board key only — anonymous public
preview and read-only `/api/board` audiences never qualify):

- `GET /api/board/evolution/summary`
- `GET /api/board/evolution/candidates?kind=&status=`
- `GET /api/board/evolution/candidates/:id`
- `POST /api/board/evolution/candidates/:id` — body `{ action, label?, note? }`
  with `action` ∈ `accept | dismiss | correct`.

There is **no** phone rebuild endpoint. Worker RPC methods:
`list_meaning_candidates`, `get_meaning_candidate`, `meaning_summary`,
`decide_meaning_candidate` (wired in `relay-client.ts`).

The **Evolution** destination is reached from Home (when the owner has
proposed items) or `?tab=evolution` after unlock. It is not a tab-bar item —
Home, Growth, Missions, and Brain stay unchanged for public viewers.
