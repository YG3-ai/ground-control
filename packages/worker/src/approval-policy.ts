import type { MissionRecord } from "./missions/store.js";
import type { ApprovalKind } from "./local/approvals.js";

/** Owner-selected persistent Ground workflow policy (hybrid remote). */
export const APPROVAL_POLICY_HYBRID_REMOTE = "hybrid_remote";

export const APPROVAL_SOURCE_CHAT_EXPLICIT = "chat_explicit";
export const APPROVAL_SOURCE_LOCAL_DIALOG = "local_dialog";

/** Bounded scope covered by chat-explicit mission approval (routine work). */
export const ROUTINE_APPROVED_SCOPE = "read_code_test_terminal";

const POST_PLAN_APPROVAL_STATUSES = new Set([
  "approved",
  "implementing",
  "verifying",
]);

export type MissionAuthorization =
  | typeof APPROVAL_SOURCE_CHAT_EXPLICIT
  | typeof APPROVAL_SOURCE_LOCAL_DIALOG;

export function hybridRemoteMarkers(
  authorization: MissionAuthorization,
  approvedScope = ROUTINE_APPROVED_SCOPE,
): Record<string, string | boolean> {
  return {
    approval_policy: APPROVAL_POLICY_HYBRID_REMOTE,
    approval_source: authorization,
    approved_scope: approvedScope,
    plan_approved: true,
  };
}

export function isHybridRemoteMission(m: MissionRecord): boolean {
  return m.markers?.approval_policy === APPROVAL_POLICY_HYBRID_REMOTE;
}

/** Mission already carries chat/local approval for routine in-scope work. */
export function missionRoutineScopeApproved(m: MissionRecord): boolean {
  if (!isHybridRemoteMission(m)) return false;
  if (!POST_PLAN_APPROVAL_STATUSES.has(m.status)) return false;
  const src = m.markers?.approval_source;
  return (
    src === APPROVAL_SOURCE_CHAT_EXPLICIT ||
    src === APPROVAL_SOURCE_LOCAL_DIALOG
  );
}

export function resolveMissionApprovalMode(opts: {
  requireDialog?: boolean;
  authorization?: MissionAuthorization;
}): "local_dialog" | "chat_explicit" | "already_approved" {
  if (opts.requireDialog === true) return "local_dialog";
  if (opts.authorization === APPROVAL_SOURCE_LOCAL_DIALOG) return "local_dialog";
  if (opts.authorization === APPROVAL_SOURCE_CHAT_EXPLICIT) return "chat_explicit";
  return "local_dialog";
}

/** Sensitive actions always need Mac confirmation under hybrid_remote. */
export function requiresLocalDialogForKind(kind: ApprovalKind): boolean {
  return kind === "destructive" || kind === "permission" || kind === "browser_open";
}

export function isSensitiveApprovalRequest(input: {
  kind: ApprovalKind;
  title: string;
  detail: string;
}): boolean {
  if (requiresLocalDialogForKind(input.kind)) return true;
  const blob = `${input.title}\n${input.detail}`.toLowerCase();
  if (
    /\b(deploy|publish|production|send email|external send|credential|api[_ -]?key|password|secret|oauth|token|scope expansion|permission expansion)\b/.test(
      blob,
    )
  ) {
    return true;
  }
  return false;
}

export function isMissionWorkspaceScopeExpansion(
  mission: MissionRecord,
  workspace: string | null | undefined,
): boolean {
  if (workspace === undefined) return false;
  if (!missionRoutineScopeApproved(mission)) return false;
  const prev = (mission.workspace ?? "").trim();
  const next = (workspace ?? "").trim();
  return next !== prev;
}

export function routineTerminalAllowedForMission(m: MissionRecord | null): boolean {
  if (!m) return false;
  return missionRoutineScopeApproved(m);
}
