import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildArchiveSuitHud,
  buildGroundSuitHud,
  buildYg3SuitHud,
  yg3HudShowsOwnerMetrics,
  boardOwnerHydratedForGround,
  dedupeArchiveItems,
  formatTerminalSessionLabel,
  normalizeArchiveSearchItem,
  suitHudHasNoPlaceholderZeros,
} from "./board-suit-modes.js";

describe("yg3HudShowsOwnerMetrics", () => {
  it("treats live partha-work or MCP growth as owner metrics when HUD gate is preview", () => {
    expect(yg3HudShowsOwnerMetrics(false, { ok: true, source: "yg3-mcp" })).toBe(true);
    expect(yg3HudShowsOwnerMetrics(false, { ok: true, source: "partha-work-runner" })).toBe(
      true,
    );
    expect(yg3HudShowsOwnerMetrics(false, { ok: true, source: "demo" })).toBe(false);
    expect(yg3HudShowsOwnerMetrics(true, { ok: true, source: "demo" })).toBe(true);
  });
});

describe("buildYg3SuitHud", () => {
  it("marks pending until growth is loaded", () => {
    const m = buildYg3SuitHud(null, true, false);
    expect(m.pending).toBe(true);
    expect(m.signals).toEqual([]);
  });

  it("shows demand signups and traffic headline slots for owner", () => {
    const m = buildYg3SuitHud(
      {
        ok: true,
        window: "7",
        summary: { visits: 120, signups: 4, demandSignups: 3, trials: 0 },
        outbound: { sent: 10, replies: 2 },
      },
      true,
      true,
    );
    expect(m.pending).toBe(false);
    expect(m.signals.map((s) => s.label)).toEqual(["DEMAND", "SIGNUPS", "TRAFFIC"]);
    expect(m.signals.map((s) => s.value)).toEqual(["3", "4", "120"]);
    expect(suitHudHasNoPlaceholderZeros(m.signals)).toBe(true);
  });

  it("marks unavailable headline metrics honestly", () => {
    const m = buildYg3SuitHud(
      {
        ok: true,
        window: "7",
        summary: { visits: null, signups: 0, demandSignups: null },
      },
      true,
      true,
    );
    expect(m.signals[0]).toMatchObject({ label: "DEMAND", value: "—", unavailable: true });
    expect(m.signals[1]).toMatchObject({ label: "SIGNUPS", value: "0" });
    expect(m.signals[2]).toMatchObject({ label: "TRAFFIC", value: "—", unavailable: true });
  });
});

describe("formatTerminalSessionLabel", () => {
  it("skips generic cwd disclaimer note", () => {
    const l = formatTerminalSessionLabel({
      id: "abc123",
      kind: "cursor",
      workspace: "/Users/YOU/Projects/agent-control",
      note: "Session cwd is the workspace root (not an OS sandbox). Process dies if the worker restarts.",
      state: "running",
    });
    expect(l.primary).toBe("cursor · agent-control");
    expect(l.primary).not.toMatch(/Session cwd/i);
  });
});

describe("buildGroundSuitHud", () => {
  it("stays empty when owner board is still public_preview", () => {
    const board = { public_preview: true, columns: { implementing: [{ id: "1", title: "X" }] } };
    expect(boardOwnerHydratedForGround(board, true)).toBe(false);
    expect(buildGroundSuitHud(board, true, () => "").sections).toEqual([]);
  });

  it("groups missions jobs and sessions into labeled sections", () => {
    const m = buildGroundSuitHud(
      {
        columns: {
          implementing: [
            {
              id: "m1",
              title: "Mirror HUD",
              status: "implementing",
              linked_job_ids: ["j1"],
              markers: { project_origin: "user_led" },
            },
          ],
        },
        tasks: [{ id: "j1", status: "running", agent: "kimi", mission_id: "m1" }],
        terminal_sessions: [
          {
            id: "s1",
            state: "running",
            kind: "cursor",
            workspace: "/proj/agent-control",
            note: "Session cwd is the workspace root (not an OS sandbox).",
          },
        ],
      },
      true,
      () => "Ship",
    );
    expect(m.sections.map((s) => s.id)).toEqual([
      "queue",
      "current_project",
      "jobs",
      "terminals",
      "history",
    ]);
    expect(m.sections[0].label).toBe("PROJECT QUEUE");
    expect(m.sections[1].label).toBe("CURRENT PROJECT");
    const currentRow = m.sections[1].rows[0];
    expect(currentRow.kind).toBe("current_project");
    if (currentRow.kind === "current_project") expect(currentRow.title).toBe("Mirror HUD");
    const termRow = m.sections[3].rows[0];
    expect(termRow.kind).toBe("session");
    if (termRow.kind === "session") expect(termRow.workspaceLabel).toBe("agent-control");
    expect(m.sections[2].label).toBe("JOBS");
    expect(m.sections[3].defaultOpen).toBe(false);
  });

  it("prepends NEEDS YOU when the board snapshot lists owner actions", () => {
    const m = buildGroundSuitHud(
      {
        needs_you: [
          {
            mission_id: "m-review",
            title: "Review packet",
            display_state: "ready_for_review",
            display_state_label: "Ready for review",
            next_owner_action: "Review the implementation and authorize release when satisfied.",
            blocker: null,
          },
        ],
        mission_queue: [],
        columns: {},
      },
      true,
      () => "",
    );
    expect(m.sections[0]?.id).toBe("needs_you");
    expect(m.sections[0]?.label).toBe("NEEDS YOU");
    expect(m.sections[1]?.id).toBe("queue");
  });

  it("keeps a queued blocked mission on one canonical card and nests its owner action", () => {
    const m = buildGroundSuitHud(
      {
        needs_you: [{
          mission_id: "m-blocked", title: "Fix Work", display_state: "blocked",
          display_state_label: "Blocked", next_owner_action: "Open the job output and fix the failing check.",
          blocker: "acceptance_terminal_not_review failed after 2 retries",
        }],
        mission_queue: [{
          id: "q-blocked", mission_id: "m-blocked", mission_title: "Fix Work",
          queue_state: "blocked", display_state: "blocked", display_state_label: "Blocked",
          blocker_detail: "acceptance_terminal_not_review failed after 2 retries",
          updated_at: "2026-11-05T15:00:00.000Z",
        }],
        columns: {},
      }, true, () => "", Date.parse("2026-11-05T15:05:00.000Z"),
    );
    expect(m.sections.find((s) => s.id === "needs_you")).toBeUndefined();
    const row = m.sections.find((s) => s.id === "queue")?.rows[0];
    expect(row).toMatchObject({ id: "m-blocked", detailLabel: "An automated verification step failed." });
    if (row?.kind === "mission") {
      expect(row.ownerActionLabel).toMatch(/Open the job output/i);
      expect(row.technicalDetail).toContain("acceptance_terminal_not_review");
      expect(row.statusLabel).toBe("Blocked · 5m ago");
    }
  });
});

describe("archive search rows", () => {
  it("dedupes by slug and keeps excerpt on one row", () => {
    const rows = dedupeArchiveItems([
      { slug: "notes/a", title: "Alpha", excerpt: "tags=foo" },
      { slug: "notes/a", title: "Alpha", excerpt: "tags=bar" },
      { slug: "notes/b", title: "Beta" },
    ]);
    expect(rows).toHaveLength(2);
    expect(normalizeArchiveSearchItem({ slug: "x/y", title: "T", excerpt: "T" })?.excerpt).toBeUndefined();
  });
});

describe("buildArchiveSuitHud", () => {
  it("disables search and clears recent for public", () => {
    const m = buildArchiveSuitHud(false, {
      ok: true,
      items: [{ slug: "a/b", title: "Note" }],
    });
    expect(m.searchEnabled).toBe(false);
    expect(m.recent).toEqual([]);
  });
});

describe("board.html suit mode markers", () => {
  const html = readFileSync(join(import.meta.dirname, "board.html"), "utf8");

  it("ships full HUD modes without world callouts", () => {
    expect(html).toContain("/* __suit_modes_start__ */");
    expect(html).toContain('id="lm-mode-yg3-hud"');
    expect(html).toContain('id="lm-mode-ground-hud"');
    expect(html).toContain('id="lm-archive-search-input"');
    expect(html).not.toContain('id="lm-world-callouts"');
    expect(html).not.toContain("lm-world-callout-label");
    expect(html).not.toContain("lm-mode-yg3-readout");
    expect(html).not.toContain("lm-mode-yg3-visual");
  });

  it("renders current project resting state as READY with mission title styling", () => {
    expect(html).toContain(
      'suitGroundSection("current_project", "CURRENT PROJECT", currentRows, currentRows.length, "READY")',
    );
    expect(html).toContain('section.id === "current_project"');
    expect(html).toContain("lm-ground-mission-title");
    expect(html).not.toMatch(
      /suitGroundSection\("current_project"[\s\S]*?"No active project"/,
    );
  });

  it("shades YG3 ground and archive slides for pan readability", () => {
    expect(html).toContain('.lm-suit-hud-slide[data-mode="yg3"]::before');
    expect(html).toContain('.lm-suit-hud-slide[data-mode="ground"]::before');
    expect(html).toContain('.lm-suit-hud-slide[data-mode="archive"]::before');
    expect(html).toContain(
      '.lm-suit-hud-slide:not([data-mode="home"]) .lm-mode-cluster',
    );
    expect(html).not.toContain('.lm-suit-hud-slide[data-mode="home"]::before');
  });

  it("unlocks YG3 headline metrics from live growth when public HUD gate is preview", () => {
    expect(html).toContain("function yg3HudShowsOwnerMetrics");
    expect(html).toContain("var presentOwner = yg3HudShowsOwnerMetrics(hudOwner, growthData)");
  });

  it("uses yg3 metric grid and grouped ground sections", () => {
    expect(html).toContain("lm-yg3-metrics");
    expect(html).toContain("lm-yg3-metric");
    expect(html).toContain("lm-yg3-accounts-feed");
    expect(html).toContain("NEW ACCOUNTS");
    expect(html).toContain("lm-mode-ground-sections");
    expect(html).toContain("lm-ground-disclosure");
    expect(html).toContain("lm-ground-history-feed");
    expect(html).not.toContain('data-ground-surface="skills"');
    expect(html).toContain("groundDisclosureState");
    expect(html).toContain("brainCorpusPresentation");
    expect(html).toContain("resolveBrainCorpusLoadState");
    expect(html).toContain("formatGroundElapsed");
    expect(html).toContain("lm-archive-search-field");
    expect(html).toContain("lm-mode-scroll");
    expect(html).toContain("lm-archive-result");
    expect(html).toContain("dedupeArchiveItems");
  });

  it("ships canonical Work cards with diagnostics that wrap on mobile", () => {
    expect(html).toContain("needsYouEntries.filter");
    expect(html).toContain("lm-ground-mission-card");
    expect(html).toContain("Technical details");
    expect(html).toContain("overflow-wrap: anywhere");
    expect(html).toContain("acceptance_[\\w-]+)");
  });

  it("keeps suit plane swipe rail intact", () => {
    expect(html).toContain('id="lm-suit-hud-plane"');
    expect(html).toContain('id="lm-mode-rail"');
    expect(html).toContain("commitSuitHudDragSnap");
  });

  it("archive HUD search respects owner gate in markup", () => {
    expect(html).toContain("input.disabled = !hudOwner");
    expect(html).toContain("/api/board/extensions/notes/search");
  });

  it("rail selection uses opacity backlight without tick dot", () => {
    expect(html).toContain(".lm-mode-rail .lm-world-chip-tick");
    expect(html).toContain("display: none !important");
    expect(html).not.toMatch(/lm-world-chip-label::after[\s\S]*?content:\s*["']/);
  });
});
