import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APPROVAL_SOURCE_CHAT_EXPLICIT } from "../approval-policy.js";
import { createService, initGitFixture, makeTempRoot } from "../test-utils.js";
import type { WorkerService } from "../service.js";
import {
  MissionContractSchema,
  nextPendingStep,
  stepMarkerDone,
} from "./contract.js";
import {
  compileQualificationToContract,
  defaultGroundDeliveryEnqueueKey,
} from "./compile-contract.js";
import {
  qualificationMarkerPayload,
  qualificationFromMission,
  QualificationPacketSchema,
  type QualificationPacket,
} from "./qualification.js";
import { missionSupervisorTick, resetSupervisorThrottleForTests } from "./supervisor.js";

const services: WorkerService[] = [];
afterEach(() => {
  for (const s of services.splice(0)) s.close();
});

function sampleQualification(overrides?: Partial<QualificationPacket>): QualificationPacket {
  return QualificationPacketSchema.parse({
    version: 1,
    objective: "Prove Ground Delivery v2 enrollment",
    context: "Worker unit tests with mock supervisor.",
    scope_in: ["Compile contract from packet", "Enqueue on approve"],
    scope_out: ["Production deploy"],
    acceptance_tests: [
      { id: "unit", description: "Worker vitest green", command: "npm test" },
    ],
    constraints: ["No push or deploy"],
    risk: "Low — test fixture only",
    workspace: "demo-sandbox",
    deployment_policy: { mode: "owner_release_required" },
    owner_checkpoints: [
      {
        id: "review",
        title: "Review implementation",
        when: "after_implement",
      },
    ],
    ...overrides,
  });
}

describe("MissionContractSchema v1 compatibility", () => {
  it("parses legacy v1 contracts without v2-only fields", () => {
    const parsed = MissionContractSchema.parse({
      version: 1,
      steps: [
        { id: "s1", title: "One", kind: "synthetic", agent: "mock", project_id: "demo-sandbox" },
      ],
      supervision: { max_step_retries: 2, backoff_sec: 5 },
      evidence: { require_git_head: true, require_usability: false },
    });
    expect(parsed.version).toBe(1);
    expect(parsed.cleanup.cancel_active_jobs).toBe(true);
    expect(parsed.budgets.resource_class).toBe("default");
  });
});

describe("compileQualificationToContract", () => {
  it("defaults a stored v1 packet to codex for its implement step", () => {
    const storedV1Packet = {
      version: 1,
      objective: "Prove backwards compatibility",
      context: "Existing packet before execution-agent selection.",
      scope_in: ["Compile contract"],
      acceptance_tests: [{ id: "unit", description: "Unit tests pass" }],
      risk: "Low",
      workspace: "demo-sandbox",
      deployment_policy: { mode: "no_production" },
    };
    const packet = qualificationFromMission({
      markers: { qualification_packet_json: JSON.stringify(storedV1Packet) },
    } as Parameters<typeof qualificationFromMission>[0]);

    expect(packet?.execution_agent).toBe("codex");
    expect(compileQualificationToContract(packet!).steps.find((s) => s.id === "implement")?.agent)
      .toBe("codex");
  });

  it("compiles an explicit cursor execution-agent choice", () => {
    const contract = compileQualificationToContract(
      sampleQualification({ execution_agent: "cursor" }),
    );

    expect(contract.steps.find((s) => s.id === "implement")?.agent).toBe("cursor");
  });

  it("orders steps with dependencies and owner checkpoints", () => {
    const packet = sampleQualification({
      owner_checkpoints: [
        { id: "pre", title: "Pre-flight", when: "before_implement" },
        { id: "post", title: "Post review", when: "after_implement" },
      ],
      acceptance_tests: [
        { id: "a", description: "Test A" },
        { id: "b", description: "Test B" },
      ],
    });
    const contract = compileQualificationToContract(packet, { plan: "Do the work" });
    expect(contract.version).toBe(2);
    expect(contract.steps.map((s) => s.id)).toEqual([
      "owner_pre",
      "implement",
      "owner_post",
      "verify_a",
      "verify_b",
    ]);
    expect(contract.steps.find((s) => s.id === "verify_b")?.depends_on).toEqual(["verify_a"]);
  });

  it("respects dependency ordering in nextPendingStep", () => {
    const packet = sampleQualification({
      owner_checkpoints: [],
      acceptance_tests: [{ id: "only", description: "One verify" }],
    });
    const contract = compileQualificationToContract(packet);
    const mission = {
      id: "m",
      markers: {
        [stepMarkerDone("implement")]: false,
      },
    } as Parameters<typeof nextPendingStep>[0];
    expect(nextPendingStep(mission, contract)?.id).toBe("implement");
    const afterImplement = {
      ...mission,
      markers: { ...mission.markers, [stepMarkerDone("implement")]: true },
    };
    expect(nextPendingStep(afterImplement, contract)?.id).toBe("verify_only");
  });
});

describe("Ground Delivery v2 approve + enroll", () => {
  function v2Mission(service: WorkerService) {
    const root = makeTempRoot();
    const fixture = join(root, "fixture");
    mkdirSync(fixture, { recursive: true });
    initGitFixture(fixture);
    const m = service.createMission({
      ownerId: "owner-test",
      title: "V2 mission",
      goal: "auto enroll",
      workspace: "demo-sandbox",
      markers: qualificationMarkerPayload(sampleQualification()),
    });
    service.updateMission("owner-test", m.id, {
      status: "plan_ready",
      plan: "Implement and verify in tests",
    });
    return m.id;
  }

  it("fail-closed approve when v2 lacks qualification packet", async () => {
    const root = makeTempRoot();
    const fixture = join(root, "fixture");
    mkdirSync(fixture, { recursive: true });
    initGitFixture(fixture);
    const service = createService(root, fixture);
    services.push(service);
    const m = service.createMission({
      ownerId: "owner-test",
      title: "Broken v2",
      goal: "missing packet",
      markers: { ground_delivery_v2: true },
    });
    service.updateMission("owner-test", m.id, {
      status: "plan_ready",
      plan: "Plan without packet",
    });
    await expect(
      service.approveMission("owner-test", m.id, {
        authorization: APPROVAL_SOURCE_CHAT_EXPLICIT,
      }),
    ).rejects.toThrow(/qualification_packet_json/);
  });

  it("compiles contract and idempotently enqueues on approve", async () => {
    const root = makeTempRoot();
    const fixture = join(root, "fixture");
    mkdirSync(fixture, { recursive: true });
    initGitFixture(fixture);
    const service = createService(root, fixture);
    service.config.supervisor = { enabled: true, poll_missions_sec: 1, queue_max_concurrent: 1 };
    services.push(service);

    const missionId = v2Mission(service);
    const result = await service.approveMission("owner-test", missionId, {
      authorization: APPROVAL_SOURCE_CHAT_EXPLICIT,
    });
    expect(result.approved).toBe(true);
    expect(result.mission.markers.contract_version).toBe(2);
    expect(result.mission.markers.approved_contract_version).toBe(2);
    expect(result.mission.markers.ground_delivery_enrolled).toBe(true);
    expect(result.mission.markers.project_active).toBe(true);

    const queue = service.listMissionQueue("owner-test");
    expect(queue).toHaveLength(1);
    expect(queue[0]!.enqueue_key).toBe(defaultGroundDeliveryEnqueueKey(missionId));
    expect(queue[0]!.mission_id).toBe(missionId);

    const again = await service.approveMission("owner-test", missionId, {
      authorization: APPROVAL_SOURCE_CHAT_EXPLICIT,
    });
    expect(again.already_approved).toBe(true);
    expect(service.listMissionQueue("owner-test")).toHaveLength(1);
  });

  it("starts approved and enrolled v2 implementation with codex instead of blocking for a missing agent", async () => {
    const root = makeTempRoot();
    const fixture = join(root, "fixture");
    mkdirSync(fixture, { recursive: true });
    initGitFixture(fixture);
    const service = createService(root, fixture);
    service.config.supervisor = { enabled: true, poll_missions_sec: 0, queue_max_concurrent: 1 };
    service.config.worker.agent_execution = "host";
    service.config.agents.codex.enabled = true;
    services.push(service);

    const startTask = vi.spyOn(service, "startTask").mockReturnValue({ id: "mocked-codex-job" } as never);
    const missionId = v2Mission(service);
    await service.approveMission("owner-test", missionId, {
      authorization: APPROVAL_SOURCE_CHAT_EXPLICIT,
    });

    resetSupervisorThrottleForTests();
    missionSupervisorTick(service);

    const mission = service.getMission("owner-test", missionId);
    expect(startTask).toHaveBeenCalledWith(expect.objectContaining({ agent: "codex" }));
    expect(mission.markers.ground_delivery_enrolled).toBe(true);
    expect(mission.markers.block_reason).toBeNull();
    expect(mission.markers.supervision_state).toBe("running");
  });

  it("owner checkpoint ack clears pause and marks step done", () => {
    const root = makeTempRoot();
    const fixture = join(root, "fixture");
    mkdirSync(fixture, { recursive: true });
    initGitFixture(fixture);
    const service = createService(root, fixture);
    services.push(service);

    const contract = compileQualificationToContract(sampleQualification());
    const mission = service.missions.create({
      ownerId: "owner-test",
      title: "checkpoint",
      goal: "g",
      markers: {
        project_active: true,
        mission_contract_json: JSON.stringify(contract),
        contract_version: 2,
        supervision_state: "paused",
        current_step_id: "owner_review",
        owner_checkpoint_pending: "owner_review",
      },
    });

    service.acknowledgeMissionOwnerCheckpoint("owner-test", mission.id, "owner_review");
    const after = service.getMission("owner-test", mission.id);
    expect(after.markers["step_done:owner_review"]).toBe(true);
    expect(after.markers.supervision_state).toBe("idle");
    expect(after.markers.owner_checkpoint_pending).toBeNull();
  });
});
