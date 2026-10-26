# World model ("Ground Life Mirror", Phase 2)

Doctrine unchanged from the event spine: **real events first; interpretations
later.** Source stores and Second Brain stay canonical; the world model is a
derived, fully rebuildable projection of `events.db` — an index, never a
source of truth. No XP, badges, levels, inferred biography, or capability
claims. Facts are provable from events only.

Implementation:

- `packages/worker/src/world/project.ts` — pure deterministic projection
  (`projectWorld(events)`): same events in → same world out.
- `packages/worker/src/world/store.ts` — `WorldStore` (`world.db`, WAL),
  wiped and re-materialized only by `rebuildFromEvents()`. Nothing else
  writes to it.
- `packages/worker/src/world/types.ts` — entity/fact/relation contracts.

## Entities

Entities are created **only where events prove them**:

| Type | Created from | Sensitivity |
| --- | --- | --- |
| `person` | `actor: owner` events | internal |
| `service` | one per event `source` (`missions`, `jobs`, `usage`, …) and `actor: system` | internal |
| `agent` | `actor: agent:<name>` events | internal |
| `mission` | events with `object_type = 'mission'` | internal |
| `organization` | `client:<id>` evidence refs on client-request events | **private** |

Jobs, approvals, sessions and usage rows are deliberately **not** entities —
they are evidence. Entity ids are deterministic UUID-shaped SHA-256 hashes of
the canonical alias (`entity|<alias>`), so re-materialization is stable.
Labels are content-free, derived from stable ids only (e.g. `mission
93d73779`, agent name) — never names, titles, or prompt text.

## Facts

Keyed `(entity, key)`, each carrying `sensitivity`, `evidence_event_ids`
(capped at 50), and a deterministic `updated_at` (newest contributing
`occurred_at`). Current set: per-service `events_count` / `last_event_at`;
per-actor `last_active_at`, `sessions_opened`, `usage_<kind>` counters,
`jobs_created`, `last_job_state`; per-mission `status`; per-organization
`requests_count`, `last_request_at`. Fact sensitivity is the max of its
contributing events, so job/usage-derived facts on an agent are `private`
while the agent entity itself stays `internal`.

## Relations

Deterministic id from `(kind, from, to)`. Kinds: `created_by`,
`approved_by`, `served_by` (organization → mission), `filed_request_for`,
`opened_session`. All carry evidence refs and max-sensitivity.

## History

`entity_history` holds a pointer per (entity, event): `occurred_at`, `verb`,
`from_state`/`to_state`, and a `superseded` flag. Corrections from the event
spine (`corrects`) mark the superseded event in history but exclude it from
current state — audit trail survives, state stays clean.

## Sensitivity model

Entities start at the first event's sensitivity and ratchet up to the max,
except locked entities (actors, services, missions created `internal`;
organizations locked `private`). Private rows only surface through the read
APIs when `includePrivate=1` is passed explicitly.

## Read-only query surface

Loopback control server (`127.0.0.1:8788`, never relay-exposed):

- `GET /api/world?type=&state=&includePrivate=1` — summary + entities.
- `GET /api/world/entity?id=&includePrivate=1` — one entity with facts,
  relations, history.

## Rebuild

`world.db` can simply be deleted and re-materialized from `events.db` via
`rebuildFromEvents()`; deterministic ids make the result identical. Live
apply path: after backfill, the worker re-projects new spine events into the
world store as they land.

## Phase 3 seam

Phase 3 (capability inference, adaptive UI) consumes the world model
read-only. Interpretations remain `InterpretationCandidate`s proposed to the
owner and persisted only after explicit confirmation — never written as
facts, so provable data and meaning stay separable.
