import type { MissionRecord } from "./store.js";
import {
  contractMarkerPayload,
  type MissionContract,
  type MissionStep,
} from "./contract.js";
import type { QualificationPacket } from "./qualification.js";
import type { MissionQueueStore } from "./queue-store.js";
import type { MissionStore } from "./store.js";
import { syncDeploymentPolicyMarker } from "./deployment-record.js";

const DEFAULT_ENQUEUE_KEY_PREFIX = "ground-delivery-v2:";

function checkpointSteps(
  packet: QualificationPacket,
  when: QualificationPacket["owner_checkpoints"][number]["when"],
  afterStepId: string | null,
): MissionStep[] {
  return packet.owner_checkpoints
    .filter((cp) => cp.when === when)
    .map((cp) => ({
      id: `owner_${cp.id}`,
      title: cp.title,
      kind: "owner_checkpoint" as const,
      prompt: cp.detail,
      depends_on: afterStepId ? [afterStepId] : undefined,
    }));
}

/** Compile an approved qualification packet (+ optional plan text) into a v2 mission contract. */
export function compileQualificationToContract(
  packet: QualificationPacket,
  input?: { plan?: string | null },
): MissionContract {
  const steps: MissionStep[] = [];
  let lastStepId: string | null = null;

  for (const cpStep of checkpointSteps(packet, "before_implement", lastStepId)) {
    steps.push(cpStep);
    lastStepId = cpStep.id;
  }

  const implementId = "implement";
  const scopeSummary = packet.scope_in.map((s) => `- ${s}`).join("\n");
  const constraintBlock =
    packet.constraints.length > 0
      ? `\nConstraints:\n${packet.constraints.map((c) => `- ${c}`).join("\n")}`
      : "";
  steps.push({
    id: implementId,
    title: "Implement qualified scope",
    kind: "implement",
    agent: packet.execution_agent,
    depends_on: lastStepId ? [lastStepId] : undefined,
    prompt: [
      `Objective: ${packet.objective}`,
      `In scope:\n${scopeSummary}`,
      packet.scope_out.length
        ? `Out of scope:\n${packet.scope_out.map((s) => `- ${s}`).join("\n")}`
        : "",
      constraintBlock,
      input?.plan ? `Approved plan:\n${input.plan}` : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
  });
  lastStepId = implementId;

  for (const cpStep of checkpointSteps(packet, "after_implement", lastStepId)) {
    steps.push(cpStep);
    lastStepId = cpStep.id;
  }

  for (const cpStep of checkpointSteps(packet, "before_verify", lastStepId)) {
    steps.push(cpStep);
    lastStepId = cpStep.id;
  }

  for (const test of packet.acceptance_tests) {
    const id = `verify_${test.id}`;
    steps.push({
      id,
      title: test.description.slice(0, 200),
      kind: "verify",
      depends_on: lastStepId ? [lastStepId] : undefined,
      acceptance_test_id: test.id,
      ...(test.command ? { acceptance_command: test.command } : {}),
      prompt: test.command
        ? `Run acceptance command and capture evidence:\n${test.command}`
        : `Verify: ${test.description}`,
    });
    lastStepId = id;
  }

  for (const cp of packet.owner_checkpoints.filter((c) => c.when === "before_release")) {
    const id = `owner_${cp.id}`;
    steps.push({
      id,
      title: cp.title,
      kind: "owner_checkpoint",
      depends_on: lastStepId ? [lastStepId] : undefined,
      prompt: cp.detail,
    });
    lastStepId = id;
  }

  return {
    version: 2,
    steps,
    supervision: {
      max_step_retries: 2,
      backoff_sec: 5,
    },
    evidence: {
      require_git_head: true,
      require_usability: false,
      require_work_ui_evidence: false,
      qa_job_marker_prefix: "qa_job_",
    },
    cleanup: {
      cancel_active_jobs: true,
      release_queue_lease: true,
    },
    budgets: {
      resource_class: "default",
      max_concurrent_jobs: 1,
    },
    deployment_policy: packet.deployment_policy,
  };
}

export function defaultGroundDeliveryEnqueueKey(missionId: string): string {
  return `${DEFAULT_ENQUEUE_KEY_PREFIX}${missionId}`;
}

export type EnrollApprovedMissionInput = {
  ownerId: string;
  missionId: string;
  missionStore: MissionStore;
  missionQueue: MissionQueueStore;
  enqueue: (ownerId: string, input: {
    missionId: string;
    enqueueKey: string;
    maxRetries?: number;
    backoffSec?: number;
    resourceClass?: string;
  }) => ReturnType<MissionQueueStore["enqueue"]>;
};

/** Idempotent durable queue enrollment after approval (Ground Delivery v2 default workflow). */
export function enrollApprovedMissionInQueue(input: EnrollApprovedMissionInput): {
  enrolled: boolean;
  entryId: string;
} {
  const m = input.missionStore.get(input.ownerId, input.missionId);
  if (!m) {
    throw new Error(`mission not found: ${input.missionId}`);
  }
  const contractRaw = m.markers.mission_contract_json;
  if (typeof contractRaw !== "string") {
    throw new Error("mission missing compiled contract — cannot enroll");
  }
  let contract: MissionContract;
  try {
    contract = JSON.parse(contractRaw) as MissionContract;
  } catch {
    throw new Error("mission contract JSON invalid — cannot enroll");
  }

  const enqueueKey = defaultGroundDeliveryEnqueueKey(input.missionId);
  const existing = input.missionQueue.getByEnqueueKey(input.ownerId, enqueueKey);
  if (existing) {
    return { enrolled: false, entryId: existing.id };
  }

  const entry = input.enqueue(input.ownerId, {
    missionId: input.missionId,
    enqueueKey,
    maxRetries: contract.supervision?.max_step_retries,
    backoffSec: contract.supervision?.backoff_sec,
    resourceClass: contract.budgets?.resource_class,
  });
  input.missionStore.update(input.ownerId, input.missionId, {
    markers: {
      project_active: true,
      queue_entry_id: entry.id,
      queue_enqueue_key: entry.enqueue_key,
      queue_state: entry.queue_state,
      ground_delivery_enrolled: true,
    },
  });
  return { enrolled: true, entryId: entry.id };
}

export function approvalContractMarkers(
  contract: MissionContract,
): Record<string, string | number | boolean | null> {
  return {
    ...contractMarkerPayload(contract),
    approved_contract_version: contract.version,
  };
}

export function compileAndMarkContractFromQualification(
  ownerId: string,
  mission: MissionRecord,
  packet: QualificationPacket,
  missionStore: MissionStore,
): MissionRecord {
  const contract = compileQualificationToContract(packet, { plan: mission.plan });
  return missionStore.update(ownerId, mission.id, {
    workspace: mission.workspace ?? packet.workspace,
    markers: {
      ...approvalContractMarkers(contract),
      ...syncDeploymentPolicyMarker(contract),
    },
  });
}
