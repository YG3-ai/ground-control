# Missions + whiteboard

The intended loop:

> “Optimize my outbound” → ChatGPT researches with Cursor (1–2 passes) → presents a plan → you approve in chat (`approve_mission` + `authorization=chat_explicit`, hybrid_remote) or on the Mac if you ask → Cursor implements without repeated plan prompts → ChatGPT pings you that it’s done and updates status markers on the whiteboard.

Cursor, Kimi, and Codex can participate in the same mission. The deterministic
[Advisor contract](ADVISOR.md) defines shared context, workspace locking,
routing, failure handling, and the boundary between token-free health checks
and model-consuming agent work.

## Mission statuses

`intake` → `researching` → `plan_ready` → `approved` → `implementing` → `verifying` → `done`

Also: `blocked`, `cancelled`.

## MCP tools

| Tool | Role |
| --- | --- |
| `create_mission` | Open the card (title, goal, workspace, markers) |
| `update_mission` | Findings, status, link job/session ids, markers |
| `submit_mission_plan` | Submit or revise the plan, increment its revision, invalidate stale approval, and notify “All good?” |
| `approve_mission` | Record plan approval: `authorization=chat_explicit` after chat consent (default hybrid path), or Mac dialog via `require_dialog` / `authorization=local_dialog` |
| `complete_mission` | Mark done + notify + markers |
| `list_missions` / `get_mission` | Read state |
| `get_situation` | Full snapshot including missions |

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
