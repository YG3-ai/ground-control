# Credits + Kimi 5-hour window

## Problem

- **Cursor** burns plan credits on expensive models / long agent loops.
- **Kimi Code** has a **rolling ~5-hour usage window** (token/request heavy). Bursting many agent starts empties it mid-day.

## What Ground Control does

| Guard | Cursor | Kimi |
| --- | --- | --- |
| Default model | `composer-2.5` | `kimi-code/k3-256k` (smaller context) |
| Research tier | `--mode ask` (read-only) + cheap model | paced starts |
| Max concurrent | 1 | 1 |
| Max starts / 5h window | 30 | **10** |
| Min gap between starts | 45s | **12 min** |
| Rate-limit detect | cooldown 10m | cooldown **30m** |

Also lowered `~/.kimi-code/config.toml` thinking `effort` to **low** (was high/max) so each Kimi turn costs less.

Check live: MCP `get_usage`, or whiteboard KPIs (`kimi_starts_left`).

## Tiers on `start_task`

- `research` / `triage` — gather info cheaply (Cursor ask mode)
- `implement` / `bugfix` — write code (still paced)
- Optional `model` override when you truly need a heavier model

## Client bugfixes + update emails

Configured clients: **Far Beyond**, **The Currency**, **inbox** (see `config.yaml` → `clients`).

1. `ingest_client_request({ client: "far-beyond", subject, body, from_email })`
2. `run_next_bugfix` when `get_usage.kimi` allows
3. After a batch (or once a day): `draft_client_update({ client: "far-beyond" })` → markdown draft under `data/worker/drafts/` — **not sent**
4. You review/send from your mail client

## Tuning

Edit `config.yaml` → `agents.cursor.usage` / `agents.kimi.usage`, then:

```bash
launchctl kickstart -k "gui/$(id -u)/com.groundcontrol.worker"
```

If you still hit Kimi’s wall: lower `max_starts_per_window`, raise `min_gap_sec`, keep effort low, batch emails instead of one-shot chats.
