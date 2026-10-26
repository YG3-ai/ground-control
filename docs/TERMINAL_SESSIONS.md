# Interactive terminal sessions

Owner-authenticated MCP tools drive real PTYs on the Mac worker. Sessions outlive ChatGPT turns while the **worker process** is alive. They are **not** persisted across worker restart (PTYs die with the process). Managed `start_task` jobs remain in SQLite and are unchanged.

## Tools

| Tool | Purpose |
| --- | --- |
| `terminal_capabilities` | Binaries, model flags, control keys, restart honesty |
| `create_terminal_session` | `kind=shell\|cursor\|kimi`, `workspace`, optional `model`/`cols`/`rows`/`idle_sec` |
| `list_terminal_sessions` | Your sessions only |
| `get_terminal_session` | Status (`waiting`/`running`/`exited`/`error`) |
| `read_terminal_output` | Bounded incremental read with absolute byte `offset` |
| `write_terminal_input` | `data`, `keys` (enter, ctrl-c, …), `submit` for Enter |
| `resize_terminal_session` | cols/rows |
| `interrupt_terminal_session` | Ctrl-C |
| `close_terminal_session` | Kill + cleanup |

Workspace sets **initial cwd** under `allowed_roots`. It is **not** an OS sandbox. Launch argv is never shell-interpolated; intentional typed input is authorized execution.

## Model option

- Cursor: `--model` only if CLI help exposes it.
- Kimi: `-m` / `--model` only if help exposes it. No `--effort` flag.
- Requested model is applied as a CLI flag; **effective** model is not independently verified.

## Setup / activation

1. Ensure `node-pty` is installed (`npm install` at repo root). `postinstall` runs `scripts/fix-node-pty.sh` so `spawn-helper` is executable (otherwise PTY spawn fails with `posix_spawnp failed`).
2. Prefer absolute binaries in `config.yaml` for launchd’s thin PATH:

```yaml
agents:
  cursor:
    binary: /Users/YOU/.local/bin/agent
  kimi:
    binary: /Users/YOU/.kimi-code/bin/kimi
worker:
  terminal_sessions:
    default_idle_sec: 3600
    default_cols: 120
    default_rows: 40
```

3. **Activation requires restarting the LaunchAgents** (not `start-stable.sh` alone — that script is a parallel PID-file path and does **not** replace `com.groundcontrol.*`). Live agents load MCP tools + worker RPC handlers at process start. When idle:

```bash
launchctl kickstart -k "gui/$(id -u)/com.groundcontrol.relay"
launchctl kickstart -k "gui/$(id -u)/com.groundcontrol.worker"
```

Then refresh the ChatGPT / MCP client tool list (reconnect the connector) so new terminal tools and server instructions appear.

## Thread / chat memory

- **ChatGPT chat history is not auto-sent to Cursor/Kimi.** When opening or continuing a PTY, include the relevant goals/constraints in `write_terminal_input` (or in a `start_task` prompt).
- **Mac-side continuity** = the live PTY + `read_terminal_output` offsets (and the agent CLI’s own REPL memory). Prefer one long-lived `create_terminal_session` per task thread.
- **`start_task`** is fire-and-forget (`agent -p` / `kimi -p`); use `send_followup` for queued direction — weaker than a live session.

## Rollback

Revert/redeploy the previous worker+relay tree and restart both processes. Existing SQLite managed jobs keep working; in-memory PTYs from this feature are gone on stop either way.

## Smoke (local, no paid model loop)

```bash
npm run build
node scripts/smoke-terminal-sessions.mjs   # temp ports; does not touch LaunchAgents
```

Or after activation: `create_terminal_session` (shell) → `write_terminal_input` with a printf marker + `submit` → `read_terminal_output` → `close_terminal_session`.

## Managed jobs note

`get_task_output` now streams while a job runs. `send_followup` during a run marks `awaiting_followup`; when the process exits successfully, queued follow-ups re-launch **even without** a parsed `session_id` (prompt fold-in). Worker restart still fails in-flight/`awaiting_followup` jobs without auto-retry.
