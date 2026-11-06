import { describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  createService,
  dockerAvailable,
  ensureMockImage,
  initGitFixture,
  makeTempRoot,
} from "../test-utils.js";
import { contractMarkerPayload, type MissionContract } from "./contract.js";
import {
  missionSupervisorOnJobFinished,
  resetSupervisorThrottleForTests,
} from "./supervisor.js";
describe("mission supervisor (synthetic)", () => {
  it("marks step done and advances on job finish without chat", () => {
    const root = makeTempRoot();
    const fixture = join(root, "fixture");
    mkdirSync(fixture, { recursive: true });
    initGitFixture(fixture);
    const service = createService(root, fixture);
    service.config.supervisor = { enabled: true, poll_missions_sec: 1 };

    const contract: MissionContract = {
      version: 1,
      steps: [
        { id: "s1", title: "one", kind: "synthetic", agent: "mock", project_id: "demo-sandbox" },
        { id: "s2", title: "two", kind: "synthetic", agent: "mock", project_id: "demo-sandbox" },
      ],
      supervision: { max_step_retries: 1, backoff_sec: 0 },
      evidence: { require_git_head: false, require_usability: false },
    };
    const mission = service.missions.create({
      ownerId: "owner-test",
      title: "unit",
      goal: "g",
      markers: {
        project_active: true,
        ...contractMarkerPayload(contract),
        current_step_id: "s1",
        "step_attempt:s1": 1,
        supervision_state: "running",
      },
    });
    const job1 = service.store.createJob({
      ownerId: "owner-test",
      projectId: "demo-sandbox",
      agent: "mock",
      prompt: "x",
      workPath: fixture,
      timeoutSec: 60,
      idempotencyKey: `mission:${mission.id}:step:s1:attempt:1`,
    });
    service.missions.update("owner-test", mission.id, {
      status: "implementing",
      linkJobId: job1.id,
    });

    missionSupervisorOnJobFinished(service, job1.id, "succeeded");
    const m1 = service.missions.get("owner-test", mission.id)!;
    expect(m1.markers["step_done:s1"]).toBe(true);
    expect(m1.markers.current_step_id).toBe("s2");

    const job2 = service.store.createJob({
      ownerId: "owner-test",
      projectId: "demo-sandbox",
      agent: "mock",
      prompt: "y",
      workPath: fixture,
      timeoutSec: 60,
      idempotencyKey: `mission:${mission.id}:step:s2:attempt:1`,
    });
    service.missions.update("owner-test", mission.id, {
      linkJobId: job2.id,
      markers: { current_step_id: "s2", "step_attempt:s2": 1, supervision_state: "running" },
    });
    missionSupervisorOnJobFinished(service, job2.id, "succeeded");
    const m2 = service.missions.get("owner-test", mission.id)!;
    expect(m2.markers["step_done:s2"]).toBe(true);
    expect(m2.status).toBe("verifying");
    service.close();
  });

  it.skipIf(!dockerAvailable())(
    "advances two mock steps without chat (docker integration)",
    async () => {
    ensureMockImage();
    const root = makeTempRoot();
    const fixture = join(root, "fixture");
    mkdirSync(fixture, { recursive: true });
    initGitFixture(fixture);
    const service = createService(root, fixture);
    const cfg = service.config;
    cfg.supervisor = { enabled: true, poll_missions_sec: 1 };
    service.start();
    resetSupervisorThrottleForTests();

    const contract: MissionContract = {
      version: 1,
      steps: [
        {
          id: "step1",
          title: "First synthetic stage",
          kind: "synthetic",
          agent: "mock",
          project_id: "demo-sandbox",
        },
        {
          id: "step2",
          title: "Second synthetic stage",
          kind: "synthetic",
          agent: "mock",
          project_id: "demo-sandbox",
        },
      ],
      supervision: { max_step_retries: 2, backoff_sec: 0 },
      evidence: { require_git_head: false, require_usability: false },
    };

    const mission = service.missions.create({
      ownerId: "owner-test",
      title: "synthetic acceptance",
      goal: "prove no-chat continuation",
      markers: {
        project_active: true,
        ...contractMarkerPayload(contract),
        approved_contract_version: 1,
        plan_approved: true,
        review_packet_version: 1,
      },
    });
    service.missions.update("owner-test", mission.id, {
      status: "approved",
      markers: { supervision_state: "idle" },
    });

    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const m = service.missions.get("owner-test", mission.id)!;
      if (m.markers["step_done:step1"] === true && m.markers["step_done:step2"] === true) {
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    const after = service.missions.get("owner-test", mission.id)!;
    expect(after.markers["step_done:step1"]).toBe(true);
    expect(after.markers["step_done:step2"]).toBe(true);
    expect(after.status).toBe("verifying");

    expect(after.linked_job_ids.length).toBeGreaterThanOrEqual(2);

    const review = await service.submitMissionReview("owner-test", mission.id, {
      summary: "synthetic review packet",
      review_packet_version: 1,
      notify: false,
    });
    expect(review.blocked).toBe(false);
    expect(review.mission.status).toBe("ready_for_review");

    service.stop();
  },
  150_000,
  );

  it("rejects review when steps incomplete", async () => {
    const root = makeTempRoot();
    const fixture = join(root, "fixture");
    mkdirSync(fixture, { recursive: true });
    initGitFixture(fixture);
    const service = createService(root, fixture);
    const contract: MissionContract = {
      version: 1,
      steps: [{ id: "only", title: "One", kind: "synthetic", agent: "mock", project_id: "demo-sandbox" }],
      supervision: { max_step_retries: 0, backoff_sec: 0 },
      evidence: { require_git_head: false, require_usability: false },
    };
    const mission = service.missions.create({
      ownerId: "owner-test",
      title: "blocked review",
      goal: "gate",
      markers: {
        project_active: true,
        ...contractMarkerPayload(contract),
        review_packet_version: 1,
      },
    });
    service.missions.update("owner-test", mission.id, { status: "verifying" });
    const review = await service.submitMissionReview("owner-test", mission.id, {
      summary: "too early",
      notify: false,
    });
    expect(review.blocked).toBe(true);
    if (review.blocked) expect(review.gate.code).toBe("steps_incomplete");
    service.close();
  });
});
