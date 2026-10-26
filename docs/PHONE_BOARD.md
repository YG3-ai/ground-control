# Watch Ground Control from your phone

Yes — use the **public board** on the same HTTPS host as ChatGPT MCP (ngrok). That is *your* Safari/Chrome on the phone, not ChatGPT’s cloud browser.

## URL

```text
https://YOUR_PUBLIC_BASE_URL/
```

`/board` still works for bookmarks from earlier cutovers. Canonical home is the site root — open healthz → `board_url` (same value as `public_base_url`).

Example: `https://my.parthaunnava.com/`

## Unlock (once per phone)

1. Open the public URL (root or `/board`) on your phone.
2. Enter the board **password** once (`BOARD_VIEW_SECRET` in `.env` — e.g. a memorable word; falls back to `OWNER_APPROVAL_SECRET` if unset).
3. Tap **Remember this phone** — long-lived cookie + localStorage (~13 months). You should not be asked again.
4. Optional: Share → **Add to Home Screen** for a one-tap icon.

Mobile UI: the **Home** tab is a compact command HUD. Top is a single dominant **objective surface**: a waiting approval (`Decide: …`), a blocked mission (`Unblock: …`), the current mission with its live status, or a quiet `Clear — no decisions waiting`. Current-mission priority is execution-first: `implementing`/`verifying` outrank `approved`/`plan_ready`/`researching`, which outrank `intake` (so an intake-only or unstarted item never displaces a mission that is actively building or verifying); ties break on most recent update. Below it a borderless **growth strip** shows only non-zero outcome signals (signups, trials, visit→signup % when valid, replies when outbound is active) and taps through to Growth, then a one-line **rank** (`Rank N · k to Rank N+1`, with the owner's real name when configured) that opens the capability tree. When you are unlocked as owner and the meaning engine has proposals, a single **Evolution** line may appear (proposed count only) — it never shows for public preview viewers. At most two **Recent** completions follow, with full history one tap away; technical provenance lives behind the **System details** disclosure. The tab bar is **Home · Growth · Missions · Brain** — Missions is its own panel (active + completed, one quiet line when empty); Skills is reached from the rank line; **Evolution** is a full-screen panel from that Home line or `?tab=evolution` (one capability summary, turning points grouped by month, detail sheet with Accept / Rename / Dismiss). Approvals keep the same Review → Approve/Decline sheet flow.

## Approving from the phone

Pending approvals (the same records behind the Mac dialogs) render as **Decisions** cards with Approve / Deny buttons. Tapping one POSTs to `POST /api/board/approvals/:id` (board key via cookie, `?k=`, or `x-ground-board-key` header):

- Auth fails closed: wrong/missing key → 401, nothing changes.
- `action` must be `approve` or `deny`; anything else → 400.
- Unknown id → 404; already-resolved (or duplicate taps) → 409, never reported as success.
- The relay first reads the record and only resolves it if still `pending`, so a decision taken on the Mac dialog always wins over a late phone tap.

Limit: resolving an approval only settles the approval record itself (the same `resolve_approval` contract the MCP tool uses). It does **not** advance any mission lifecycle — missions still move through `approve_mission` / `complete_mission` via ChatGPT or the Mac.

## What this is / isn’t

| Viewer | Sees board? |
| --- | --- |
| You on phone (Safari) via public root or `/board` | Yes — command-loop UI (Decisions, etc.) |
| You on Mac via `http://127.0.0.1:8787/` (or `/board`) | Yes — same command-loop UI as the phone |
| You on Mac via `http://127.0.0.1:8788/` | Yes — separate **mission whiteboard** (worker local control) |
| ChatGPT cloud browser | No (and shouldn’t — use MCP tools) |

Read-mostly. Mission control, status, and proof viewing are read-only; writes from the phone are resolving an existing pending approval (Approve/Deny above) and, for the owner only, recording meaning decisions on Evolution (accept, rename/correct, dismiss). Evolution APIs return `401 unauthorized` without a board key — public preview never sees counts, labels, or evidence.
