import type { MissionRecord } from "./store.js";
import type { MissionContract, MissionDeploymentPolicy } from "./contract.js";

export const DEPLOYMENT_RECORD_AT = "deployment_record_at";
export const DEPLOYMENT_RECORD_KIND = "deployment_record_kind";
export const DEPLOYMENT_RECORD_GIT_HEAD = "deployment_record_git_head";
export const DEPLOYMENT_POLICY_MODE = "deployment_policy_mode";

export type DeploymentRecordKind = "owner_release" | "staging" | "none";

export type DeploymentRecord = {
  kind: DeploymentRecordKind;
  recorded_at: string;
  git_head?: string | null;
  policy_mode: MissionDeploymentPolicy["mode"];
};

export function deploymentPolicyFromContract(
  contract: MissionContract,
): MissionDeploymentPolicy | null {
  return contract.deployment_policy ?? null;
}

export function syncDeploymentPolicyMarker(
  contract: MissionContract,
): Record<string, string> {
  const mode = contract.deployment_policy?.mode;
  if (!mode) return {};
  return { [DEPLOYMENT_POLICY_MODE]: mode };
}

export function readDeploymentRecord(
  mission: MissionRecord,
): DeploymentRecord | null {
  const at = mission.markers[DEPLOYMENT_RECORD_AT];
  const kind = mission.markers[DEPLOYMENT_RECORD_KIND];
  const mode = mission.markers[DEPLOYMENT_POLICY_MODE];
  if (typeof at !== "string" || typeof kind !== "string") return null;
  if (
    kind !== "owner_release" &&
    kind !== "staging" &&
    kind !== "none"
  ) {
    return null;
  }
  const gitHead = mission.markers[DEPLOYMENT_RECORD_GIT_HEAD];
  return {
    kind,
    recorded_at: at,
    git_head: typeof gitHead === "string" ? gitHead : null,
    policy_mode:
      mode === "no_production" ||
      mode === "staging_only" ||
      mode === "owner_release_required"
        ? mode
        : "owner_release_required",
  };
}

export function deploymentRecordMarkers(input: {
  kind: DeploymentRecordKind;
  recordedAt: string;
  gitHead?: string | null;
  policyMode: MissionDeploymentPolicy["mode"];
}): Record<string, string | null> {
  return {
    [DEPLOYMENT_RECORD_AT]: input.recordedAt,
    [DEPLOYMENT_RECORD_KIND]: input.kind,
    [DEPLOYMENT_RECORD_GIT_HEAD]: input.gitHead ?? null,
    [DEPLOYMENT_POLICY_MODE]: input.policyMode,
  };
}

export type DeploymentGateResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

/** Enforce explicit deployment policy before owner release completes a mission. */
export function assertDeploymentGate(
  mission: MissionRecord,
  contract: MissionContract,
  opts?: { ownerReleaseAuthorized?: boolean },
): DeploymentGateResult {
  const policy = contract.deployment_policy;
  if (!policy) return { ok: true };

  const record = readDeploymentRecord(mission);
  if (policy.mode === "no_production") {
    if (opts?.ownerReleaseAuthorized !== true) {
      return {
        ok: false,
        code: "owner_release",
        message: "owner_release_authorized required before completion",
      };
    }
    return { ok: true };
  }
  if (policy.mode === "staging_only") {
    if (!record || record.kind !== "staging") {
      return {
        ok: false,
        code: "staging_deploy_required",
        message:
          "deployment policy staging_only requires a recorded staging deployment before completion",
      };
    }
    return { ok: true };
  }
  if (policy.mode === "owner_release_required") {
    if (opts?.ownerReleaseAuthorized !== true) {
      return {
        ok: false,
        code: "owner_release",
        message: "owner_release_authorized required before completion",
      };
    }
    return { ok: true };
  }
  return { ok: true };
}
