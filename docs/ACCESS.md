# What can access what

## Trust boundaries

```
ChatGPT / OpenAI
    │  HTTPS + OAuth bearer
    ▼
Relay (public)
    │  WSS + WORKER_TOKEN (outbound from Mac)
    ▼
Worker (your login on the Mac)
    │  Docker API
    ▼
Agent container (non-root, optional read-only rootfs)
    └── /work  = one job worktree of one approved project
```

## Worker (host process)

**Can read/use**

- `config.yaml` and `data/policy/`
- SQLite job DB under `data/worker/`
- Registered project `source_path` values (to create git worktrees / copies)
- Docker engine
- `WORKER_TOKEN` and outbound connection to the relay

**Must not be writable by agents**

- Policy, relay credentials, OAuth secrets, and this configuration live outside `/work`

## Cursor / Kimi (default: host mode)

Managed child processes (not your interactive terminal). They run in a workspace under `allowed_roots` with the **same filesystem/git/network access** those CLIs normally have when you run them locally. That is intentional: ChatGPT is directing tools that already know your repos.

Concurrent jobs on the **same** live workspace are serialized (one active mutate at a time).

## Mock agent container (optional isolation demo)

**Can**

- Read/write the mounted job worktree at `/work`
- Use network only as configured (`none` by default)

**Cannot (enforced)**

- Docker socket, home, `.ssh`, Keychain
- Host paths that were not mounted (sentinel tested)
- Privilege elevation / host networking

## Returned to ChatGPT

Status, bounded logs, summaries, diffs, and test output after **best-effort** redaction.

Anything returned via MCP is shared with OpenAI. Do not put secrets in prompts or expect redaction to be perfect.

## Supervisor vs durable jobs

- **Durable jobs**: agent work continues on the Mac after a ChatGPT turn ends.
- **ChatGPT**: does not keep thinking after the conversation turn ends.
- **Autonomous supervisor** (`supervisor.enabled`): stays off until behavior, credentials, and cost limits are configured.
