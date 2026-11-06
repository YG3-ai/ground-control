# Missions + whiteboard

The intended loop:

> “Optimize my outbound” → ChatGPT researches with Cursor (1–2 passes) → presents a plan → you approve in chat (`approve_mission` + `authorization=chat_explicit`, hybrid_remote) or on the Mac if you ask → implementation runs on the Mac worker → **`submit_mission_review`** stages **`ready_for_review`** (owner reviews later; does not block other jobs) → **`complete_mission`** only after explicit owner release (`owner_release_authorized`). No automatic merge to main or deploy.

Cursor, Kimi, and Codex can participate in the same mission. The deterministic
[Advisor contract](ADVISOR.md) defines shared context, workspace locking,
routing, failure handling, and the boundary between token-free health checks
and model-consuming agent work.

## Mission statuses

`intake` → `researching` → `plan_ready` → `approved` → `implementing` → `verifying` → **`ready_for_review`** → `done`

Also: `blocked`, `cancelled`.

### Durable project queue + supervision (optional)

When `supervisor.enabled: true` in `config.yaml`, the **existing worker job tick** runs `missionQueueTick` → `missionSupervisorTick` (no second daemon).

**Enqueue once** with `enqueue_mission_project` (`enqueue_key` idempotent). Ground persists priority, FIFO tie-breaking (`fifo_seq`), `depends_on` mission ids, `earliest_start_at` / `schedule_until_at`, `resource_class`, and bounded retries/backoff on the queue row. States on the whiteboard: `queued`, `scheduled`, `running`, `blocked`, `verifying`, `ready_for_review` (plus `completed` / `cancelled`).

The scheduler claims work atomically (SQLite lease), respects `supervisor.queue_max_concurrent` (review/verify **do not** hold slots), honors per-agent limits via existing `start_task` / `get_usage`, recovers stale leases after restart, and advances contract steps without chat nudges until `submit_mission_review` stages **`ready_for_review`**.

Missions with `markers.project_active=true` and JSON **`mission_contract_json`** advance ordered steps automatically:

- Each step starts at most one managed job at a time; **idempotency keys** `mission:{id}:step:{step}:attempt:{n}` prevent duplicate side effects on retry.
- Failed steps retry up to `supervision.max_step_retries`, then `blocked` with `block_reason`.
- `submit_mission_review` and `complete_mission` are **fail-closed** (exact `evidence_git_head`, linked succeeded jobs, optional desktop/mobile QA job markers when `completion_requires_usability`).

Preflight agent capacity with **`get_usage`** (`max_concurrent`, rolling start window). **`start_task`** is a one-shot job; **`create_terminal_session`** is interactive PTY — both respect per-agent concurrency separately.

## MCP tools

| Tool | Role |
| --- | --- |
| `create_mission` | Open the card (title, goal, workspace, markers) |
| `update_mission` | Findings, status, link job/session ids, markers |
| `submit_mission_plan` | Submit or revise the plan, increment its revision, invalidate stale approval, and notify “All good?” |
| `approve_mission` | Record plan approval: `authorization=chat_explicit` after chat consent (default hybrid path), or Mac dialog via `require_dialog` / `authorization=local_dialog` |
| `submit_mission_review` | Evidence gates → `ready_for_review` + optional `notify_owner` |
| `complete_mission` | After owner release → `done` + optional `notify_owner` |
| `list_missions` / `get_mission` | Read state |
| `enqueue_mission_project` | Idempotent enqueue (`enqueue_key`) with priority, deps, schedule |
| `list_mission_queue` | Queue rows + blockers / next run |
| `update_mission_queue_entry` / `reschedule_mission_queue_entry` / `cancel_mission_queue_entry` | Owner queue control (cancel cascades jobs + mission) |
| `cancel_mission_project` | Cancel by mission id (same cascade as queue cancel) |
| `get_situation` | Full snapshot including missions |
| `get_usage` | Per-agent concurrency / rate-window preflight |

When `advisor.enabled: true`, implementation-tier `start_task` calls require a
`mission_id` whose current plan revision is approved. The Advisor adds the
bounded mission packet to the agent prompt, queues work FIFO per workspace,
allows one writer at a time, and records a durable handoff when a job ends.

The chat coordinator is replaceable. ChatGPT is the documented default, but an
MCP-capable Grok client or another bot can call the same tools and continue the
same mission. Ground Control state, rather than one provider's chat history,
holds the plan, approval, queue, and handoff.

## Whiteboard (this Mac)

Full-screen board (loopback only):

```text
http://127.0.0.1:8788/
```

Shows mission columns, KPI/marker chips, live terminal tails, active jobs, pending approvals. Polls every 3s.

Open from the menu bar (**Open whiteboard**) or:

```bash
open http://127.0.0.1:8788/
```

## Markers

`markers` are free-form chips on the board, e.g.:

```json
{ "area": "outbound", "reply_rate": "watching", "board": "green" }
```

Use them as your project-management status signals.

## Activation

```bash
launchctl kickstart -k "gui/$(id -u)/com.groundcontrol.relay"
launchctl kickstart -k "gui/$(id -u)/com.groundcontrol.worker"
```

Reconnect the ChatGPT connector after tool changes.
