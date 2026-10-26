import { describe, expect, it } from "vitest";
import { PUBLIC_DEMO_MEASURED_AT, publicBoardFeedDemo } from "./board-extensions/public-demo.js";
import {
  PUBLIC_BOARD_ALLOWLIST,
  redactBoardForPublic,
} from "./board-extensions/public-redact.js";

const FIXTURE_MARKERS = {
  missionTitle: "fixture-mission-title-unique",
  missionGoal: "fixture-mission-goal-sensitive",
  terminalTail: "fixture-terminal-tail-secret-output",
  approvalTitle: "fixture-approval-wire-transfer",
  taskId: "fixture-task-id-abcdef12",
  memorySlug: "daily/fixture-memory-slug",
  projectTitle: "fixture-active-project-title",
  accountNote: "fixture-yg3-account-activity-line",
  extensionInsight: "fixture-live-growth-insight-body",
};

function richOperationalBoard(): Record<string, unknown> {
  return {
    at: "2026-10-25T12:00:00.000Z",
    owner: { id: "owner-real", display_name: "Owner Name" },
    missions: [
      {
        id: "mission-uuid-full-12345678",
        title: FIXTURE_MARKERS.missionTitle,
        goal: FIXTURE_MARKERS.missionGoal,
        status: "implementing",
      },
    ],
    columns: {
      implementing: [{ id: "m1", title: FIXTURE_MARKERS.missionTitle }],
      done: [{ id: "m2", title: "Completed fixture mission" }],
    },
    approvals: [{ id: "appr-1", title: FIXTURE_MARKERS.approvalTitle }],
    tasks: [{ id: FIXTURE_MARKERS.taskId, status: "running", title: "job" }],
    active_tasks: [{ id: "active-1", status: "running" }],
    recent_tasks: [{ id: "recent-1", status: "done" }],
    terminal_sessions: [
      {
        id: "term-1",
        kind: "cursor",
        state: "running",
        output_tail: FIXTURE_MARKERS.terminalTail,
      },
    ],
    kpis: [{ key: "reply_rate", value: "high", mission: FIXTURE_MARKERS.missionTitle }],
    usage: { kimi: { starts_remaining: 3 }, cursor: { starts_remaining: 5 } },
    health: {
      worker: true,
      open_terminals: 4,
      active_missions: 2,
      pending_approvals: 1,
      relay_hint: "ws://fixture-relay-host/worker",
    },
    system_state: { state: "on_a_project", label: "ON A PROJECT" },
    user_led_project: {
      active: true,
      mission_id: "mission-uuid-full-12345678",
      title: FIXTURE_MARKERS.projectTitle,
    },
    learning_activity: null,
    markers: { area: FIXTURE_MARKERS.accountNote },
    brain_recent: [{ slug: FIXTURE_MARKERS.memorySlug, title: "Memory note" }],
    growth_brief: { insights: [{ body: FIXTURE_MARKERS.extensionInsight }] },
  };
}

describe("publicBoardFeedDemo (worker offline)", () => {
  it("returns deterministic allowlisted public_preview without error field", () => {
    const out = publicBoardFeedDemo();
    expect(out.public_preview).toBe(true);
    expect(out.at).toBe(PUBLIC_DEMO_MEASURED_AT);
    expect(out.health).toEqual({ worker: false });
    expect(out.error).toBeUndefined();
    expect(Object.keys(out).sort()).toEqual([...PUBLIC_BOARD_ALLOWLIST].sort());
  });
});

describe("anonymous board projection (structural isolation)", () => {
  it("returns public_preview with allowlisted keys only", () => {
    const out = redactBoardForPublic(richOperationalBoard());
    expect(out.public_preview).toBe(true);
    expect(Object.keys(out).sort()).toEqual([...PUBLIC_BOARD_ALLOWLIST].sort());
  });

  it("cannot contain jobs, terminals, missions, memory, or live extension content", () => {
    const out = redactBoardForPublic(richOperationalBoard());
    const json = JSON.stringify(out);
    for (const marker of Object.values(FIXTURE_MARKERS)) {
      expect(json).not.toContain(marker);
    }
    expect(json).not.toMatch(/mission-uuid/);
    expect(json).not.toMatch(/open_terminals/);
    expect(json).not.toMatch(/relay_hint/);
    expect((out.missions as unknown[]).length).toBeGreaterThan(0);
    expect(JSON.stringify(out)).not.toContain(FIXTURE_MARKERS.missionTitle);
    expect((out.owner as { id: string }).id).toBe("public");
    expect(out.health).toEqual({ worker: false });
  });
});
