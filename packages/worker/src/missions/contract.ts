import { z } from "zod";
import type { MissionRecord } from "./store.js";

export const MISSION_STEP_KINDS = [
  "implement",
  "verify",
  "synthetic",
  "owner_checkpoint",
] as const;

export const MissionStepSchema = z.object({
  id: z.string().min(1).max(80),
  title: z.string().min(1).max(200),
  kind: z.enum(MISSION_STEP_KINDS),
  /** Step ids within this contract that must complete first. */
  depends_on: z.array(z.string().min(1).max(80)).max(15).optional(),
  /** Host agent for live workspaces; mock requires project_id. */
  agent: z.enum(["mock", "cursor", "kimi", "codex"]).optional(),
  project_id: z.string().optional(),
  prompt: z.string().max(20_000).optional(),
  /** Qualification acceptance test id (verify steps). */
  acceptance_test_id: z.string().max(80).optional(),
  /** Shell command to run for verify steps — not copied into events. */
  acceptance_command: z.string().max(2000).optional(),
});

export const MissionDeploymentPolicySchema = z.object({
  mode: z.enum(["no_production", "staging_only", "owner_release_required"]),
  notes: z.string().max(2000).optional(),
});

export type MissionDeploymentPolicy = z.infer<typeof MissionDeploymentPolicySchema>;

export const MissionContractSchema = z.object({
  version: z.number().int().positive(),
  steps: z.array(MissionStepSchema).min(1).max(30),
  supervision: z
    .object({
      max_step_retries: z.number().int().min(0).max(10).default(2),
      backoff_sec: z.number().int().min(0).max(3600).default(5),
    })
    .default({ max_step_retries: 2, backoff_sec: 5 }),
  evidence: z
    .object({
      require_git_head: z.boolean().default(true),
      require_usability: z.boolean().default(false),
      /** Require a durable, human-reviewed Work UI render/check before review. */
      require_work_ui_evidence: z.boolean().default(false),
      qa_job_marker_prefix: z.string().max(40).default("qa_job_"),
    })
    .default({
      require_git_head: true,
      require_usability: false,
      require_work_ui_evidence: false,
      qa_job_marker_prefix: "qa_job_",
    }),
  cleanup: z
    .object({
      cancel_active_jobs: z.boolean().default(true),
      release_queue_lease: z.boolean().default(true),
    })
    .default({ cancel_active_jobs: true, release_queue_lease: true }),
  budgets: z
    .object({
      resource_class: z.string().max(40).default("default"),
      max_concurrent_jobs: z.number().int().min(1).max(10).default(1),
    })
    .default({ resource_class: "default", max_concurrent_jobs: 1 }),
  deployment_policy: MissionDeploymentPolicySchema.optional(),
});

export type MissionContract = z.infer<typeof MissionContractSchema>;
export type MissionStep = z.infer<typeof MissionStepSchema>;

const CONTRACT_MARKER = "mission_contract_json";

export function contractFromMission(m: MissionRecord): MissionContract | null {
  const raw = m.markers[CONTRACT_MARKER];
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return MissionContractSchema.parse(parsed);
  } catch {
    return null;
  }
}

export function contractMarkerPayload(contract: MissionContract): {
  mission_contract_json: string;
  contract_version: number;
} {
  return {
    mission_contract_json: JSON.stringify(contract),
    contract_version: contract.version,
  };
}

export function stepMarkerDone(stepId: string): string {
  return `step_done:${stepId}`;
}

export function isStepDone(m: MissionRecord, stepId: string): boolean {
  return m.markers[stepMarkerDone(stepId)] === true;
}

function stepDependenciesMet(m: MissionRecord, step: MissionStep): boolean {
  const deps = step.depends_on ?? [];
  return deps.every((depId) => isStepDone(m, depId));
}

export function ownerCheckpointAckMarker(stepId: string): string {
  return `owner_checkpoint_ack:${stepId}`;
}

export function acknowledgeOwnerCheckpointMarker(stepId: string): Record<string, boolean> {
  return {
    [ownerCheckpointAckMarker(stepId)]: true,
    [stepMarkerDone(stepId)]: true,
  };
}

export function nextPendingStep(
  m: MissionRecord,
  contract: MissionContract,
): MissionStep | null {
  for (const step of contract.steps) {
    if (isStepDone(m, step.id)) continue;
    if (!stepDependenciesMet(m, step)) continue;
    return step;
  }
  return null;
}

export function allStepsDone(m: MissionRecord, contract: MissionContract): boolean {
  return nextPendingStep(m, contract) === null;
}

export function missionAttemptKey(
  missionId: string,
  stepId: string,
  attempt: number,
): string {
  return `mission:${missionId}:step:${stepId}:attempt:${attempt}`;
}

export function parseAttemptFromIdempotencyKey(key: string | null | undefined): number | null {
  if (!key) return null;
  const m = key.match(/:attempt:(\d+)$/);
  return m ? Number(m[1]) : null;
}
