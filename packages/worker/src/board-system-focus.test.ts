import { describe, expect, it } from "vitest";
import {
  PROJECT_ORIGIN_AUTONOMOUS_LEARNING,
  PROJECT_ORIGIN_USER_LED,
  buildBoardSystemFocus,
} from "./board-system-focus.js";
import type { MissionRecord } from "./missions/store.js";

function mission(
  partial: Partial<MissionRecord> & Pick<MissionRecord, "id" | "title">,
): MissionRecord {
  return {
    owner_id: "o1",
    goal: "g",
    workspace: null,
    status: "implementing",
    plan: null,
    findings: null,
    summary: null,
    linked_job_ids: [],
    linked_session_ids: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    approved_at: null,
    completed_at: null,
    markers: {},
    ...partial,
  };
}

describe("buildBoardSystemFocus", () => {
  it("is COOLING when no project_active missions", () => {
    const p = buildBoardSystemFocus([
      mission({
        id: "m1",
        title: "Idle intake",
        status: "intake",
        markers: { project_origin: PROJECT_ORIGIN_USER_LED },
      }),
    ]);
    expect(p.system_state.label).toBe("COOLING");
    expect(p.user_led_project).toBeNull();
    expect(p.learning_activity).toBeNull();
  });

  it("is COOLING for project_active without active managed jobs", () => {
    const p = buildBoardSystemFocus(
      [
        mission({
          id: "u1",
          title: "Mirror HUD",
          status: "implementing",
          markers: { project_origin: PROJECT_ORIGIN_USER_LED, project_active: true },
          linked_job_ids: ["j1"],
        }),
      ],
      [{ id: "j1", status: "succeeded" }],
    );
    expect(p.system_state.label).toBe("COOLING");
    expect(p.user_led_project?.title).toBe("Mirror HUD");
    expect(p.learning_activity).toBeNull();
  });

  it("is ON A PROJECT only with active user-led managed job", () => {
    const p = buildBoardSystemFocus(
      [
        mission({
          id: "u1",
          title: "Mirror HUD",
          markers: { project_origin: PROJECT_ORIGIN_USER_LED, project_active: true },
          linked_job_ids: ["j1"],
        }),
      ],
      [{ id: "j1", status: "running" }],
    );
    expect(p.system_state).toMatchObject({
      label: "ON A PROJECT",
      origin: PROJECT_ORIGIN_USER_LED,
      mission_id: "u1",
      title: "Mirror HUD",
    });
    expect(p.user_led_project?.title).toBe("Mirror HUD");
  });

  it("is LEARNING only with active autonomous job", () => {
    const p = buildBoardSystemFocus(
      [
        mission({
          id: "l1",
          title: "Vault consolidate",
          markers: {
            project_origin: PROJECT_ORIGIN_AUTONOMOUS_LEARNING,
            project_active: true,
            enrichment_source: "cron:brain_sleep",
          },
          linked_job_ids: ["j2"],
        }),
      ],
      [{ id: "j2", status: "queued" }],
    );
    expect(p.system_state.label).toBe("LEARNING");
    expect(p.learning_activity?.source).toBe("cron:brain_sleep");
    expect(p.learning_activity?.origin).toBe(PROJECT_ORIGIN_AUTONOMOUS_LEARNING);
  });

  it("does not enter LEARNING from project_active alone", () => {
    const p = buildBoardSystemFocus([
      mission({
        id: "l1",
        title: "Auto enrich",
        markers: {
          project_origin: PROJECT_ORIGIN_AUTONOMOUS_LEARNING,
          project_active: true,
        },
      }),
    ]);
    expect(p.system_state.label).toBe("COOLING");
    expect(p.learning_activity).toBeNull();
  });

  it("prefers user_led active job over autonomous_learning job", () => {
    const p = buildBoardSystemFocus(
      [
        mission({
          id: "l1",
          title: "Auto enrich",
          updated_at: "2026-03-01T00:00:00Z",
          markers: { project_origin: PROJECT_ORIGIN_AUTONOMOUS_LEARNING },
          linked_job_ids: ["j-learn"],
        }),
        mission({
          id: "u1",
          title: "Owner ship",
          updated_at: "2026-03-02T00:00:00Z",
          markers: { project_origin: PROJECT_ORIGIN_USER_LED, project_active: true },
          linked_job_ids: ["j-user"],
        }),
      ],
      [
        { id: "j-learn", status: "running" },
        { id: "j-user", status: "running" },
      ],
    );
    expect(p.system_state.label).toBe("ON A PROJECT");
    expect(p.system_state.mission_id).toBe("u1");
    expect(p.system_state.title).toBe("Owner ship");
  });

  it("state and learning_activity align when learning", () => {
    const p = buildBoardSystemFocus(
      [
        mission({
          id: "l1",
          title: "Sleep cycle",
          markers: { project_origin: PROJECT_ORIGIN_AUTONOMOUS_LEARNING },
          linked_job_ids: ["j1"],
        }),
      ],
      [{ id: "j1", status: "running" }],
    );
    expect(p.system_state.mission_id).toBe(p.learning_activity?.mission_id);
    expect(p.system_state.title).toBe(p.learning_activity?.title);
  });
});
