# Release checklist

Use before tagging or publishing a public archive.

## Legal and metadata

- [ ] `LICENSE` is unmodified PolyForm Shield 1.0.0 with `Required Notice: Copyright 2026 YG3`
- [ ] `NOTICE` present
- [ ] `THIRD_PARTY_NOTICES.md` updated if dependencies changed

## Hygiene

- [ ] No `.env`, `config.yaml`, `data/`, `logs/`, or `launchd/rendered/` in the candidate
- [ ] `npm run check:release` passes
- [ ] `npm run stage:release-candidate` passes (secret + private path scan on staged tree)
- [ ] `npm run check:dependency-licenses` — no unknown or blocked licenses

## Quality (macOS)

- [ ] `npm run test:setup`
- [ ] `npm run test:release`
- [ ] `npm run typecheck` and `npm run build`
- [ ] Relay privacy tests (`board-public-http`, `yg3-sync`) pass

## Ship

- [ ] README commands verified with `npm run setup:mac -- --dry-run` on a clean temp root
- [ ] Do not publish until candidate manifest is clean
