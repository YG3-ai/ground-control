import { describe, expect, it } from "vitest";
import { buildGroundSuitHud } from "./board-suit-modes.js";
import {
  buildGroundJobRow,
  buildGroundSessionRow,
  formatGroundElapsed,
  GROUND_CURRENT_PROJECT_RESTING_LABEL,
  groundDisclosureDefaultOpen,
  groundSessionActivityLabel,
} from "./board-ground-present.js";

describe("formatGroundElapsed", () => {
  it("formats relative ages", () => {
    const now = Date.parse("2026-01-01T12:00:00Z");
    expect(formatGroundElapsed("2026-01-01T11:59:30Z", now)).toBe("30s");
    expect(formatGroundElapsed("2026-01-01T11:30:00Z", now)).toBe("30m");
  });
});

describe("groundSessionActivityLabel", () => {
  it("treats stale agent PTY as idle", () => {
    const label = groundSessionActivityLabel(
      {
        state: "running",
        kind: "cursor",
        last_activity_at: "2020-01-01T00:00:00Z",
      },
      Date.now(),
    );
    expect(label).toMatch(/idle/i);
  });

  it("marks recent agent activity as working", () => {
    const now = Date.now();
    const label = groundSessionActivityLabel(
      {
        state: "running",
        kind: "cursor",
        last_activity_at: new Date(now - 5000).toISOString(),
      },
      now,
    );
    expect(label).toBe("Working");
  });
});

describe("groundDisclosureDefaultOpen", () => {
  it("opens only when active count is positive", () => {
    expect(groundDisclosureDefaultOpen(0)).toBe(false);
    expect(groundDisclosureDefaultOpen(1)).toBe(true);
  });
});

describe("buildGroundJobRow", () => {
  it("uses summary as title and project from mission", () => {
    const row = buildGroundJobRow(
      {
        id: "j1",
        status: "running",
        agent: "kimi",
        mission_id: "m1",
        summary: "Fix HUD typography",
        started_at: "2026-01-01T10:00:00Z",
      },
      () => "Mirror HUD",
      Date.parse("2026-01-01T10:05:00Z"),
    );
    expect(row?.title).toBe("Fix HUD typography");
    expect(row?.project).toBe("Mirror HUD");
    expect(row?.executing).toBe(true);
  });
});

describe("buildGroundSessionRow", () => {
  it("does not label idle open shell as active work", () => {
    const row = buildGroundSessionRow(
      {
        id: "s1",
        state: "running",
        kind: "shell",
        workspace: "/Users/partha/Projects/agent-control",
      },
      Date.now(),
    );
    expect(row?.cognitivelyActive).toBe(false);
    expect(row?.activityLabel).toMatch(/idle/i);
    expect(row?.stateLabel).toBe("idle");
  });
});

describe("buildGroundSuitHud current project resting copy", () => {
  it("shows READY with no rows when nothing is tied to active work", () => {
    const m = buildGroundSuitHud(
      {
        columns: {},
        tasks: [],
        terminal_sessions: [],
      },
      true,
      () => "",
    );
    const current = m.sections.find((s) => s.id === "current_project");
    expect(current?.rows).toEqual([]);
    expect(current?.emptyLabel).toBe(GROUND_CURRENT_PROJECT_RESTING_LABEL);
  });
});

describe("buildGroundSuitHud disclosure metadata", () => {
  it("orders current project, jobs, terminals, and history", () => {
    const now = Date.parse("2026-01-01T12:00:00Z");
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
        tasks: [{ id: "j1", status: "queued", agent: "kimi", mission_id: "m1" }],
        terminal_sessions: [
          {
            id: "s1",
            state: "running",
            kind: "cursor",
            workspace: "/proj/agent-control",
            last_activity_at: new Date(now - 2000).toISOString(),
          },
        ],
      },
      true,
      () => "Ship",
      now,
    );
    expect(m.sections.map((s) => s.id)).toEqual([
      "current_project",
      "jobs",
      "terminals",
      "history",
    ]);
    expect(m.sections[0].collapsible).toBe(false);
    expect(m.sections[1].collapsible).toBe(true);
    expect(m.sections[1].defaultOpen).toBe(true);
    expect(m.sections[2].defaultOpen).toBe(true);
    const mission = m.sections[0].rows[0];
    expect(mission.kind).toBe("current_project");
    if (mission.kind === "current_project") expect(mission.title).toBe("Mirror HUD");
  });
});
