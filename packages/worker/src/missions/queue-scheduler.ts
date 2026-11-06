import { randomUUID } from "node:crypto";
import type { AppConfig } from "@agent-control/shared";
import type { MissionStore, MissionRecord } from "./store.js";
import type {
  MissionQueueEntry,
  MissionQueueStore,
  MissionQueueState,
} from "./queue-store.js";
import { MISSION_QUEUE_CAPACITY_STATES } from "./queue-store.js";
import { contractFromMission } from "./contract.js";
import { assertCanSubmitReview } from "./completion-gate.js";
import type { JobStore } from "../db.js";
import { terminalQueuePatchForMission } from "./queue-lifecycle.js";
import { missionSupervisorTick, type MissionSupervisorService } from "./supervisor.js";

export type MissionQueueService = MissionSupervisorService & {
  missionQueue: MissionQueueStore;
  getMission(ownerId: string, id: string): MissionRecord;
  submitMissionReview(
    ownerId: string,
    id: string,
    input: {
      summary: string;
      markers?: Record<string, string | number | boolean | null>;
      review_packet_version?: number;
      notify?: boolean;
    },
  ): Promise<
    | { blocked: true; gate: { code: string; message: string }; mission: MissionRecord }
    | { blocked: false; mission: MissionRecord }
  >;
};

let lastQueueRunMs = 0;

export function resetMissionQueueThrottleForTests(): void {
  lastQueueRunMs = 0;
}

function queueConfig(config: AppConfig) {
  const sup = config.advisor ?? config.supervisor;
  return {
    enabled: sup.enabled,
    pollSec: sup.poll_missions_sec ?? 2,
    maxConcurrent: sup.queue_max_concurrent ?? 1,
    leaseSec: sup.queue_claim_lease_sec ?? 300,
  };
}

function missionJobsMap(
  mission: MissionRecord,
  store: JobStore,
): Map<string, import("@agent-control/shared").JobRecord> {
  const map = new Map<string, import("@agent-control/shared").JobRecord>();
  for (const jobId of mission.linked_job_ids) {
    const job = store.getJob(jobId);
    if (job) map.set(jobId, job);
  }
  return map;
}

function dependencySatisfied(
  ownerId: string,
  depMissionId: string,
  queue: MissionQueueStore,
  missions: MissionStore,
): boolean {
  const depEntry = queue.getByMissionId(ownerId, depMissionId);
  if (depEntry) {
    return (
      depEntry.queue_state === "completed" || depEntry.queue_state === "ready_for_review"
    );
  }
  const depMission = missions.get(ownerId, depMissionId);
  if (!depMission) return false;
  return depMission.status === "done" || depMission.status === "ready_for_review";
}

function dependenciesMet(
  entry: MissionQueueEntry,
  ownerId: string,
  queue: MissionQueueStore,
  missions: MissionStore,
): { ok: true } | { ok: false; detail: string } {
  if (!entry.depends_on.length) return { ok: true };
  for (const depMissionId of entry.depends_on) {
    if (!dependencySatisfied(ownerId, depMissionId, queue, missions)) {
      const dep = queue.getByMissionId(ownerId, depMissionId);
      const label = dep?.queue_state ?? missions.get(ownerId, depMissionId)?.status ?? "missing";
      return { ok: false, detail: `waiting on mission ${depMissionId} (${label})` };
    }
  }
  return { ok: true };
}

function syncQueueStateFromMission(
  service: MissionQueueService,
  entry: MissionQueueEntry,
  mission: MissionRecord,
): MissionQueueEntry {
  const ownerId = service.config.owner.id;
  const terminalPatch = terminalQueuePatchForMission(mission, entry);
  if (terminalPatch) {
    return service.missionQueue.update(ownerId, entry.id, terminalPatch);
  }
  if (entry.queue_state === "cancelled" || entry.queue_state === "completed") {
    return entry;
  }
  if (mission.status === "ready_for_review") {
    if (entry.queue_state !== "ready_for_review") {
      return service.missionQueue.update(ownerId, entry.id, {
        queue_state: "ready_for_review",
        claim_token: null,
        claimed_at: null,
        lease_until: null,
      });
    }
    return entry;
  }
  if (mission.status === "verifying") {
    if (entry.queue_state === "running") {
      return service.missionQueue.releaseClaim(ownerId, entry.id, {
        queue_state: "verifying",
      });
    }
    if (entry.queue_state !== "verifying" && entry.queue_state !== "ready_for_review") {
      return service.missionQueue.update(ownerId, entry.id, {
        queue_state: "verifying",
      });
    }
    return entry;
  }
  if (mission.status === "blocked" && entry.queue_state !== "blocked") {
    const reason =
      typeof mission.markers.block_reason === "string"
        ? mission.markers.block_reason
        : "mission blocked";
    return service.missionQueue.update(ownerId, entry.id, {
      queue_state: "blocked",
      blocker_code: "mission_blocked",
      blocker_detail: reason,
    });
  }
  return entry;
}

async function maybeAutoSubmitReview(
  service: MissionQueueService,
  entry: MissionQueueEntry,
  mission: MissionRecord,
): Promise<void> {
  if (entry.queue_state !== "verifying") return;
  if (mission.status === "ready_for_review") return;
  const autoReview =
    mission.markers.queue_auto_review === true ||
    service.config.supervisor.queue_auto_review === true;
  if (!autoReview) return;
  const gate = assertCanSubmitReview(mission, missionJobsMap(mission, service.store));
  if (!gate.ok) return;
  const summary =
    mission.summary ??
    `Queue auto-staged review for ${mission.title}`.slice(0, 500);
  const result = await service.submitMissionReview(service.config.owner.id, mission.id, {
    summary,
    notify: false,
    review_packet_version:
      typeof mission.markers.review_packet_version === "number"
        ? mission.markers.review_packet_version
        : 1,
  });
  if (!result.blocked) {
    service.missionQueue.update(service.config.owner.id, entry.id, {
      queue_state: "ready_for_review",
    });
    service.missions.update(service.config.owner.id, mission.id, {
      markers: {
        project_active: false,
        queue_capacity_released: true,
      },
    });
  }
}

function promoteScheduleStates(
  service: MissionQueueService,
  now: string,
): void {
  const ownerId = service.config.owner.id;
  const pending = service.missionQueue.list(ownerId, {
    states: ["queued", "scheduled"],
    limit: 100,
  });
  for (const entry of pending) {
    const needsSchedule =
      (entry.earliest_start_at && entry.earliest_start_at > now) ||
      (entry.schedule_until_at && entry.schedule_until_at < now);
    if (needsSchedule) {
      if (entry.queue_state !== "scheduled") {
        service.missionQueue.update(ownerId, entry.id, { queue_state: "scheduled" });
      }
      continue;
    }
    if (entry.queue_state === "scheduled") {
      service.missionQueue.update(ownerId, entry.id, { queue_state: "queued" });
    }
  }
}

function blockUnmetDependencies(service: MissionQueueService): void {
  const ownerId = service.config.owner.id;
  const candidates = service.missionQueue.list(ownerId, {
    states: ["queued", "scheduled", "blocked"],
    limit: 100,
  });
  for (const entry of candidates) {
    if (
      entry.queue_state === "blocked" &&
      entry.blocker_code &&
      entry.blocker_code !== "dependency"
    ) {
      continue;
    }
    const dep = dependenciesMet(
      entry,
      ownerId,
      service.missionQueue,
      service.missions,
    );
    if (!dep.ok) {
      service.missionQueue.update(ownerId, entry.id, {
        queue_state: "blocked",
        blocker_code: "dependency",
        blocker_detail: dep.detail,
      });
    } else if (entry.queue_state === "blocked" && entry.blocker_code === "dependency") {
      service.missionQueue.update(ownerId, entry.id, {
        queue_state:
          entry.earliest_start_at && entry.earliest_start_at > nowIso()
            ? "scheduled"
            : "queued",
        blocker_code: null,
        blocker_detail: null,
      });
    }
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

export async function missionQueueTick(service: MissionQueueService): Promise<void> {
  const cfg = queueConfig(service.config);
  if (!cfg.enabled) return;
  const pollMs = cfg.pollSec * 1000;
  const nowMs = Date.now();
  if (nowMs - lastQueueRunMs < pollMs) return;
  lastQueueRunMs = nowMs;

  const ownerId = service.config.owner.id;
  const now = nowIso();
  service.missionQueue.recoverExpiredLeases(ownerId, now);
  promoteScheduleStates(service, now);
  blockUnmetDependencies(service);

  const active = service.missionQueue.list(ownerId, { limit: 100 });
  for (const entry of active) {
    const mission = service.missions.get(ownerId, entry.mission_id);
    if (!mission) continue;
    const synced = syncQueueStateFromMission(service, entry, mission);
    await maybeAutoSubmitReview(service, synced, mission);
  }

  const capacityUsed = service.missionQueue.countInStates(
    ownerId,
    [...MISSION_QUEUE_CAPACITY_STATES],
  );
  const slots = Math.max(0, cfg.maxConcurrent - capacityUsed);
  if (slots <= 0) {
    await missionSupervisorTick(service);
    return;
  }

  const candidates = service.missionQueue.listRunnableCandidates(ownerId, now, 50);
  let claimed = 0;
  for (const entry of candidates) {
    if (claimed >= slots) break;
    const dep = dependenciesMet(
      entry,
      ownerId,
      service.missionQueue,
      service.missions,
    );
    if (!dep.ok) continue;

    const mission = service.missions.get(ownerId, entry.mission_id);
    if (!mission) continue;
    if (!contractFromMission(mission)) continue;
    if (mission.status !== "approved" && mission.status !== "implementing") {
      if (mission.status === "plan_ready" || mission.status === "intake") continue;
    }

    const leaseUntil = new Date(nowMs + cfg.leaseSec * 1000).toISOString();
    const token = randomUUID();
    const won = service.missionQueue.tryClaim(ownerId, entry.id, token, leaseUntil);
    if (!won) continue;
    claimed += 1;

    service.missions.update(ownerId, mission.id, {
      status: mission.status === "approved" ? "implementing" : mission.status,
      markers: {
        project_active: true,
        queue_entry_id: entry.id,
        queue_state: "running",
        supervision_state: "idle",
      },
    });
  }

  await missionSupervisorTick(service);

  const post = service.missionQueue.list(ownerId, { states: ["running"], limit: 20 });
  for (const entry of post) {
    const mission = service.missions.get(ownerId, entry.mission_id);
    if (!mission) continue;
    syncQueueStateFromMission(service, entry, mission);
  }
}

export function missionQueueOnJobFinished(
  service: MissionQueueService,
  missionId: string,
): void {
  const cfg = queueConfig(service.config);
  if (!cfg.enabled) return;
  const ownerId = service.config.owner.id;
  const entry = service.missionQueue.getByMissionId(ownerId, missionId);
  if (!entry) return;
  const mission = service.missions.get(ownerId, missionId);
  if (!mission) return;
  syncQueueStateFromMission(service, entry, mission);
}
