import type { ApprovalKind } from "./local/approvals.js";
import { isSensitiveApprovalRequest } from "./approval-policy.js";

/** Owner-selected permanent workflow: authenticated ChatGPT owner authorizes routine Mac work without duplicate dialogs. */
export const OWNER_CONTROL_MODE_PERMANENT = "permanent";
export const OWNER_CONTROL_MODE_OFF = "off";

export type OwnerControlMode =
  | typeof OWNER_CONTROL_MODE_PERMANENT
  | typeof OWNER_CONTROL_MODE_OFF;

export const MAC_CONFIRMATION_CATEGORIES = [
  "destructive_deletion",
  "financial",
  "external_representational_communication",
  "credentials_access_permissions",
  "ambiguous_irreversible",
  "browser_open_default",
  "workspace_scope_expansion",
] as const;

export const ROUTINE_OWNER_CONTROL_ACTIONS = [
  "repo_edits",
  "shell_commands",
  "tests_and_builds",
  "safe_ground_restart",
  "owner_instance_deploy",
  "ground_self_repair",
] as const;

export type ApprovalToolRoute =
  | "mac_required"
  | "routine_no_mac_dialog"
  | "reject_unauthenticated"
  | "do_not_call_request_local_approval";

export function resolveOwnerControlMode(
  localControl?: { owner_control_mode?: string; enabled?: boolean },
): OwnerControlMode {
  if (localControl?.enabled === false) return OWNER_CONTROL_MODE_OFF;
  const raw = (localControl?.owner_control_mode ?? "").trim().toLowerCase();
  if (raw === OWNER_CONTROL_MODE_PERMANENT) return OWNER_CONTROL_MODE_PERMANENT;
  return OWNER_CONTROL_MODE_OFF;
}

export function isOwnerControlPermanent(
  localControl?: { owner_control_mode?: string; enabled?: boolean },
): boolean {
  return resolveOwnerControlMode(localControl) === OWNER_CONTROL_MODE_PERMANENT;
}

export function buildOwnerControlPolicySurface(localControl?: {
  owner_control_mode?: string;
  enabled?: boolean;
  browser_requires_approval?: boolean;
  approval_timeout_sec?: number;
  approval_pending_expiry_sec?: number;
}) {
  const mode = resolveOwnerControlMode(localControl);
  return {
    owner_control_mode: mode,
    owner_control_active: mode === OWNER_CONTROL_MODE_PERMANENT,
    hybrid_remote: true,
    fail_closed_without_authenticated_owner: true,
    routine_actions_without_mac_dialog: [...ROUTINE_OWNER_CONTROL_ACTIONS],
    mac_confirmation_required_for: [...MAC_CONFIRMATION_CATEGORIES],
    authenticated_owner_chat_authorizes_routine_work:
      mode === OWNER_CONTROL_MODE_PERMANENT,
    actions_logged_no_duplicate_mac_for_routine:
      mode === OWNER_CONTROL_MODE_PERMANENT,
    browser_requires_approval: localControl?.browser_requires_approval !== false,
    approval_dialog_wait_sec: localControl?.approval_timeout_sec ?? 120,
    approval_pending_expiry_sec: localControl?.approval_pending_expiry_sec ?? 0,
    markers: {
      owner_control_approved: mode === OWNER_CONTROL_MODE_PERMANENT,
      owner_control_risk_acknowledged: mode === OWNER_CONTROL_MODE_PERMANENT,
      approval_policy: "hybrid_remote",
    },
  };
}

/**
 * How MCP tools should route approval-related work for an authenticated owner.
 */
export function routeApprovalTool(input: {
  tool: "request_local_approval" | "approve_mission" | "open_url" | "start_task";
  ownerAuthenticated: boolean;
  ownerControlPermanent: boolean;
  kind?: ApprovalKind;
  title?: string;
  detail?: string;
  missionChatExplicitApproved?: boolean;
}): { route: ApprovalToolRoute; reason: string } {
  if (!input.ownerAuthenticated) {
    return {
      route: "reject_unauthenticated",
      reason: "MCP bearer auth required; fail closed for non-owner callers",
    };
  }

  if (input.tool === "start_task") {
    if (input.ownerControlPermanent || input.missionChatExplicitApproved) {
      return {
        route: "routine_no_mac_dialog",
        reason: "routine terminal/task work inside owner-authorized scope",
      };
    }
    return {
      route: "mac_required",
      reason: "mission plan not chat-approved yet",
    };
  }

  if (input.tool === "approve_mission") {
    return {
      route: "routine_no_mac_dialog",
      reason: "use authorization=chat_explicit after owner consent; require_dialog only when owner asks for Mac",
    };
  }

  if (input.tool === "open_url") {
    return {
      route: "mac_required",
      reason: "browser_open_default unless require_approval=false and owner explicitly waived",
    };
  }

  const sensitive = isSensitiveApprovalRequest({
    kind: input.kind ?? "general",
    title: input.title ?? "",
    detail: input.detail ?? "",
  });
  if (sensitive) {
    return {
      route: "mac_required",
      reason: "sensitive_action_category",
    };
  }

  return {
    route: "do_not_call_request_local_approval",
    reason:
      "hybrid_remote/owner_control: routine work does not use request_local_approval — proceed and log",
  };
}
