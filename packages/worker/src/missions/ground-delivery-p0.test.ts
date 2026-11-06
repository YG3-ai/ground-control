import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { contractMarkerPayload, missionAttemptKey, type MissionContract } from "./contract.js";
import { recoverMissionSupervisionOnWorkerStart } from "./recovery.js";
import { missionHasActiveSupervisorJob } from "./supervisor.js";
import { createService, initGitFixture, makeTempRoot } from "../test-utils.js";
import type { WorkerService } from "../service.js";

const services: WorkerService[] = [];
afterEach(() => {
  for (const s of services.splice(0)) s.close();
});

describe("recoverMissionSupervisionOnWorkerStart", () => {
  it("reconciles a succeeded step after restart and clears stale running supervision", () => {
    const root = makeTempRoot();
    const fixture = join(root, "fixture");
    mkdirSync(fixture, { recursive: true });
    initGitFixture(fixture);
    const service = createService(root, fixture);
    service.config.supervisor = { enabled: true, poll_missions_sec: 0 };
    services.push(service);

    const contract: MissionContract = {
      version: 1,
      steps: [
        { id: "s1", title: "One", kind: "synthetic", agent: "mock", project_id: "demo-sandbox" },
      ],
      supervision: { max_step_retries: 1, backoff_sec: 0 },
      evidence: { require_git_head: false, require_usability: false },
    };

    const mission = service.missions.create({
      ownerId: "owner-test",
      title: "restart reconcile",
      goal: "worker start recovery",
      markers: {
        project_active: true,
        ...contractMarkerPayload(contract),
        current_step_id: "s1",
        "step_attempt:s1": 1,
        supervision_state: "running",
      },
    });
    service.missions.update("owner-test", mission.id, { status: "implementing" });

    const job = service.store.createJob({
      ownerId: "owner-test",
      projectId: "demo-sandbox",
      agent: "mock",
      prompt: "step",
      timeoutSec: 60,
      idempotencyKey: missionAttemptKey(mission.id, "s1", 1),
    });
    service.missions.update("owner-test", mission.id, {
      linkJobId: job.id,
      markers: { supervisor_last_job_id: job.id },
    });
    service.store.updateJob(job.id, {
      status: "succeeded",
      exit_code: 0,
      finished_at: new Date().toISOString(),
    });

    expect(missionHasActiveSupervisorJob(
      service.missions.get("owner-test", mission.id)!,
      service.store,
    )).toBe(false);

    const fixes = recoverMissionSupervisionOnWorkerStart(service);
    expect(fixes).toBeGreaterThanOrEqual(1);
    const after = service.missions.get("owner-test", mission.id)!;
    expect(after.markers["step_done:s1"]).toBe(true);
    expect(after.markers.supervision_state).toBe("idle");
  });
});

describe("cancelMissionProject", () => {
  it("cancels active jobs, queue lease, and mission supervision markers", () => {
    const root = makeTempRoot();
    const fixture = join(root, "fixture");
    mkdirSync(fixture, { recursive: true });
    initGitFixture(fixture);
    const service = createService(root, fixture);
    service.config.supervisor = { enabled: true, poll_missions_sec: 1, queue_max_concurrent: 1 };
    services.push(service);

    const contract: MissionContract = {
      version: 1,
      steps: [
        { id: "only", title: "Only", kind: "synthetic", agent: "mock", project_id: "demo-sandbox" },
      ],
      supervision: { max_step_retries: 0, backoff_sec: 0 },
      evidence: { require_git_head: false, require_usability: false },
    };

    const mission = service.missions.create({
      ownerId: "owner-test",
      title: "cancel me",
      goal: "cascade",
      markers: {
        project_active: true,
        ...contractMarkerPayload(contract),
        supervision_state: "running",
        current_step_id: "only",
      },
    });
    service.missions.update("owner-test", mission.id, { status: "implementing" });
    const job = service.store.createJob({
      ownerId: "owner-test",
      projectId: "demo-sandbox",
      agent: "mock",
      prompt: "running",
      timeoutSec: 60,
    });
    service.store.updateJob(job.id, { status: "running" });
    service.missions.update("owner-test", mission.id, { linkJobId: job.id });

    const entry = service.enqueueMissionProject("owner-test", {
      missionId: mission.id,
      enqueueKey: "cancel-test",
    });
    service.missionQueue.tryClaim(
      "owner-test",
      entry.id,
      "claim-token",
      new Date(Date.now() + 60_000).toISOString(),
    );

    const result = service.cancelMissionProject("owner-test", mission.id, "owner abort");
    expect(result.mission.status).toBe("cancelled");
    expect(result.mission.markers.project_active).toBe(false);
    expect(result.queue_entry?.queue_state).toBe("cancelled");
    expect(service.store.getJob(job.id)?.status).toBe("cancelling");
  });
});

describe("mission board presentation", () => {
  it("includes needs_you for blocked and ready_for_review missions", () => {
    const root = makeTempRoot();
    const fixture = join(root, "fixture");
    mkdirSync(fixture, { recursive: true });
    initGitFixture(fixture);
    const service = createService(root, fixture);
    services.push(service);

    service.missions.create({
      ownerId: "owner-test",
      title: "Needs review",
      goal: "g",
      markers: { review_state: "ready_for_review" },
    });
    const blocked = service.missions.create({
      ownerId: "owner-test",
      title: "Needs unblock",
      goal: "g",
      markers: { block_reason: "gate failed" },
    });
    service.missions.update("owner-test", blocked.id, { status: "blocked" });
    const review = service.missions.list("owner-test").find((m) => m.title === "Needs review")!;
    service.missions.update("owner-test", review.id, { status: "ready_for_review" });

    const board = service.getBoardSnapshot("owner-test");
    expect(board.needs_you).toHaveLength(2);
    expect(board.missions.every((m) => m.display_state != null)).toBe(true);
  });
});
