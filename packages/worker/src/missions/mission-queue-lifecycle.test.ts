import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildNeedsYouRail,
  deriveMissionDeliveryPresentation,
} from "@agent-control/shared";
import {
  createService,
  initGitFixture,
  makeTempRoot,
} from "../test-utils.js";
import { contractMarkerPayload, type MissionContract } from "./contract.js";
import {
  missionQueueTick,
  resetMissionQueueThrottleForTests,
} from "./queue-scheduler.js";
import { inventoryMissionQueueDrift } from "./queue-lifecycle.js";
import { resolveGitHead } from "./completion-gate.js";
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

const syntheticContract: MissionContract = {
  version: 1,
  steps: [
    { id: "s1", title: "one", kind: "synthetic", agent: "mock", project_id: "demo-sandbox" },
  ],
  supervision: { max_step_retries: 1, backoff_sec: 0 },
  evidence: { require_git_head: false, require_usability: false },
};

function attach(root: string, fixture: string): WorkerService {
  const service = createService(root, fixture);
  service.config.supervisor = {
    enabled: true,
    poll_missions_sec: 0,
    queue_max_concurrent: 1,
  };
  services.push(service);
  return service;
}


describe("mission queue lifecycle drift", () => {
  it("reproduces stale ready_for_review queue on done mission and reconciles on tick", async () => {
    const root = makeTempRoot();
    const fixture = join(root, "fixture");
    mkdirSync(fixture, { recursive: true });
    initGitFixture(fixture);
    const service = attach(root, fixture);

    const mission = service.missions.create({
      ownerId: "owner-test",
      title: "Already shipped",
      goal: "g",
      markers: {
        ...contractMarkerPayload(syntheticContract),
        review_state: "ready_for_review",
        project_active: false,
      },
    });
    service.missions.update("owner-test", mission.id, { status: "approved" });
    service.enqueueMissionProject("owner-test", {
      missionId: mission.id,
      enqueueKey: "done-drift",
    });
    service.missions.update("owner-test", mission.id, {
      status: "done",
      summary: "shipped",
    });
    const entry = service.missionQueue.getByMissionId("owner-test", mission.id)!;
    service.missionQueue.update("owner-test", entry.id, {
      queue_state: "ready_for_review",
    });

    const driftBefore = inventoryMissionQueueDrift(
      [service.missionQueue.get("owner-test", entry.id)!],
      (id) => service.missions.get("owner-test", id),
    );
    expect(driftBefore).toHaveLength(1);
    expect(driftBefore[0]?.classification).toBe("provably_stale_queue");

    const presentationBefore = deriveMissionDeliveryPresentation(
      service.missions.get("owner-test", mission.id)!,
      { queue_state: "ready_for_review" },
      false,
    );
    expect(presentationBefore.display_state).toBe("done");
    expect(presentationBefore.needs_owner).toBe(false);

    resetMissionQueueThrottleForTests();
    await missionQueueTick(service);
    const afterEntry = service.missionQueue.get("owner-test", entry.id)!;
    expect(afterEntry.queue_state).toBe("completed");
    service.close();
  });

  it("cancel_mission_queue_entry does not downgrade a done mission to cancelled", () => {
    const root = makeTempRoot();
    const fixture = join(root, "fixture");
    mkdirSync(fixture, { recursive: true });
    const service = attach(root, fixture);

    const mission = service.missions.create({
      ownerId: "owner-test",
      title: "Done project",
      goal: "g",
      markers: contractMarkerPayload(syntheticContract),
    });
    service.missions.update("owner-test", mission.id, { status: "approved" });
    service.enqueueMissionProject("owner-test", {
      missionId: mission.id,
      enqueueKey: "cleanup",
    });
    service.missions.update("owner-test", mission.id, { status: "done" });
    const entry = service.missionQueue.getByMissionId("owner-test", mission.id)!;
    service.missionQueue.update("owner-test", entry.id, {
      queue_state: "ready_for_review",
    });

    const result = service.cancelMissionQueueEntry(
      "owner-test",
      entry.id,
      "remove stale projection",
    );
    expect(result.mission.status).toBe("done");
    expect(result.queue_entry?.queue_state).toBe("completed");
    service.close();
  });

  it("complete_mission terminalizes queue row and clears review markers", async () => {
    const root = makeTempRoot();
    const fixture = join(root, "fixture");
    mkdirSync(fixture, { recursive: true });
    initGitFixture(fixture);
    const service = attach(root, fixture);
    const gitHead = resolveGitHead(fixture);

    const job = service.store.createJob({
      ownerId: "owner-test",
      projectId: "demo-sandbox",
      agent: "mock",
      prompt: "done",
      timeoutSec: 60,
    });
    service.store.updateJob(job.id, { status: "succeeded" });

    const mission = service.missions.create({
      ownerId: "owner-test",
      title: "Release me",
      goal: "g",
      markers: {
        ...contractMarkerPayload(syntheticContract),
        review_state: "ready_for_review",
        review_packet_version: 1,
        evidence_git_head: gitHead,
        supervisor_work_path: fixture,
        "step_done:s1": true,
      },
    });
    service.missions.update("owner-test", mission.id, {
      status: "approved",
      linkJobId: job.id,
    });
    service.enqueueMissionProject("owner-test", {
      missionId: mission.id,
      enqueueKey: "review",
    });
    service.missions.update("owner-test", mission.id, { status: "ready_for_review" });
    const entry = service.missionQueue.getByMissionId("owner-test", mission.id)!;
    service.missionQueue.update("owner-test", entry.id, {
      queue_state: "ready_for_review",
    });

    const result = await service.completeMission("owner-test", mission.id, {
      summary: "released",
      owner_release_authorized: true,
      notify: false,
    });
    expect(result.blocked).toBe(false);
    if (!result.blocked) {
      expect(result.mission.status).toBe("done");
      expect(result.mission.markers.review_state).toBeNull();
    }
    const queueAfter = service.missionQueue.get("owner-test", entry.id)!;
    expect(queueAfter.queue_state).toBe("completed");

    const board = service.getBoardSnapshot("owner-test");
    const row = board.missions.find((m) => m.id === mission.id)!;
    expect(row.needs_owner).toBe(false);
    const rail = buildNeedsYouRail(board.missions);
    expect(rail.some((r) => r.mission_id === mission.id)).toBe(false);
    service.close();
  });
});
