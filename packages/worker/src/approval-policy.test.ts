import { describe, expect, it } from "vitest";
import {
  APPROVAL_POLICY_HYBRID_REMOTE,
  APPROVAL_SOURCE_CHAT_EXPLICIT,
  isMissionWorkspaceScopeExpansion,
  isSensitiveApprovalRequest,
  missionRoutineScopeApproved,
  resolveMissionApprovalMode,
  routineTerminalAllowedForMission,
} from "./approval-policy.js";
import type { MissionRecord } from "./missions/store.js";

function mission(partial: Partial<MissionRecord> & { status: MissionRecord["status"] }): MissionRecord {
  return {
    id: "m1",
    owner_id: "owner-test",
    title: "t",
    goal: "g",
    workspace: "demo",
    status: partial.status,
    plan: "plan",
    findings: null,
    summary: null,
    markers: partial.markers ?? {},
    linked_job_ids: [],
    linked_session_ids: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    approved_at: null,
    completed_at: null,
    ...partial,
  };
}

describe("approval-policy hybrid_remote", () => {
  it("chat_explicit resolves to non-dialog approval mode", () => {
    expect(
      resolveMissionApprovalMode({ authorization: APPROVAL_SOURCE_CHAT_EXPLICIT }),
    ).toBe("chat_explicit");
    expect(resolveMissionApprovalMode({ requireDialog: true })).toBe("local_dialog");
  });

  it("detects routine approved mission scope", () => {
    const m = mission({
      status: "implementing",
      markers: {
        approval_policy: APPROVAL_POLICY_HYBRID_REMOTE,
        approval_source: APPROVAL_SOURCE_CHAT_EXPLICIT,
        approved_scope: "read_code_test_terminal",
      },
    });
    expect(missionRoutineScopeApproved(m)).toBe(true);
    expect(routineTerminalAllowedForMission(m)).toBe(true);
  });

  it("flags workspace scope expansion on approved mission", () => {
    const m = mission({
      status: "approved",
      workspace: "a",
      markers: {
        approval_policy: APPROVAL_POLICY_HYBRID_REMOTE,
        approval_source: APPROVAL_SOURCE_CHAT_EXPLICIT,
      },
    });
    expect(isMissionWorkspaceScopeExpansion(m, "b")).toBe(true);
    expect(isMissionWorkspaceScopeExpansion(m, "a")).toBe(false);
  });

  it("classifies sensitive local approval requests", () => {
    expect(
      isSensitiveApprovalRequest({
        kind: "general",
        title: "Deploy to production",
        detail: "ship",
      }),
    ).toBe(true);
    expect(
      isSensitiveApprovalRequest({
        kind: "general",
        title: "Continue tests",
        detail: "run vitest",
      }),
    ).toBe(false);
  });
});
