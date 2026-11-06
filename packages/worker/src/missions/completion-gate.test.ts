import { describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { JobRecord } from "@agent-control/shared";
import type { MissionRecord } from "./store.js";
import { assertCanSubmitReview, assertCanComplete } from "./completion-gate.js";
import { initGitFixture, makeTempRoot } from "../test-utils.js";

function baseMission(overrides: Partial<MissionRecord> = {}): MissionRecord {
  return {
    id: "m1",
    owner_id: "owner-test",
    title: "t",
    goal: "g",
    workspace: null,
    status: "verifying",
    plan: null,
    findings: null,
    summary: null,
    linked_job_ids: ["j1"],
    linked_session_ids: [],
    markers: {
      mission_contract_json: JSON.stringify({
        version: 1,
        steps: [{ id: "a", title: "A", kind: "synthetic" }],
        supervision: { max_step_retries: 1, backoff_sec: 0 },
        evidence: { require_git_head: true, require_usability: false },
      }),
      "step_done:a": true,
      evidence_git_head: "abc",
      supervisor_work_path: "/tmp",
      review_packet_version: 1,
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    approved_at: null,
    completed_at: null,
    ...overrides,
  };
}

describe("completion-gate", () => {
  it("rejects stale git evidence", () => {
    const root = makeTempRoot();
    const fixture = join(root, "fixture");
    mkdirSync(fixture, { recursive: true });
    initGitFixture(fixture);
    const mission = baseMission({
      markers: {
        ...baseMission().markers,
        evidence_git_head: "deadbeef",
        supervisor_work_path: fixture,
      },
    });
    const jobs = new Map<string, JobRecord>([
      [
        "j1",
        {
          id: "j1",
          owner_id: "owner-test",
          project_id: "p",
          agent: "mock",
          prompt: "",
          status: "succeeded",
          idempotency_key: null,
          session_id: null,
          work_path: null,
          container_id: null,
          exit_code: 0,
          error: null,
          summary: null,
          created_at: "",
          updated_at: "",
          started_at: null,
          finished_at: null,
          timeout_sec: 60,
        },
      ],
    ]);
    const gate = assertCanSubmitReview(mission, jobs);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.code).toBe("stale_git_evidence");
  });

  it("blocks complete without owner release on contract missions", () => {
    const mission = baseMission({ status: "ready_for_review" });
    const jobs = new Map<string, JobRecord>();
    const gate = assertCanComplete(mission, jobs);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.code).toBe("owner_release");
  });

  it("requires recorded Work UI evidence when the contract asks for it", () => {
    const mission = baseMission({
      markers: {
        ...baseMission().markers,
        mission_contract_json: JSON.stringify({
          version: 1, steps: [{ id: "a", title: "A", kind: "synthetic" }],
          supervision: { max_step_retries: 1, backoff_sec: 0 },
          evidence: { require_git_head: false, require_usability: false, require_work_ui_evidence: true },
        }),
      },
    });
    const succeeded = new Map<string, JobRecord>([["j1", {
      id: "j1", owner_id: "owner-test", project_id: "p", agent: "mock", prompt: "",
      status: "succeeded", idempotency_key: null, session_id: null, work_path: null,
      container_id: null, exit_code: 0, error: null, summary: null, created_at: "", updated_at: "",
      started_at: null, finished_at: null, timeout_sec: 60,
    }]]);
    expect(assertCanSubmitReview(mission, succeeded)).toMatchObject({ ok: false, code: "work_ui_evidence" });
    mission.markers.work_ui_evidence = "pass";
    mission.markers.work_ui_evidence_at = new Date().toISOString();
    expect(assertCanSubmitReview(mission, succeeded)).toEqual({ ok: true });
  });
});
