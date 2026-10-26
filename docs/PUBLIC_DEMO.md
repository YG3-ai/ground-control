# Public demo board

When `BOARD_PUBLIC_READ_ONLY=1`, visitors see the full Ground Control suit HUD with **deterministic fictional data** (Harbor Lantern Co.). No Keychain, live YG3, worker jobs, Second Brain files, or private caches are read.

## URLs for CTAs

| Variable | Purpose |
| --- | --- |
| `PUBLIC_REPO_URL` | “Install on Mac” opens this HTTPS GitHub URL (default: `https://github.com/YG3-ai/ground-control`). |
| `PUBLIC_DONATION_URL` | Optional Stripe (or other) support link. If unset or invalid, the support button is hidden. |

Example public donation link (YG3-hosted demo): `https://donate.stripe.com/6oU5kD83bfj4fP4aDsb7y0j`.

Set both in `.env` on the relay. Forks can point `PUBLIC_REPO_URL` at their own repo and replace demo copy in `packages/relay/src/board-extensions/public-fiction.ts` and `public-demo.ts`.

## Branding and copy

- Hero and marketing strings live in `packages/relay/src/board.html` (`#lm-public-hero`).
- Demo business narrative: `packages/relay/src/board-extensions/public-fiction.ts`.

## Screenshots

With relay running in public mode:

```bash
BOARD_BASE_URL=http://127.0.0.1:8787 BOARD_SHOT_DIR=docs/assets node scripts/capture-board-screenshots.mjs
```

Images are for README and docs only; they must not include private URLs or owner data.
