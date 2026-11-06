import { spawnSync } from "node:child_process";
import type { JobRecord } from "@agent-control/shared";
import type { MissionRecord } from "./store.js";
import {
  allStepsDone,
  contractFromMission,
  type MissionContract,
} from "./contract.js";
import {
  acceptanceEvidenceMarker,
} from "./acceptance-runner.js";
import { assertDeploymentGate } from "./deployment-record.js";

export type CompletionGateResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

export function resolveGitHead(workPath: string | null): string | null {
  if (!workPath) return null;
  const r = spawnSync("git", ["-C", workPath, "rev-parse", "HEAD"], {
    encoding: "utf8",
  });
  if (r.status !== 0 || !r.stdout?.trim()) return null;
  return r.stdout.trim();
}

function linkedJobsSucceeded(
  mission: MissionRecord,
  jobs: Map<string, JobRecord>,
): boolean {
  if (mission.linked_job_ids.length === 0) return false;
  return mission.linked_job_ids.some((id) => jobs.get(id)?.status === "succeeded");
}

function usabilityEvidenceOk(
  mission: MissionRecord,
  contract: MissionContract,
  jobs: Map<string, JobRecord>,
): boolean {
  if (!contract.evidence.require_usability) return true;
  const prefix = contract.evidence.qa_job_marker_prefix;
  const desktop = mission.markers[`${prefix}desktop`];
  const mobile = mission.markers[`${prefix}mobile`];
  if (typeof desktop !== "string" || typeof mobile !== "string") {
    return false;
  }
  const d = jobs.get(desktop);
  const mob = jobs.get(mobile);
  return d?.status === "succeeded" && mob?.status === "succeeded";
}

function workUiEvidenceOk(mission: MissionRecord, contract: MissionContract): boolean {
  if (!contract.evidence.require_work_ui_evidence) return true;
  return (
    mission.markers.work_ui_evidence === "pass" &&
    typeof mission.markers.work_ui_evidence_at === "string"
  );
}

function acceptanceCommandEvidenceOk(
  mission: MissionRecord,
  contract: MissionContract,
): boolean {
  for (const step of contract.steps) {
    if (step.kind !== "verify" || !step.acceptance_command) continue;
    const testId =
      step.acceptance_test_id ??
      (step.id.startsWith("verify_") ? step.id.slice("verify_".length) : step.id);
    const outcome = mission.markers[acceptanceEvidenceMarker(testId)];
    if (outcome !== "pass") return false;
  }
  return true;
}

export function assertCanSubmitReview(
  mission: MissionRecord,
  jobs: Map<string, JobRecord>,
  opts?: { force?: boolean },
): CompletionGateResult {
  if (opts?.force) return { ok: true };
  const contract = contractFromMission(mission);
  if (!contract) {
    return {
      ok: false,
      code: "no_contract",
      message: "mission has no persisted contract — cannot stage review",
    };
  }
  if (!allStepsDone(mission, contract)) {
    return {
      ok: false,
      code: "steps_incomplete",
      message: "not all contract steps are complete",
    };
  }
  if (mission.status !== "verifying" && mission.status !== "implementing") {
    return {
      ok: false,
      code: "bad_status",
      message: `status must be verifying before review (got ${mission.status})`,
    };
  }
  if (!linkedJobsSucceeded(mission, jobs)) {
    return {
      ok: false,
      code: "no_succeeded_job",
      message: "at least one linked job must have succeeded",
    };
  }
  if (contract.evidence.require_git_head) {
    const recorded = mission.markers.evidence_git_head;
    const head = resolveGitHead(
      typeof mission.markers.supervisor_work_path === "string"
        ? mission.markers.supervisor_work_path
        : null,
    );
    if (typeof recorded !== "string" || !head) {
      return {
        ok: false,
        code: "missing_git_evidence",
        message: "evidence_git_head marker or workspace HEAD unavailable",
      };
    }
    if (recorded !== head) {
      return {
        ok: false,
        code: "stale_git_evidence",
        message: "evidence_git_head does not match current workspace HEAD",
      };
    }
  }
  if (!usabilityEvidenceOk(mission, contract, jobs)) {
    return {
      ok: false,
      code: "usability_evidence",
      message: "desktop/mobile QA job markers missing or not succeeded",
    };
  }
  if (!workUiEvidenceOk(mission, contract)) {
    return {
      ok: false,
      code: "work_ui_evidence",
      message: "actual Work UI evidence missing or not marked pass",
    };
  }
  if (!acceptanceCommandEvidenceOk(mission, contract)) {
    return {
      ok: false,
      code: "acceptance_evidence",
      message: "acceptance command evidence missing or failed for one or more verify steps",
    };
  }
  const reviewPacket = mission.markers.review_packet_version;
  if (typeof reviewPacket !== "number" && typeof reviewPacket !== "string") {
    return {
      ok: false,
      code: "missing_review_packet",
      message: "review_packet_version marker required before ready_for_review",
    };
  }
  return { ok: true };
}

export function assertCanComplete(
  mission: MissionRecord,
  jobs: Map<string, JobRecord>,
  opts?: { ownerReleaseAuthorized?: boolean },
): CompletionGateResult {
  const contract = contractFromMission(mission);
  if (!contract) return { ok: true };
  if (mission.status !== "ready_for_review") {
    return {
      ok: false,
      code: "not_reviewed",
      message:
        "contract missions must reach ready_for_review before done; owner release required",
    };
  }
  if (!opts?.ownerReleaseAuthorized) {
    return {
      ok: false,
      code: "owner_release",
      message: "owner_release_authorized required to mark contract mission done",
    };
  }
  const deployGate = assertDeploymentGate(mission, contract, {
    ownerReleaseAuthorized: opts?.ownerReleaseAuthorized,
  });
  if (!deployGate.ok) {
    return deployGate;
  }
  return assertCanSubmitReview({ ...mission, status: "verifying" }, jobs);
}

export function assertPlanEditAllowed(mission: MissionRecord): CompletionGateResult {
  const approved = mission.markers.plan_approved === true;
  const approvedVersion = mission.markers.approved_contract_version;
  if (!approved) return { ok: true };
  if (mission.status === "plan_ready" || mission.status === "researching") {
    return { ok: true };
  }
  if (approvedVersion != null && mission.markers.contract_version !== approvedVersion) {
    return {
      ok: false,
      code: "contract_version_drift",
      message: "plan/contract changed after approval — return to plan_ready or re-approve",
    };
  }
  return { ok: true };
}
