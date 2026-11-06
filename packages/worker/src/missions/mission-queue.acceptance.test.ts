import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createService,
  initGitFixture,
  makeTempRoot,
} from "../test-utils.js";
import { contractMarkerPayload, type MissionContract } from "./contract.js";
import {
  missionQueueOnJobFinished,
  missionQueueTick,
  resetMissionQueueThrottleForTests,
} from "./queue-scheduler.js";
import {
  missionSupervisorOnJobFinished,
  resetSupervisorThrottleForTests,
} from "./supervisor.js";
import type { WorkerService } from "../service.js";

const services: WorkerService[] = [];
afterEach(() => {
  for (const s of services.splice(0)) {
    try {
      s.stop();
    } catch {
      s.close();
    }
  }
});

const stepContract = (id: string): MissionContract => ({
  version: 1,
  steps: [
    { id, title: id, kind: "synthetic", agent: "mock", project_id: "demo-sandbox" },
  ],
  supervision: { max_step_retries: 2, backoff_sec: 0 },
  evidence: { require_git_head: false, require_usability: false },
});

describe("mission queue (isolated acceptance)", () => {
  it("runs two projects sequentially without chat, survives restart, stops at ready_for_review", async () => {
    const root = makeTempRoot();
    const fixture = join(root, "fixture");
    mkdirSync(fixture, { recursive: true });
    initGitFixture(fixture);

    let service = createService(root, fixture);
    service.config.supervisor = {
      enabled: true,
      poll_missions_sec: 0,
      queue_max_concurrent: 1,
      queue_claim_lease_sec: 120,
    };
    services.push(service);

    const m1 = service.missions.create({
      ownerId: "owner-test",
      title: "project-one",
      goal: "first",
      markers: {
        ...contractMarkerPayload(stepContract("p1")),
        review_packet_version: 1,
      },
    });
    const m2 = service.missions.create({
      ownerId: "owner-test",
      title: "project-two",
      goal: "second",
      markers: {
        ...contractMarkerPayload(stepContract("p2")),
        review_packet_version: 1,
      },
    });
    service.missions.update("owner-test", m1.id, { plan: "Complete project one." });
    service.missions.update("owner-test", m1.id, { status: "approved", markers: { approval_policy: "hybrid_remote", approval_source: "chat_explicit", plan_approved: true } });
    service.missions.update("owner-test", m2.id, { plan: "Complete project two." });
    service.missions.update("owner-test", m2.id, { status: "approved", markers: { approval_policy: "hybrid_remote", approval_source: "chat_explicit", plan_approved: true } });

    service.enqueueMissionProject("owner-test", {
      missionId: m1.id,
      enqueueKey: "accept-m1",
      priority: 1,
    });
    service.enqueueMissionProject("owner-test", {
      missionId: m2.id,
      enqueueKey: "accept-m2",
      priority: 0,
    });

    resetMissionQueueThrottleForTests();
    resetSupervisorThrottleForTests();
    await missionQueueTick(service);

    let job1 = String(service.missions.get("owner-test", m1.id)!.markers.supervisor_last_job_id);
    expect(job1).toBeTruthy();

    service.store.updateJob(job1, {
      status: "failed",
      error: "synthetic fixture failure",
      finished_at: new Date().toISOString(),
    });
    missionSupervisorOnJobFinished(service, job1, "failed");

    resetMissionQueueThrottleForTests();
    resetSupervisorThrottleForTests();
    await missionQueueTick(service);
    const job1b = String(service.missions.get("owner-test", m1.id)!.markers.supervisor_last_job_id);
    expect(job1b).not.toBe(job1);

    service.store.updateJob(job1b, {
      status: "succeeded",
      exit_code: 0,
      work_path: fixture,
      finished_at: new Date().toISOString(),
    });
    missionSupervisorOnJobFinished(service, job1b, "succeeded");
    missionQueueOnJobFinished(service, m1.id);
    expect(service.missions.get("owner-test", m1.id)!.status).toBe("verifying");

    resetMissionQueueThrottleForTests();
    await missionQueueTick(service);
    const e1 = service.missionQueue.getByMissionId("owner-test", m1.id)!;
    expect(e1.queue_state).toBe("verifying");
    const runningIds = service.missionQueue
      .list("owner-test", { states: ["running"] })
      .map((e) => e.mission_id);
    expect(runningIds).not.toContain(m1.id);

    resetMissionQueueThrottleForTests();
    resetSupervisorThrottleForTests();
    await missionQueueTick(service);
    const job2 = String(service.missions.get("owner-test", m2.id)!.markers.supervisor_last_job_id);
    expect(job2).toBeTruthy();

    service.close();
    service = createService(root, fixture);
    service.config.supervisor = {
      enabled: true,
      poll_missions_sec: 0,
      queue_max_concurrent: 1,
    };
    services.push(service);

    service.store.updateJob(job2, {
      status: "succeeded",
      exit_code: 0,
      work_path: fixture,
      finished_at: new Date().toISOString(),
    });
    missionSupervisorOnJobFinished(service, job2, "succeeded");

    const review = await service.submitMissionReview("owner-test", m1.id, {
      summary: "queue acceptance project one",
      notify: false,
    });
    expect(review.blocked).toBe(false);
    expect(review.mission.status).toBe("ready_for_review");

    const e1Final = service.missionQueue.getByMissionId("owner-test", m1.id)!;
    expect(e1Final.queue_state).toBe("ready_for_review");
    expect(
      service.missionQueue
        .list("owner-test", { states: ["running"] })
        .some((e) => e.mission_id === m1.id),
    ).toBe(false);

    service.close();
  });
});
