<p align="center">
  <img src="apps/menu-bar/Resources/AppIcon.iconset/icon_256x256@2x.png" alt="Ground Control app icon" width="144" />
</p>

<h1 align="center">Ground Control</h1>

<p align="center"><strong>Turn your Mac into your team on the ground.</strong></p>

<p align="center">
  <a href="https://ground-control.yg3sites.com">Website</a>
  ·
  <a href="https://github.com/YG3-ai/ground-control/releases/tag/v0.1.0">v0.1.0 release</a>
  ·
  <a href="#install-on-your-mac">Install on Mac</a>
  ·
  <a href="https://donate.stripe.com/6oU5kD83bfj4fP4aDsb7y0j">Support development</a>
</p>

Start work from your phone. Ground Control hands missions to the right **local agents** on your Mac, keeps context in a **plain Markdown second brain**, and brings jobs, approvals, and signals back into one calm command view—so work keeps moving without sitting back down at a desk.

**macOS only** for the official first release (Windows is not supported). The project is **source-available and free to use** for your own business under [PolyForm Shield 1.0.0](LICENSE)—not OSI open source; do not repackage Ground Control as a competing product. See [NOTICE](NOTICE).

## What you get

- **Phone-side control** — Start and steer work from your phone; agents run on your Mac in your real project folders.
- **Local agents** — Cursor and Kimi stay on your machine, where your code already lives.
- **Second brain** — Optional Markdown vault for notes, search, and capture (Obsidian works well; it is never required).
- **YG3 marketing data** — Optional read-only YG3 connection for growth and account signals on the owner board.

## See it in action

The public read-only board uses fictional **Harbor Lantern Co.** demo data—no owner key required. Explore the full story on the [website](https://ground-control.yg3sites.com), or browse the [v0.1.0 release notes](https://github.com/YG3-ai/ground-control/releases/tag/v0.1.0).

| Phone (390×844) | Desktop command view |
| --- | --- |
| ![Ground Control on phone](docs/assets/ground-control-public-mobile-390x844.png) | ![Ground Control on desktop](docs/assets/ground-control-public-desktop-1280.png) |

Run your own anonymous demo locally with `BOARD_PUBLIC_READ_ONLY=1` on `/board`. Configure install and support links via `PUBLIC_REPO_URL` and `PUBLIC_DONATION_URL` in `.env` ([.env.example](.env.example), [docs/PUBLIC_DEMO.md](docs/PUBLIC_DEMO.md)). Forks can swap demo copy in `packages/relay/src/board-extensions/public-fiction.ts`.

Regenerate screenshots after UI changes (relay running in public mode):

```bash
BOARD_BASE_URL=http://127.0.0.1:8787 node scripts/capture-board-screenshots.mjs
```

## Three steps. Then walk away.

### 1. Install on your Mac

Clone this repository and run the guided macOS setup. It installs dependencies, creates config from examples when missing, and can wire always-on local services when you are ready.

### 2. Connect your tools (optional)

- **YG3** — One-time browser sign-in during setup if you want marketing data on the board. Say yes to the background sync job and data stays fresh on a daily schedule, at login, and after wake. You do **not** sign in every session; run `npm run yg3:login` only if access is revoked.
- **Second brain** — Point `BRAIN_*` env vars at any local Markdown folder during setup.
- **Agents** — Set Cursor/Kimi paths in `config.yaml` when setup prompts you.

### 3. Start from your phone

Open the board, send the mission, and let your Mac be the team on the ground. Tokens live in Keychain; caches under `data/` (gitignored). Your production data never ships with this repository.

## Install on your Mac

```bash
git clone https://github.com/YG3-ai/ground-control.git ground-control
cd ground-control
npm run setup:mac
npm run doctor
```

`setup:mac` is guided and idempotent: it runs bootstrap/build when needed, creates config from examples, and walks through YG3 and Second Brain prompts. Edit `.env` and `config.yaml` when setup reminds you—use strong random secrets, never commit them.

Open the owner board at `http://127.0.0.1:8787/board` after relay and worker are running ([Operator guide](docs/OPERATOR_GUIDE.md) for always-on services). For a step-by-step operator checklist (bootstrap flags, tunnels, verify), see [docs/SETUP_MAC.md](docs/SETUP_MAC.md).

## Troubleshooting

| Situation | What to run |
| --- | --- |
| Check configuration | `npm run doctor` |
| YG3 access revoked | `npm run yg3:login` (one-time browser sign-in) |
| Pick a different client workspace | `npm run yg3:workspaces:search -- "query"` then `npm run yg3:select -- --ref N` |
| Remove background YG3 sync only | `npm run setup:mac:uninstall-yg3-sync` |
| Relay + worker development | `npm run relay` and `npm run worker` |

More: [docs/SETUP_MAC.md](docs/SETUP_MAC.md) · [docs/YG3_MCP_INTEGRATION.md](docs/YG3_MCP_INTEGRATION.md) · [docs/OPERATOR_GUIDE.md](docs/OPERATOR_GUIDE.md)

## Customize and contribute

Fork and adapt for your workflow. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Free to use and customize for your own business. Do not repackage Ground Control as a competing product.

[PolyForm Shield 1.0.0](LICENSE) · [NOTICE](NOTICE)

## Support

- **Website:** [ground-control.yg3sites.com](https://ground-control.yg3sites.com)
- **Repository:** [github.com/YG3-ai/ground-control](https://github.com/YG3-ai/ground-control)
- **Donate:** [support Ground Control on Stripe](https://donate.stripe.com/6oU5kD83bfj4fP4aDsb7y0j) (optional; helps fund macOS development)
