# Ground Control — macOS setup (operator checklist)

Canonical first-run path for a fresh clone. This is not zero-configuration: you supply relay secrets, `config.yaml`, and (for ChatGPT) a public HTTPS tunnel.

## Prerequisites

- **macOS only** for the official first release (Windows is not supported).
- macOS (Apple Silicon tested; Intel may work)
- Node.js **20+** (`package.json` engines; use `npm ci` with the lockfile)
- Optional: Docker Desktop (mock isolation image only)
- Optional: Cursor CLI and Kimi binaries (paths in `config.yaml`)
- **Obsidian** is an optional external editor for Markdown; Ground Control does not bundle it.
- **Second Brain** integration uses plain local Markdown via `BRAIN_*` env vars (vault path, Python CLI).

## Bootstrap (idempotent)

```bash
git clone <your-repo-url> ground-control
cd ground-control
npm run bootstrap
```

Creates `.env` and `config.yaml` **only when missing**, prepares `data/` and `logs/`, runs `npm ci`, and `npm run build`. Does not start services or overwrite existing config.

Flags: `./scripts/bootstrap.sh --skip-install --skip-build --only-dirs` for dry fixtures.

## First-run Mac setup (guided)

```bash
npm run setup:mac
```

One guided flow (idempotent): bootstrap/build when needed, config from examples, one-time YG3 browser sign-in if needed, workspace search/select prompts, optional Second Brain path, and—if you confirm—**installation of the YG3 background sync LaunchAgent** (daily 5:00 local, RunAtLoad, wake catch-up).

Flags: `--help` (no writes), `--dry-run`, `--non-interactive`, `--brain-root PATH`, `--test-root PATH` (never touches `~/Library/LaunchAgents`).

Remove background sync only: `npm run setup:mac:uninstall-yg3-sync`

Reconnect YG3 only if access is revoked (`npm run yg3:login`). Relay/worker always-on services remain in [OPERATOR_GUIDE.md](OPERATOR_GUIDE.md).

## Configure

1. Edit `.env` — set `WORKER_TOKEN`, `RELAY_JWT_SECRET`, `OWNER_APPROVAL_SECRET`, and `PUBLIC_BASE_URL`.
2. Edit `config.yaml` — relay WebSocket URL, `allowed_roots`, agent binary paths.
3. Local-only dev: `PUBLIC_BASE_URL=http://127.0.0.1:8787` and `ALLOW_DEV_TOKEN=1` (never on a public host).

Optional adapters (warn-only in doctor until set):

- `GROUND_CONTROL_WORK_ROOT` — separate product workspace for growth/board adapters.
- `BRAIN_ROOT`, `BRAIN_VAULT`, `BRAIN_PYTHON`, `BRAIN_SCRIPT` — local Markdown second brain.
- **YG3 marketing data** — optional official MCP path: see [YG3_MCP_INTEGRATION.md](YG3_MCP_INTEGRATION.md). Legacy workspace adapters remain the default until you enable MCP and authenticate.

## Preflight

```bash
npm run doctor
npm run doctor -- --probe-health   # if relay already on loopback
```

Blockers exit non-zero; optional adapters and tunnels are warnings.

## Run (foreground)

```bash
npm run relay    # terminal A
npm run worker   # terminal B
```

Or `./scripts/start-stable.sh` when `PUBLIC_BASE_URL` is a stable HTTPS host (see `docs/CHATGPT.md`, `docs/CLOUDFLARE_TUNNEL.md`).

## Verify

```bash
npm run verify:local
```

Checks loopback `healthz` and `worker.connected` only (no secret output).

## Always-on (optional, later)

`./scripts/install-launchagents.sh` renders LaunchAgents from `launchd/templates/` — run only after local verify. Not required for first boot.

## Related docs

- [ChatGPT / MCP](CHATGPT.md)
- [Access boundaries](ACCESS.md)
- [Phone board](PHONE_BOARD.md)
