# Contributing

Thanks for helping improve Ground Control.

## Before you open a PR

1. Run `npm run doctor` and `npm run test:setup` on macOS.
2. Run `npm run typecheck` and `npm run build`.
3. Run `npm run check:release` and `npm run stage:release-candidate` — no secret or private-path findings.
4. Do not commit `.env`, `config.yaml`, `data/`, logs, Keychain exports, or YG3 raw caches.

## Scope

- Keep changes focused; match existing TypeScript and script style.
- Owner-only features must not leak data on the public read-only board path.
- YG3 integration changes stay read-only unless explicitly approved.

## Security

Report vulnerabilities privately — see [SECURITY.md](SECURITY.md).
