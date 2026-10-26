# Local awareness, approvals, and browser

ChatGPT on your phone should know what the Mac is doing, ask you before sensitive actions, and open a browser here when needed.

## Tools

| Tool | Purpose |
| --- | --- |
| `get_situation` | Snapshot: active/recent jobs, PTY sessions with output tails, approvals |
| `request_local_approval` | Mac dialog for **sensitive** actions only (hybrid_remote): destructive work, external sends/deploys, credentials, scope expansion, or explicit “approve locally”. Not for routine read/code/test/terminal inside an approved mission |
| `list_approvals` / `get_approval` | Pending / recent decisions |
| `notify_owner` | Non-blocking macOS banner |
| `open_url` | Open `http`/`https` in your default browser (approval required by default) |

## Hybrid remote approval policy

- **Chat-explicit mission approval:** After you consent in the ChatGPT thread, Ground records `approve_mission` with `authorization=chat_explicit` (markers: `approval_policy=hybrid_remote`, bounded `approved_scope`). No Mac dialog for that routine plan.
- **Mac dialog:** `require_dialog=true`, `authorization=local_dialog`, `request_local_approval`, or `open_url` (default) for sensitive or explicitly local approval.
- **No repeats:** An already-approved mission does not trigger another plan approval for in-scope work.

## How approval works

1. ChatGPT calls `request_local_approval` or `open_url` when the action is sensitive under hybrid_remote.
2. You get a **notification** and a **dialog** on this Mac (gui LaunchAgent session).
3. Approve or Deny. ChatGPT receives the result on that tool call.
4. If `wait=false`, the request stays pending; the menu bar (or `POST http://127.0.0.1:8788/approvals/<id>/approve`) can resolve it.

Loopback control API (menu bar only, not public):

- `GET http://127.0.0.1:8788/approvals`
- `POST http://127.0.0.1:8788/approvals/<id>/approve|deny`

## Config

```yaml
worker:
  local_control:
    enabled: true
    bind: 127.0.0.1
    port: 8788
    browser_requires_approval: true
    approval_timeout_sec: 120
```

## Activation

After pulling code:

```bash
launchctl kickstart -k "gui/$(id -u)/com.groundcontrol.relay"
launchctl kickstart -k "gui/$(id -u)/com.groundcontrol.worker"
```

Reconnect the ChatGPT connector so new tools/instructions appear. Rebuild the menu bar if you want Approve/Deny in the icon menu:

```bash
cd apps/menu-bar && swift build -c release
# then relaunch GroundControlMenu / LaunchAgent
```

## Limits

- Dialogs require the worker to run in your Aqua login session (normal LaunchAgent setup).
- `open_url` launches the browser; it does **not** drive page contents or click buttons (no remote browser automation yet).
- PTY tails in `get_situation` are redacted best-effort and shared with OpenAI when returned via MCP.
