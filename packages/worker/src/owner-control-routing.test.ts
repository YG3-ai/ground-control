import { describe, expect, it } from "vitest";
import { isSensitiveApprovalRequest } from "./approval-policy.js";
import {
  buildOwnerControlPolicySurface,
  OWNER_CONTROL_MODE_PERMANENT,
  routeApprovalTool,
} from "./owner-control-policy.js";

describe("owner control policy surface", () => {
  it("exposes permanent owner control markers when configured", () => {
    const surface = buildOwnerControlPolicySurface({
      enabled: true,
      owner_control_mode: "permanent",
      approval_timeout_sec: 120,
      approval_pending_expiry_sec: 0,
    });
    expect(surface.owner_control_mode).toBe(OWNER_CONTROL_MODE_PERMANENT);
    expect(surface.owner_control_active).toBe(true);
    expect(surface.markers.owner_control_approved).toBe(true);
    expect(surface.approval_pending_expiry_sec).toBe(0);
    expect(surface.fail_closed_without_authenticated_owner).toBe(true);
  });

  it("defaults owner control off when unset", () => {
    const surface = buildOwnerControlPolicySurface({ enabled: true });
    expect(surface.owner_control_active).toBe(false);
    expect(surface.markers.owner_control_approved).toBe(false);
  });
});

describe("approval tool routing", () => {
  it("fails closed without authenticated owner", () => {
    expect(
      routeApprovalTool({
        tool: "start_task",
        ownerAuthenticated: false,
        ownerControlPermanent: true,
      }).route,
    ).toBe("reject_unauthenticated");
  });

  it("allows routine tasks under permanent owner control", () => {
    expect(
      routeApprovalTool({
        tool: "start_task",
        ownerAuthenticated: true,
        ownerControlPermanent: true,
      }),
    ).toMatchObject({ route: "routine_no_mac_dialog" });
  });

  it("requires Mac for sensitive request_local_approval", () => {
    expect(
      routeApprovalTool({
        tool: "request_local_approval",
        ownerAuthenticated: true,
        ownerControlPermanent: true,
        kind: "destructive",
        title: "Delete production database",
        detail: "drop all tables",
      }).route,
    ).toBe("mac_required");
  });

  it("blocks routine misuse of request_local_approval", () => {
    expect(
      routeApprovalTool({
        tool: "request_local_approval",
        ownerAuthenticated: true,
        ownerControlPermanent: true,
        kind: "general",
        title: "Run vitest",
        detail: "npm test in agent-control",
      }).route,
    ).toBe("do_not_call_request_local_approval");
  });

  it("still requires Mac for browser open by default", () => {
    expect(
      routeApprovalTool({
        tool: "open_url",
        ownerAuthenticated: true,
        ownerControlPermanent: true,
      }).route,
    ).toBe("mac_required");
  });

  it("classifies expanded sensitive categories", () => {
    expect(
      isSensitiveApprovalRequest({
        kind: "general",
        title: "Wire transfer to vendor",
        detail: "pay invoice",
      }),
    ).toBe(true);
    expect(
      isSensitiveApprovalRequest({
        kind: "general",
        title: "Email client update",
        detail: "send draft to Angela",
      }),
    ).toBe(true);
    expect(
      isSensitiveApprovalRequest({
        kind: "general",
        title: "npm test",
        detail: "worker package",
      }),
    ).toBe(false);
  });
});
