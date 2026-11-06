import type { MissionQueueStore } from "./queue-store.js";
import type { MissionRecord } from "./store.js";
import {
  contractFromMission,
  missionAttemptKey,
  type MissionContract,
} from "./contract.js";
import {
  missionHasActiveSupervisorJob,
  missionSupervisorOnJobFinished,
  type MissionSupervisorService,
} from "./supervisor.js";

const SUPERVISABLE = new Set([
  "approved",
  "implementing",
  "verifying",
]);

function stepAttempt(mission: MissionRecord, stepId: string): number {
  const raw = mission.markers[`step_attempt:${stepId}`];
  return typeof raw === "number" ? raw : 0;
}

function reconcileTerminalLastJob(
  service: MissionSupervisorService,
  mission: MissionRecord,
  contract: MissionContract,
): boolean {
  const lastId = mission.markers.supervisor_last_job_id;
  const lastJob = typeof lastId === "string" ? service.store.getJob(lastId) : null;
  if (!lastJob) return false;

  const stepId =
    typeof mission.markers.current_step_id === "string"
      ? mission.markers.current_step_id
      : null;
  if (!stepId) return false;

  const step = contract.steps.find((s) => s.id === stepId);
  if (!step) return false;
  if (
    lastJob.idempotency_key !==
    missionAttemptKey(mission.id, stepId, stepAttempt(mission, stepId))
  ) {
    return false;
  }

  if (lastJob.status === "succeeded") {
    missionSupervisorOnJobFinished(service, lastJob.id, "succeeded");
    return true;
  }
  return false;
}

function clearStaleRunningSupervision(
  service: MissionSupervisorService,
  mission: MissionRecord,
): boolean {
  if (mission.markers.supervision_state !== "running") return false;
  if (missionHasActiveSupervisorJob(mission, service.store)) return false;
  service.missions.update(service.config.owner.id, mission.id, {
    markers: {
      supervision_state: "idle",
    },
  });
  return true;
}

/**
 * Reconcile supervised missions after worker restart (jobs already recovered).
 */
export function recoverMissionSupervisionOnWorkerStart(
  service: MissionSupervisorService & { missionQueue: MissionQueueStore },
): number {
  if (!service.config.supervisor.enabled) return 0;
  const ownerId = service.config.owner.id;
  const now = new Date().toISOString();
  service.missionQueue.recoverExpiredLeases(ownerId, now);

  let fixes = 0;
  const missions = service.missions.list(ownerId, { limit: 100 });
  for (const mission of missions) {
    if (mission.status === "cancelled" || mission.status === "done") continue;
    if (mission.markers.project_active !== true) continue;

    const contract = contractFromMission(mission);
    if (
      contract &&
      SUPERVISABLE.has(mission.status) &&
      !["blocked", "paused"].includes(String(mission.markers.supervision_state))
    ) {
      if (reconcileTerminalLastJob(service, mission, contract)) {
        fixes += 1;
        continue;
      }
    }

    if (clearStaleRunningSupervision(service, mission)) {
      fixes += 1;
    }
  }
  return fixes;
}
