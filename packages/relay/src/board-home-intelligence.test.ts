import { describe, expect, it } from "vitest";
import { buildHomeSuitHud } from "./board-home-instrument.js";
import {
  PROJECT_ORIGIN_AUTONOMOUS_LEARNING,
  PROJECT_ORIGIN_USER_LED,
  resolveHomeFocusTitleFromBoard,
  resolveSystemStateFromBoard,
  systemStateIsConsistent,
} from "./board-home-intelligence.js";

describe("resolveSystemStateFromBoard", () => {
  it("is COOLING with zero active jobs even when terminals run", () => {
    expect(
      resolveSystemStateFromBoard({
        health: { worker: true },
        tasks: [],
        terminal_sessions: [
          { state: "running", kind: "cursor", last_activity_at: new Date().toISOString() },
        ],
      }),
    ).toEqual({
      key: "cooling",
      label: "COOLING",
      origin: null,
      missionId: null,
      projectTitle: null,
    });
  });

  it("is ON A PROJECT only with active user-led job linked to mission", () => {
    const board = {
      missions: [
        {
          id: "m1",
          title: "Mirror HUD",
          status: "implementing",
          updated_at: "2026-03-02T00:00:00Z",
          linked_job_ids: ["j1"],
          markers: { project_origin: PROJECT_ORIGIN_USER_LED, project_active: true },
        },
      ],
      active_tasks: [{ id: "j1", status: "running" }],
      system_state: {
        state: "on_a_project",
        label: "ON A PROJECT",
        origin: PROJECT_ORIGIN_USER_LED,
        mission_id: "m1",
        title: "Mirror HUD",
      },
      user_led_project: {
        active: true,
        origin: PROJECT_ORIGIN_USER_LED,
        mission_id: "m1",
        title: "Mirror HUD",
      },
    };
    expect(resolveSystemStateFromBoard(board).label).toBe("ON A PROJECT");
    expect(systemStateIsConsistent(board)).toBe(true);
  });

  it("active mission and stale ON A PROJECT with zero jobs resolves to COOLING", () => {
    const board = {
      missions: [
        {
          id: "m1",
          title: "Mirror HUD",
          status: "implementing",
          updated_at: "2026-03-02T00:00:00Z",
          linked_job_ids: ["j1"],
          markers: { project_origin: PROJECT_ORIGIN_USER_LED },
        },
      ],
      active_tasks: [],
      system_state: {
        state: "on_a_project",
        label: "ON A PROJECT",
        origin: PROJECT_ORIGIN_USER_LED,
        mission_id: "m1",
        title: "Mirror HUD",
      },
      user_led_project: null,
    };
    expect(resolveSystemStateFromBoard(board)).toMatchObject({
      key: "cooling",
      label: "COOLING",
    });
    expect(resolveHomeFocusTitleFromBoard(board)).toBeNull();
    expect(
      buildHomeSuitHud({
        board,
        owner: true,
        attention: 0,
        decisions: 0,
        boardHydrated: true,
        nowMs: Date.parse("2026-03-22T12:00:00.000Z"),
      }).project,
    ).toMatchObject({ label: "STATUS", title: "READY" });
    expect(systemStateIsConsistent(board)).toBe(false);
  });

  it("project_active focus with zero jobs is COOLING without home title", () => {
    const board = {
      user_led_project: {
        active: true,
        origin: PROJECT_ORIGIN_USER_LED,
        mission_id: "m1",
        title: "Mirror HUD",
      },
      system_state: { state: "cooling", label: "COOLING", origin: null, mission_id: null, title: null },
      active_tasks: [],
    };
    expect(resolveSystemStateFromBoard(board).label).toBe("COOLING");
    expect(resolveHomeFocusTitleFromBoard(board)).toBeNull();
  });

  it("is LEARNING only with autonomous job linked to mission", () => {
    const board = {
      missions: [
        {
          id: "l1",
          title: "Vault sleep",
          status: "implementing",
          linked_job_ids: ["j1"],
          markers: { project_origin: PROJECT_ORIGIN_AUTONOMOUS_LEARNING },
        },
      ],
      active_tasks: [{ id: "j1", status: "running" }],
      system_state: {
        state: "learning",
        label: "LEARNING",
        origin: PROJECT_ORIGIN_AUTONOMOUS_LEARNING,
        mission_id: "l1",
        title: "Vault sleep",
      },
      learning_activity: {
        active: true,
        origin: PROJECT_ORIGIN_AUTONOMOUS_LEARNING,
        mission_id: "l1",
        title: "Vault sleep",
        source: "cron:brain_sleep",
      },
    };
    expect(resolveSystemStateFromBoard(board).label).toBe("LEARNING");
    expect(systemStateIsConsistent(board)).toBe(true);
  });

  it("rejects learning_activity without autonomous origin", () => {
    expect(
      resolveSystemStateFromBoard({
        learning_activity: {
          active: true,
          mission_id: "x",
          title: "Nope",
          origin: PROJECT_ORIGIN_USER_LED,
        },
      }).label,
    ).toBe("COOLING");
  });

  it("prefers user_led job over autonomous_learning job", () => {
    const board = {
      missions: [
        {
          id: "l1",
          title: "Should not win",
          linked_job_ids: ["j-l"],
          markers: { project_origin: PROJECT_ORIGIN_AUTONOMOUS_LEARNING },
        },
        {
          id: "u1",
          title: "Owner work",
          updated_at: "2026-03-02T00:00:00Z",
          linked_job_ids: ["j-u"],
          markers: { project_origin: PROJECT_ORIGIN_USER_LED, project_active: true },
        },
      ],
      active_tasks: [
        { id: "j-l", status: "running" },
        { id: "j-u", status: "running" },
      ],
      system_state: {
        state: "on_a_project",
        label: "ON A PROJECT",
        origin: PROJECT_ORIGIN_USER_LED,
        mission_id: "u1",
        title: "Owner work",
      },
      user_led_project: {
        active: true,
        origin: PROJECT_ORIGIN_USER_LED,
        mission_id: "u1",
        title: "Owner work",
      },
      learning_activity: {
        active: true,
        origin: PROJECT_ORIGIN_AUTONOMOUS_LEARNING,
        mission_id: "l1",
        title: "Should not win",
      },
    };
    expect(resolveSystemStateFromBoard(board).missionId).toBe("u1");
    expect(systemStateIsConsistent(board)).toBe(true);
  });

  it("flags contradictory system_state vs learning_activity", () => {
    const board = {
      missions: [
        {
          id: "l2",
          title: "B",
          linked_job_ids: ["j1"],
          markers: { project_origin: PROJECT_ORIGIN_AUTONOMOUS_LEARNING },
        },
      ],
      active_tasks: [{ id: "j1", status: "running" }],
      system_state: {
        state: "learning",
        label: "LEARNING",
        origin: PROJECT_ORIGIN_AUTONOMOUS_LEARNING,
        mission_id: "l1",
        title: "A",
      },
      learning_activity: {
        active: true,
        origin: PROJECT_ORIGIN_AUTONOMOUS_LEARNING,
        mission_id: "l2",
        title: "B",
      },
    };
    expect(systemStateIsConsistent(board)).toBe(false);
  });
});
