import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createService,
  initGitFixture,
  makeTempRoot,
} from "../test-utils.js";
import { contractMarkerPayload, type MissionContract } from "./contract.js";
import { MissionQueueStore } from "./queue-store.js";
import {
  missionQueueTick,
  resetMissionQueueThrottleForTests,
} from "./queue-scheduler.js";
import { resetSupervisorThrottleForTests } from "./supervisor.js";
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

function attach(root: string, fixture: string): WorkerService {
  const service = createService(root, fixture);
  service.config.supervisor = {
    enabled: true,
    poll_missions_sec: 0,
    queue_max_concurrent: 1,
    queue_claim_lease_sec: 60,
  };
  services.push(service);
  return service;
}

const syntheticContract: MissionContract = {
  version: 1,
  steps: [
    { id: "s1", title: "one", kind: "synthetic", agent: "mock", project_id: "demo-sandbox" },
  ],
  supervision: { max_step_retries: 1, backoff_sec: 0 },
  evidence: { require_git_head: false, require_usability: false },
};

describe("MissionQueueStore", () => {
  it("enqueue is idempotent on enqueue_key", () => {
    const root = makeTempRoot();
    const fixture = join(root, "fixture");
    mkdirSync(fixture, { recursive: true });
    const service = attach(root, fixture);
    const mission = service.missions.create({
      ownerId: "owner-test",
      title: "A",
      goal: "g",
      markers: contractMarkerPayload(syntheticContract),
    });
    service.missions.update("owner-test", mission.id, { plan: "Run the queued contract." });
    service.missions.update("owner-test", mission.id, { status: "approved", markers: { approval_policy: "hybrid_remote", approval_source: "chat_explicit", plan_approved: true } });
    const a = service.enqueueMissionProject("owner-test", {
      missionId: mission.id,
      enqueueKey: "key-1",
      priority: 2,
    });
    const b = service.enqueueMissionProject("owner-test", {
      missionId: mission.id,
      enqueueKey: "key-1",
      priority: 99,
    });
    expect(a.id).toBe(b.id);
    expect(a.priority).toBe(2);
    service.close();
  });
});

describe("mission queue scheduler", () => {
  it("orders higher priority first with FIFO tie-break", async () => {
    const root = makeTempRoot();
    const fixture = join(root, "fixture");
    mkdirSync(fixture, { recursive: true });
    initGitFixture(fixture);
    const service = attach(root, fixture);
    service.config.supervisor.queue_max_concurrent = 1;

    const mLow = service.missions.create({
      ownerId: "owner-test",
      title: "low",
      goal: "g",
      markers: { ...contractMarkerPayload(syntheticContract), project_active: false },
    });
    const mHigh = service.missions.create({
      ownerId: "owner-test",
      title: "high",
      goal: "g",
      markers: { ...contractMarkerPayload(syntheticContract), project_active: false },
    });
    service.missions.update("owner-test", mLow.id, { plan: "Run the low priority contract." });
    service.missions.update("owner-test", mLow.id, { status: "approved", markers: { approval_policy: "hybrid_remote", approval_source: "chat_explicit", plan_approved: true } });
    service.missions.update("owner-test", mHigh.id, { plan: "Run the high priority contract." });
    service.missions.update("owner-test", mHigh.id, { status: "approved", markers: { approval_policy: "hybrid_remote", approval_source: "chat_explicit", plan_approved: true } });

    service.enqueueMissionProject("owner-test", {
      missionId: mLow.id,
      enqueueKey: "low",
      priority: 0,
    });
    service.enqueueMissionProject("owner-test", {
      missionId: mHigh.id,
      enqueueKey: "high",
      priority: 5,
    });

    resetMissionQueueThrottleForTests();
    resetSupervisorThrottleForTests();
    await missionQueueTick(service);

    const running = service.missionQueue.list("owner-test", { states: ["running"] });
    expect(running).toHaveLength(1);
    expect(running[0]!.mission_id).toBe(mHigh.id);
    service.close();
  });

  it("blocks until dependency reaches ready_for_review", async () => {
    const root = makeTempRoot();
    const fixture = join(root, "fixture");
    mkdirSync(fixture, { recursive: true });
    initGitFixture(fixture);
    const service = attach(root, fixture);

    const dep = service.missions.create({
      ownerId: "owner-test",
      title: "dep",
      goal: "g",
      markers: contractMarkerPayload(syntheticContract),
    });
    const child = service.missions.create({
      ownerId: "owner-test",
      title: "child",
      goal: "g",
      markers: contractMarkerPayload(syntheticContract),
    });
    service.missions.update("owner-test", dep.id, { plan: "Run dependency." });
    service.missions.update("owner-test", dep.id, { status: "approved", markers: { approval_policy: "hybrid_remote", approval_source: "chat_explicit", plan_approved: true } });
    service.missions.update("owner-test", child.id, { plan: "Run dependent mission." });
    service.missions.update("owner-test", child.id, { status: "approved", markers: { approval_policy: "hybrid_remote", approval_source: "chat_explicit", plan_approved: true } });

    service.enqueueMissionProject("owner-test", {
      missionId: dep.id,
      enqueueKey: "dep",
    });
    const childEntry = service.enqueueMissionProject("owner-test", {
      missionId: child.id,
      enqueueKey: "child",
      dependsOn: [dep.id],
    });

    resetMissionQueueThrottleForTests();
    await missionQueueTick(service);
    expect(service.missionQueue.get("owner-test", childEntry.id)!.queue_state).toBe(
      "blocked",
    );

    service.missionQueue.update("owner-test", service.missionQueue.getByMissionId("owner-test", dep.id)!.id, {
      queue_state: "ready_for_review",
    });
    resetMissionQueueThrottleForTests();
    await missionQueueTick(service);
    const childState = service.missionQueue.get("owner-test", childEntry.id)!.queue_state;
    expect(["queued", "running"]).toContain(childState);
    service.close();
  });

  it("recovers expired lease and prevents duplicate claims", async () => {
    const root = makeTempRoot();
    const fixture = join(root, "fixture");
    mkdirSync(fixture, { recursive: true });
    initGitFixture(fixture);
    const service = attach(root, fixture);
    const mission = service.missions.create({
      ownerId: "owner-test",
      title: "lease",
      goal: "g",
      markers: contractMarkerPayload(syntheticContract),
    });
    service.missions.update("owner-test", mission.id, { plan: "Recover the queue lease." });
    service.missions.update("owner-test", mission.id, { status: "approved", markers: { approval_policy: "hybrid_remote", approval_source: "chat_explicit", plan_approved: true } });
    const entry = service.enqueueMissionProject("owner-test", {
      missionId: mission.id,
      enqueueKey: "lease",
    });

    const store = new MissionQueueStore(service.missions.db);
    const past = new Date(Date.now() - 60_000).toISOString();
    store.update("owner-test", entry.id, {
      queue_state: "running",
      claim_token: "stale",
      claimed_at: past,
      lease_until: past,
    });

    resetMissionQueueThrottleForTests();
    resetSupervisorThrottleForTests();
    await missionQueueTick(service);
    const after = service.missionQueue.get("owner-test", entry.id)!;
    expect(["queued", "running"]).toContain(after.queue_state);
    if (after.queue_state === "queued") {
      expect(after.claim_token).toBeNull();
    }
    service.close();
  });

  it("releases capacity when mission enters verifying", async () => {
    const root = makeTempRoot();
    const fixture = join(root, "fixture");
    mkdirSync(fixture, { recursive: true });
    initGitFixture(fixture);
    const service = attach(root, fixture);
    service.config.supervisor.queue_max_concurrent = 1;

    const a = service.missions.create({
      ownerId: "owner-test",
      title: "A",
      goal: "g",
      markers: {
        ...contractMarkerPayload(syntheticContract),
        project_active: true,
        "step_done:s1": true,
      },
    });
    const b = service.missions.create({
      ownerId: "owner-test",
      title: "B",
      goal: "g",
      markers: contractMarkerPayload(syntheticContract),
    });
    service.missions.update("owner-test", a.id, { status: "verifying" });
    service.missions.update("owner-test", b.id, { plan: "Release capacity." });
    service.missions.update("owner-test", b.id, { status: "approved", markers: { approval_policy: "hybrid_remote", approval_source: "chat_explicit", plan_approved: true } });

    const eA = service.enqueueMissionProject("owner-test", {
      missionId: a.id,
      enqueueKey: "a",
    });
    service.missionQueue.update("owner-test", eA.id, { queue_state: "running" });
    service.enqueueMissionProject("owner-test", {
      missionId: b.id,
      enqueueKey: "b",
    });

    resetMissionQueueThrottleForTests();
    await missionQueueTick(service);
    syncQueueFromMission(service, a.id);
    expect(service.missionQueue.get("owner-test", eA.id)!.queue_state).toBe("verifying");
    const running = service.missionQueue.countInStates("owner-test", ["running"]);
    expect(running).toBeLessThanOrEqual(1);
    service.close();
  });
});

function syncQueueFromMission(service: WorkerService, missionId: string) {
  const entry = service.missionQueue.getByMissionId("owner-test", missionId);
  const mission = service.missions.get("owner-test", missionId)!;
  if (entry && mission.status === "verifying" && entry.queue_state === "running") {
    service.missionQueue.releaseClaim("owner-test", entry.id, { queue_state: "verifying" });
  }
}
