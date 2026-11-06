import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventStore } from "../events/store.js";
import {
  killProcessGroupSync,
  processGroupAlive,
  spawnDetachedGroup,
} from "../isolation/process-group.js";
import { createService, initGitFixture, makeTempRoot } from "../test-utils.js";
import type { WorkerService } from "../service.js";
import { MissionStore } from "./store.js";
import {
  acceptanceEvidenceMarker,
} from "./acceptance-runner.js";
import {
  assertDeploymentGate,
  deploymentRecordMarkers,
} from "./deployment-record.js";
import { compileQualificationToContract } from "./compile-contract.js";
import { contractMarkerPayload, stepMarkerDone } from "./contract.js";
import { deriveMissionProgressEvents } from "./mission-progress-events.js";
import { missionTimelineFromEvents } from "./timeline.js";
import {
  qualificationMarkerPayload,
  QualificationPacketSchema,
} from "./qualification.js";
import { assertCanSubmitReview, resolveGitHead } from "./completion-gate.js";
import { resetSupervisorThrottleForTests, missionSupervisorTick } from "./supervisor.js";

const services: WorkerService[] = [];
afterEach(() => {
  for (const s of services.splice(0)) s.close();
});

function samplePacket(overrides?: Record<string, unknown>) {
  return QualificationPacketSchema.parse({
    version: 1,
    objective: "P2 delivery",
    context: "Unit tests",
    scope_in: ["Timeline and acceptance"],
    scope_out: [],
    acceptance_tests: [
      { id: "ok", description: "passes", command: "true" },
      { id: "bad", description: "fails", command: "false" },
    ],
    constraints: [],
    risk: "low",
    workspace: "demo-sandbox",
    deployment_policy: { mode: "owner_release_required" },
    owner_checkpoints: [],
    ...overrides,
  });
}

describe("Ground Delivery P2 — progress events rebuild", () => {
  it("derives step and acceptance events from markers without prompts", () => {
    const events = deriveMissionProgressEvents({
      id: "m1",
      updated_at: "2026-01-01T00:00:00.000Z",
      linked_job_ids: ["j1"],
      markers: {
        supervision_state: "idle",
        [stepMarkerDone("implement")]: true,
        [acceptanceEvidenceMarker("ok")]: "pass",
        deployment_record_at: "2026-01-02T00:00:00.000Z",
        deployment_record_kind: "owner_release",
      },
    });
    const verbs = events.map((e) => e.verb).sort();
    expect(verbs).toContain("mission.step_completed");
    expect(verbs).toContain("mission.acceptance_evidence");
    expect(verbs).toContain("mission.deployment_recorded");
    expect(JSON.stringify(events)).not.toMatch(/prompt/i);
  });

  it("rebuildFrom missions includes progress verbs", () => {
    const root = makeTempRoot();
    const missions = new MissionStore(join(root, "missions.db"));
    const events = new EventStore(join(root, "events.db"));
    const m = missions.create({
      ownerId: "owner-test",
      title: "Rebuild",
      goal: "g",
      markers: {
        [stepMarkerDone("implement")]: true,
        supervision_state: "idle",
      },
    });
    missions.update("owner-test", m.id, { markers: { project_active: true } });
    const report = events.rebuildFrom({ missions });
    expect(report.inserted).toBeGreaterThan(0);
    const listed = events.list({ limit: 50, source: "missions" });
    expect(listed.some((e) => e.verb === "mission.step_completed")).toBe(true);
    missions.close();
    events.close();
  });
});

describe("Ground Delivery P2 — mission timeline", () => {
  it("orders owner-visible entries from mission and job events", () => {
    const mission = {
      id: "mid",
      owner_id: "owner-test",
      title: "T",
      goal: "g",
      workspace: null,
      status: "implementing" as const,
      plan: null,
      findings: null,
      summary: null,
      linked_job_ids: ["jid"],
      linked_session_ids: [],
      markers: { supervision_state: "running", project_active: true },
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T01:00:00.000Z",
      approved_at: null,
      completed_at: null,
    };
    const timeline = missionTimelineFromEvents({
      mission,
      events: [
        {
          event_id: "a",
          occurred_at: "2026-01-01T00:00:01.000Z",
          observed_at: "2026-01-01T00:00:01.000Z",
          source: "missions",
          source_ref: "mid",
          actor: "system",
          verb: "mission.step_started",
          object_type: "mission_step",
          object_id: "implement",
          from_state: null,
          to_state: "implement",
          evidence_refs: ["mission:mid"],
          confidence: 1,
          sensitivity: "internal",
          schema_version: 1,
          adapter_version: 1,
          corrects: null,
        },
        {
          event_id: "b",
          occurred_at: "2026-01-01T00:00:02.000Z",
          observed_at: "2026-01-01T00:00:02.000Z",
          source: "jobs",
          source_ref: "jid",
          actor: "agent:mock",
          verb: "job.status_changed",
          object_type: "job",
          object_id: "jid",
          from_state: "running",
          to_state: "succeeded",
          evidence_refs: ["job:jid", "mission:mid"],
          confidence: 1,
          sensitivity: "internal",
          schema_version: 1,
          adapter_version: 1,
          corrects: null,
        },
      ],
      queueState: "running",
      hasActiveSupervisorJob: false,
    });
    expect(timeline.presentation.display_state).toBe("implementing");
    expect(timeline.entries.map((e) => e.verb)).toEqual([
      "mission.step_started",
      "job.status_changed",
    ]);
  });
});

describe("Ground Delivery P2 — acceptance commands", () => {
  it("blocks review when acceptance evidence is fail", () => {
    const root = makeTempRoot();
    const fixture = join(root, "fixture");
    mkdirSync(fixture, { recursive: true });
    initGitFixture(fixture);
    const head = resolveGitHead(fixture);
    const packet = samplePacket({
      acceptance_tests: [{ id: "t", description: "fail", command: "false" }],
    });
    const contract = compileQualificationToContract(packet);
    const mission = {
      id: "m",
      owner_id: "owner-test",
      title: "Acceptance fail",
      goal: "g",
      workspace: null,
      status: "verifying" as const,
      plan: null,
      findings: null,
      summary: null,
      linked_job_ids: ["j1"],
      linked_session_ids: [],
      markers: {
        ...contractMarkerPayload(contract),
        evidence_git_head: head,
        supervisor_work_path: fixture,
        review_packet_version: 1,
        [stepMarkerDone("implement")]: true,
        [stepMarkerDone("verify_t")]: true,
        [acceptanceEvidenceMarker("t")]: "fail",
      },
      created_at: "",
      updated_at: "",
      approved_at: null,
      completed_at: null,
    };
    const jobs = new Map([
      [
        "j1",
        {
          id: "j1",
          owner_id: "owner-test",
          project_id: "p",
          agent: "mock",
          status: "succeeded",
          summary: null,
          error: null,
          exit_code: 0,
          session_id: null,
          work_path: null,
          created_at: "",
          updated_at: "",
          started_at: "",
          finished_at: "",
          execution_meta: null,
        },
      ],
    ]);
    const gate = assertCanSubmitReview(mission, jobs);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.code).toBe("acceptance_evidence");
  });

  it("runs verify acceptance command via supervisor tick", async () => {
    const root = makeTempRoot();
    const fixture = join(root, "fixture");
    mkdirSync(fixture, { recursive: true });
    initGitFixture(fixture);
    const service = createService(root, fixture);
    service.config.supervisor = { enabled: true, poll_missions_sec: 0 };
    services.push(service);
    const packet = samplePacket({
      acceptance_tests: [{ id: "ok", description: "pass", command: "true" }],
      owner_checkpoints: [],
    });
    const contract = compileQualificationToContract(packet);
    const mission = service.createMission({
      ownerId: "owner-test",
      title: "Acceptance run",
      goal: "g",
      markers: {
        ...qualificationMarkerPayload(packet),
        ...contractMarkerPayload(contract),
        project_active: true,
        approved_contract_version: 2,
        supervision_state: "idle",
        supervisor_work_path: fixture,
        [stepMarkerDone("implement")]: true,
      },
    });
    service.missions.update("owner-test", mission.id, { status: "implementing" });
    resetSupervisorThrottleForTests();
    for (let i = 0; i < 20; i++) {
      await missionSupervisorTick(service);
      const m = service.missions.get("owner-test", mission.id)!;
      if (m.markers[acceptanceEvidenceMarker("ok")] === "pass") break;
    }
    const after = service.missions.get("owner-test", mission.id)!;
    expect(after.markers[acceptanceEvidenceMarker("ok")]).toBe("pass");
    expect(after.markers[stepMarkerDone("verify_ok")]).toBe(true);
  });
});

describe("Ground Delivery P2 — deployment gating", () => {
  it("requires staging deployment record before complete when policy is staging_only", () => {
    const contract = compileQualificationToContract(
      samplePacket({ deployment_policy: { mode: "staging_only" } }),
    );
    const mission = {
      id: "m",
      owner_id: "o",
      title: "t",
      goal: "g",
      workspace: null,
      status: "ready_for_review" as const,
      plan: "p",
      findings: null,
      summary: null,
      linked_job_ids: [],
      linked_session_ids: [],
      markers: contractMarkerPayload(contract),
      created_at: "",
      updated_at: "",
      approved_at: null,
      completed_at: null,
    };
    const gate = assertDeploymentGate(mission, contract, {
      ownerReleaseAuthorized: true,
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.code).toBe("staging_deploy_required");

    const withRecord = {
      ...mission,
      markers: {
        ...mission.markers,
        ...deploymentRecordMarkers({
          kind: "staging",
          recordedAt: new Date().toISOString(),
          policyMode: "staging_only",
        }),
      },
    };
    expect(
      assertDeploymentGate(withRecord, contract, { ownerReleaseAuthorized: true }).ok,
    ).toBe(true);
  });
});

describe("Ground Delivery P2 — process group cleanup", () => {
  it("kills detached sleep child on cancel", () => {
    const dir = mkdtempSync(join(tmpdir(), "pg-"));
    mkdirSync(dir, { recursive: true });
    const { pid } = spawnDetachedGroup("sleep", ["30"], { cwd: dir });
    expect(pid).toBeTruthy();
    expect(processGroupAlive(pid!)).toBe(true);
    killProcessGroupSync(pid!);
    expect(processGroupAlive(pid!)).toBe(false);
  });
});
