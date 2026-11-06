import type { AppConfig } from "@agent-control/shared";
import type { JobStore } from "../db.js";
import type { MissionStore, MissionRecord } from "./store.js";
import {
  contractFromMission,
  missionAttemptKey,
  nextPendingStep,
  allStepsDone,
  stepMarkerDone,
  type MissionStep,
} from "./contract.js";
import { resolveGitHead } from "./completion-gate.js";
import {
  runAcceptanceCommand,
  acceptanceEvidenceMarker,
  acceptanceExitCodeMarker,
} from "./acceptance-runner.js";
import { supervisionHeartbeatMarkers } from "./mission-progress-events.js";
import {
  normalizeHostAgentForNewWork,
  isAgentEnabled,
  type StartTaskInput,
  type TaskView,
} from "@agent-control/shared";
import { enforceMissionExecutionWatchdog } from "./execution-watchdog.js";

export type MissionSupervisorService = {
  config: AppConfig;
  missions: MissionStore;
  store: JobStore;
  startTask(input: StartTaskInput & { ownerId: string }): TaskView;
  cancelTask(ownerId: string, jobId: string): unknown;
  resolveMissionWorkPath?(mission: MissionRecord): string | null;
};

const SUPERVISABLE = new Set([
  "approved",
  "implementing",
  "verifying",
]);

let lastSupervisorRunMs = 0;

export function resetSupervisorThrottleForTests(): void {
  lastSupervisorRunMs = 0;
}

function supervisorConfig(config: AppConfig) {
  // An explicit advisor setting wins, including enabled:false. The legacy
  // supervisor block remains a compatible alias for existing installations.
  return config.advisor ?? config.supervisor;
}

export function missionHasActiveSupervisorJob(
  mission: MissionRecord,
  store: JobStore,
): boolean {
  for (const jobId of mission.linked_job_ids) {
    const job = store.getJob(jobId);
    if (
      job &&
      (job.status === "queued" ||
        job.status === "preparing" ||
        job.status === "running" ||
        job.status === "cancelling" ||
        job.status === "awaiting_followup")
    ) {
      return true;
    }
  }
  return false;
}

function stepAttempt(mission: MissionRecord, stepId: string): number {
  const raw = mission.markers[`step_attempt:${stepId}`];
  return typeof raw === "number" ? raw : 0;
}

function completeSupervisorStep(
  service: MissionSupervisorService,
  mission: MissionRecord,
  contract: import("./contract.js").MissionContract,
  stepId: string,
  extraMarkers?: Record<string, string | number | boolean | null>,
): void {
  const ownerId = service.config.owner.id;
  const next = nextPendingStep(
    {
      ...mission,
      markers: {
        ...mission.markers,
        [stepMarkerDone(stepId)]: true,
        ...extraMarkers,
      },
    },
    contract,
  );
  service.missions.update(ownerId, mission.id, {
    markers: {
      [stepMarkerDone(stepId)]: true,
      supervision_state: "idle",
      current_step_id: next?.id ?? null,
      ...extraMarkers,
      review_packet_version:
        !next && mission.markers.review_packet_version == null
          ? 1
          : typeof mission.markers.review_packet_version === "number"
            ? mission.markers.review_packet_version
            : null,
    },
    status: next ? "implementing" : "verifying",
  });
}

async function runVerifyAcceptanceStep(
  service: MissionSupervisorService,
  mission: MissionRecord,
  contract: import("./contract.js").MissionContract,
  step: MissionStep,
): Promise<boolean> {
  const ownerId = service.config.owner.id;
  const testId =
    step.acceptance_test_id ??
    (step.id.startsWith("verify_") ? step.id.slice("verify_".length) : step.id);
  if (!step.acceptance_command) {
    completeSupervisorStep(service, mission, contract, step.id);
    return true;
  }
  const workPath =
    (typeof mission.markers.supervisor_work_path === "string"
      ? mission.markers.supervisor_work_path
      : null) ?? service.resolveMissionWorkPath?.(mission) ?? null;
  if (!workPath) {
    blockSupervision(service, mission, "acceptance command requires a resolved workspace path");
    return true;
  }
  service.missions.update(ownerId, mission.id, {
    markers: {
      supervision_state: "running",
      current_step_id: step.id,
      ...supervisionHeartbeatMarkers(),
    },
  });
  const result = await runAcceptanceCommand({
    testId,
    command: step.acceptance_command,
    cwd: workPath,
    timeoutSec: 600,
  });
  const outcome = result.ok ? "pass" : "fail";
  const evidenceMarkers: Record<string, string | number | boolean | null> = {
    [acceptanceEvidenceMarker(testId)]: outcome,
    [acceptanceExitCodeMarker(testId)]: result.exitCode,
    acceptance_evidence_hash: result.evidenceHash,
  };
  if (result.ok) {
    completeSupervisorStep(service, mission, contract, step.id, evidenceMarkers);
    return true;
  }
  const attempt = stepAttempt(mission, step.id) + 1;
  const maxRetries = contract.supervision.max_step_retries;
  if (attempt > maxRetries + 1) {
    service.missions.update(ownerId, mission.id, {
      status: "blocked",
      markers: {
        ...evidenceMarkers,
        supervision_state: "blocked",
        block_reason: `acceptance ${testId} failed after ${maxRetries} retries`,
        current_step_id: step.id,
      },
    });
    return true;
  }
  service.missions.update(ownerId, mission.id, {
    markers: {
      ...evidenceMarkers,
      supervision_state: "recovering",
      [`step_attempt:${step.id}`]: attempt,
      [`step_last_fail_at:${step.id}`]: new Date().toISOString(),
      block_reason: null,
    },
  });
  return true;
}

function maybeEmitSupervisionHeartbeat(
  service: MissionSupervisorService,
  mission: MissionRecord,
): void {
  if (mission.markers.supervision_state !== "running") return;
  const bucket = Math.floor(Date.now() / 60_000);
  const prev =
    typeof mission.markers.supervision_heartbeat_bucket === "string"
      ? Number(mission.markers.supervision_heartbeat_bucket)
      : NaN;
  if (prev === bucket) return;
  service.missions.update(service.config.owner.id, mission.id, {
    markers: supervisionHeartbeatMarkers(),
  });
}

export function buildStepPrompt(mission: MissionRecord, step: MissionStep, handoff?: string | null): string {
  const contract = contractFromMission(mission);
  return [
    `[mission-supervisor] ${mission.id} step ${step.id}: ${step.title}`,
    `Mission: ${mission.title}\nOutcome: ${mission.goal}`,
    mission.plan ? `Persisted plan and constraints:\n${mission.plan}` : "",
    `Contract version: ${contract?.version ?? "missing"}`,
    `Completed steps: ${contract?.steps.filter(s => mission.markers[stepMarkerDone(s.id)] === true).map(s => s.title).join("; ") ?? ""}`,
    (handoff ?? mission.summary) ? `Latest handoff:\n${handoff ?? mission.summary}` : "",
    "Follow the persisted scope and constraints. Report evidence and unresolved issues. Do not merge, deploy, send messages, or expand scope unless the mission explicitly authorizes that action.",
    step.prompt ? `Current step instructions:\n${step.prompt}` : "",
  ].filter(Boolean).join("\n\n");
}

function blockSupervision(service: MissionSupervisorService, mission: MissionRecord, reason: string): void {
  service.missions.update(service.config.owner.id, mission.id, {
    status: "blocked", markers: { supervision_state: "blocked", block_reason: reason },
  });
}

function resolveStepAgent(
  mission: MissionRecord,
  step: MissionStep,
  config: import("@agent-control/shared").AppConfig,
): "mock" | "cursor" | "kimi" | "codex" | null {
  if (!step.agent || step.agent === "mock") return "mock";
  const preferred = normalizeHostAgentForNewWork(step.agent, config);
  const candidates = [preferred, "codex", "cursor"] as const;
  for (const agent of candidates) {
    // Never loop back to an executor a prior dispatch marked unavailable.
    if (mission.markers[`executor_unavailable:${agent}`] === true) continue;
    if (isAgentEnabled(config, agent)) return agent;
  }
  return null;
}

export async function missionSupervisorTick(service: MissionSupervisorService): Promise<void> {
  const cfg = supervisorConfig(service.config);
  if (!cfg.enabled) return;
  const pollMs = (cfg.poll_missions_sec ?? 2) * 1000;
  const now = Date.now();
  if (now - lastSupervisorRunMs < pollMs) return;
  lastSupervisorRunMs = now;

  const ownerId = service.config.owner.id;
  const missions = service.missions.list(ownerId, { limit: 50 });
  for (const mission of missions) {
    if (!SUPERVISABLE.has(mission.status)) continue;
    if (mission.markers.project_active !== true) continue;
    if (["blocked", "paused"].includes(String(mission.markers.supervision_state))) continue;

    const nextRun = mission.markers.supervision_next_run_at;
    if (typeof nextRun === "string" && Date.parse(nextRun) > now) continue;

    const contract = contractFromMission(mission);
    if (!contract) continue;
    if (mission.markers.approved_contract_version != null &&
        mission.markers.approved_contract_version !== contract.version) {
      blockSupervision(service, mission, "contract changed after approval; reconcile the approved scope before resuming");
      continue;
    }

    if (enforceMissionExecutionWatchdog(service, mission, now)) continue;
    if (missionHasActiveSupervisorJob(mission, service.store)) {
      maybeEmitSupervisionHeartbeat(service, mission);
      continue;
    }

    const step = nextPendingStep(mission, contract);
    if (!step) {
      if (allStepsDone(mission, contract) && mission.status !== "verifying") {
        const head = resolveGitHead(
          typeof mission.markers.supervisor_work_path === "string"
            ? mission.markers.supervisor_work_path
            : null,
        );
        service.missions.update(ownerId, mission.id, {
          status: "verifying",
          markers: {
            supervision_state: "idle",
            current_step_id: null,
            ...(head ? { evidence_git_head: head } : {}),
          },
        });
      }
      continue;
    }

    // Reconcile a terminal result if restart lost its callback.
    const lastId = mission.markers.supervisor_last_job_id;
    const lastJob = typeof lastId === "string" ? service.store.getJob(lastId) : null;
    if (lastJob && lastJob.idempotency_key === missionAttemptKey(mission.id, step.id, stepAttempt(mission, step.id))) {
      if (lastJob.status === "succeeded") {
        missionSupervisorOnJobFinished(service, lastJob.id, "succeeded");
        continue;
      }
      if (lastJob.status === "cancelled" || (step.kind !== "synthetic" &&
          (lastJob.status === "failed" || lastJob.status === "timed_out"))) {
        blockSupervision(service, mission, lastJob.status === "cancelled"
          ? "step cancelled; waiting for an explicit resume"
          : "step outcome requires reconciliation before retry; prior work will not be replayed");
        continue;
      }
    }
    if (step.kind === "owner_checkpoint") {
      service.missions.update(ownerId, mission.id, {
        markers: {
          supervision_state: "paused",
          current_step_id: step.id,
          owner_checkpoint_pending: step.id,
          block_reason: `Owner checkpoint: ${step.title}`,
          next_owner_action: step.title,
        },
      });
      continue;
    }
    if (step.kind === "verify") {
      if (await runVerifyAcceptanceStep(service, mission, contract, step)) continue;
    }
    if (step.kind !== "synthetic" && (!step.agent || step.agent === "mock")) {
      blockSupervision(service, mission, "real work requires an explicit execution agent; no mock substitution");
      continue;
    }
    const attempt = stepAttempt(mission, step.id) + 1;
    const maxRetries = contract.supervision.max_step_retries;
    if (attempt > maxRetries + 1) {
      service.missions.update(ownerId, mission.id, {
        status: "blocked",
        markers: {
          supervision_state: "blocked",
          block_reason: `step ${step.id} exhausted ${maxRetries} retries`,
          current_step_id: step.id,
        },
      });
      continue;
    }

    const backoffSec = contract.supervision.backoff_sec;
    const lastFail = mission.markers[`step_last_fail_at:${step.id}`];
    if (
      typeof lastFail === "string" &&
      Date.now() - Date.parse(lastFail) < backoffSec * 1000
    ) {
      continue;
    }

    const agent = resolveStepAgent(mission, step, service.config);
    if (!agent) {
      blockSupervision(service, mission, "executor_unavailable: no enabled executor is available for this step");
      continue;
    }
    const idempotencyKey = missionAttemptKey(mission.id, step.id, attempt);
    try {
      const tier =
        step.kind === "verify"
          ? "verification"
          : step.kind === "implement"
            ? "implement"
            : "default";
      const task = service.startTask({
        ownerId,
        missionId: mission.id,
        agent,
        projectId: agent === "mock" ? step.project_id ?? "demo-sandbox" : undefined,
        workspace:
          agent === "mock"
            ? undefined
            : mission.workspace ?? undefined,
        prompt: buildStepPrompt(mission, step, lastJob?.summary),
        idempotencyKey,
        tier,
      });
      service.missions.update(ownerId, mission.id, {
        status: mission.status === "approved" ? "implementing" : mission.status,
        linkJobId: task.id,
        markers: {
          supervision_state: "running",
          current_step_id: step.id,
          [`step_attempt:${step.id}`]: attempt,
          supervisor_last_job_id: task.id,
          supervision_next_run_at: null,
          supervision_wait_reason: null,
          block_reason: null,
          ...supervisionHeartbeatMarkers(),
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/agent not enabled|kimi_retired|binary .*not found/i.test(msg)) {
        service.missions.update(ownerId, mission.id, { markers: {
          [`executor_unavailable:${agent}`]: true, supervision_state: "idle",
          block_reason: null, last_executor_unavailable_reason: msg.slice(0, 200),
        }});
        continue;
      }
      if (msg.includes("workspace busy")) {
        continue;
      }
      // startTask checks pacing before creating a job. This is a durable
      // scheduling wait, not a failed execution or a consumed attempt.
      const retryAfter = msg.startsWith("usage budget:")
        ? msg.match(/retry_after_sec=(\d+)/)
        : null;
      if (retryAfter) {
        const delaySec = Math.max(1, Number(retryAfter[1]));
        service.missions.update(ownerId, mission.id, {
          markers: {
            supervision_state: "waiting",
            supervision_next_run_at: new Date(now + delaySec * 1000).toISOString(),
            supervision_wait_reason: msg.slice(0, 200),
            block_reason: null,
          },
        });
        continue;
      }
      blockSupervision(service, mission,
        `supervisor could not start task: ${msg.slice(0, 200)}`);
    }
  }
}

export function missionSupervisorOnJobFinished(
  service: MissionSupervisorService,
  jobId: string,
  status: string,
): void {
  const cfg = supervisorConfig(service.config);
  if (!cfg.enabled) return;

  const ownerId = service.config.owner.id;
  const job = service.store.getJob(jobId);
  if (!job) return;

  const missions = service.missions.list(ownerId, { limit: 50 });
  const mission = missions.find((m) => m.linked_job_ids.includes(jobId));
  if (!mission) return;

  const contract = contractFromMission(mission);
  if (!contract) return;
  if (mission.markers.project_active !== true) return;
  if (!SUPERVISABLE.has(mission.status)) return;
  if (["blocked", "paused"].includes(String(mission.markers.supervision_state))) return;

  const stepId =
    typeof mission.markers.current_step_id === "string"
      ? mission.markers.current_step_id
      : null;
  if (!stepId) return;
  const step = contract.steps.find(s => s.id === stepId);
  if (!step) return;
  // A delayed callback must not finish a newer step or attempt.
  if (job.idempotency_key !== missionAttemptKey(mission.id, stepId, stepAttempt(mission, stepId))) return;

  if (status === "succeeded") {
    const head = job.work_path ? resolveGitHead(job.work_path) : null;
    const next = nextPendingStep(
      {
        ...mission,
        markers: {
          ...mission.markers,
          [stepMarkerDone(stepId)]: true,
        },
      },
      contract,
    );
    service.missions.update(ownerId, mission.id, {
      markers: {
        [stepMarkerDone(stepId)]: true,
        supervision_state: next ? "idle" : "idle",
        current_step_id: next?.id ?? null,
        ...(head ? { evidence_git_head: head, supervisor_work_path: job.work_path } : {}),
        review_packet_version:
          !next && mission.markers.review_packet_version == null
            ? 1
            : typeof mission.markers.review_packet_version === "number"
              ? mission.markers.review_packet_version
              : null,
      },
      status: next ? "implementing" : "verifying",
    });
    return;
  }

  if (status === "cancelled") {
    blockSupervision(service, mission, "step cancelled; waiting for an explicit resume");
    return;
  }
  if (status === "failed" || status === "timed_out") {
    if (step.kind !== "synthetic") {
      blockSupervision(service, mission, "step outcome requires reconciliation before retry; prior work will not be replayed");
      return;
    }
    service.missions.update(ownerId, mission.id, {
      markers: {
        supervision_state: "recovering",
        [`step_last_fail_at:${stepId}`]: new Date().toISOString(),
        block_reason: null,
      },
    });
  }
}
