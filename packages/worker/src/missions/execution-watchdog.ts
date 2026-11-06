/**
 * Durable supervision guardrails. This deliberately acts on persisted job
 * activity rather than an in-memory timer, so a worker restart cannot leave a
 * silent host process represented as healthy work forever.
 */
import type { AppConfig } from "@agent-control/shared";
import type { JobStore } from "../db.js";
import type { MissionRecord, MissionStore } from "./store.js";

export const DEFAULT_JOB_STALE_SEC = 300;
export const DEFAULT_CONNECTION_RETRY_LIMIT = 3;

export type ExecutionWatchdogService = {
  config: AppConfig;
  missions: MissionStore;
  store: JobStore;
  cancelTask(ownerId: string, jobId: string): unknown;
};

function active(job: { status: string }): boolean {
  return ["preparing", "running", "awaiting_followup"].includes(job.status);
}

/** Stop a silent/retrying executor and retain a concise reason in mission history. */
export function enforceMissionExecutionWatchdog(
  service: ExecutionWatchdogService,
  mission: MissionRecord,
  nowMs = Date.now(),
): boolean {
  if (mission.markers.project_active !== true) return false;
  const cfg = service.config.advisor ?? service.config.supervisor;
  const staleMs = Math.max(1, cfg.job_stale_sec ?? DEFAULT_JOB_STALE_SEC) * 1000;
  const retryLimit = Math.max(1, cfg.connection_retry_limit ?? DEFAULT_CONNECTION_RETRY_LIMIT);
  for (const jobId of mission.linked_job_ids) {
    const job = service.store.getJob(jobId);
    if (!job || !active(job)) continue;
    let retries = 0;
    try {
      const meta = JSON.parse(job.execution_meta ?? "{}");
      retries = typeof meta.watchdog_retry_streak === "number" ? meta.watchdog_retry_streak : 0;
    } catch { /* legacy records retain the stale-output bound */ }
    const ageMs = nowMs - Date.parse(job.updated_at);
    const reason = retries >= retryLimit
      ? `watchdog_connection_retry: executor retried its connection ${retries} times without useful progress`
      : Number.isFinite(ageMs) && ageMs > staleMs
        ? `watchdog_stale_output: no job output for ${Math.floor(ageMs / 1000)}s`
        : null;
    if (!reason) continue;
    // cancelTask terminates the managed process group when available. Marking
    // the mission blocked first prevents a late callback from reporting success.
    service.cancelTask(service.config.owner.id, job.id);
    service.missions.update(service.config.owner.id, mission.id, {
      status: "blocked",
      markers: {
        supervision_state: "blocked",
        block_reason: reason,
        watchdog_job_id: job.id,
        watchdog_detected_at: new Date(nowMs).toISOString(),
        next_owner_action: "Check executor availability, then resume with an available agent when ready.",
      },
    });
    return true;
  }
  return false;
}
