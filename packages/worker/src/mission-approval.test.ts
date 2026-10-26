import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createService, initGitFixture, makeTempRoot } from "./test-utils.js";
import type { WorkerService } from "./service.js";
import { APPROVAL_SOURCE_CHAT_EXPLICIT } from "./approval-policy.js";

const services: WorkerService[] = [];
afterEach(() => {
  for (const s of services.splice(0)) s.close();
});

function serviceWithPlan(): { service: WorkerService; missionId: string } {
  const root = makeTempRoot();
  const fixture = join(root, "fixture");
  mkdirSync(fixture);
  initGitFixture(fixture);
  const service = createService(root, fixture);
  services.push(service);
  const m = service.createMission({
    ownerId: "owner-test",
    title: "Hybrid test",
    goal: "verify policy",
    workspace: "demo-sandbox",
  });
  service.updateMission("owner-test", m.id, {
    status: "plan_ready",
    plan: "Step 1: run tests",
  });
  return { service, missionId: m.id };
}

describe("approveMission hybrid_remote", () => {
  it("chat_explicit approves without local dialog record", async () => {
    const { service, missionId } = serviceWithPlan();
    const requestSpy = vi.spyOn(service.approvals, "request");
    const result = await service.approveMission("owner-test", missionId, {
      authorization: APPROVAL_SOURCE_CHAT_EXPLICIT,
    });
    expect(result.approved).toBe(true);
    expect(result.approval).toBeNull();
    expect(requestSpy).not.toHaveBeenCalled();
    expect(result.mission.markers.approval_policy).toBe("hybrid_remote");
    expect(result.mission.markers.approval_source).toBe("chat_explicit");
    requestSpy.mockRestore();
  });

  it("does not retry approval when mission already approved", async () => {
    const { service, missionId } = serviceWithPlan();
    const requestSpy = vi.spyOn(service.approvals, "request");
    await service.approveMission("owner-test", missionId, {
      authorization: APPROVAL_SOURCE_CHAT_EXPLICIT,
    });
    const again = await service.approveMission("owner-test", missionId, {
      authorization: APPROVAL_SOURCE_CHAT_EXPLICIT,
    });
    expect(again.already_approved).toBe(true);
    expect(requestSpy).not.toHaveBeenCalled();
    requestSpy.mockRestore();
  });

  it("require_dialog creates local approval flow", async () => {
    const { service, missionId } = serviceWithPlan();
    service.approvals.request = vi.fn(async () => ({
      id: "a1",
      owner_id: "owner-test",
      kind: "permission",
      title: "t",
      detail: "d",
      status: "approved",
      created_at: new Date().toISOString(),
      resolved_at: new Date().toISOString(),
      resolution_note: null,
      payload: {},
    }));
    const result = await service.approveMission("owner-test", missionId, {
      requireDialog: true,
    });
    expect(service.approvals.request).toHaveBeenCalledOnce();
    expect(result.approved).toBe(true);
    expect(result.mission.markers.approval_source).toBe("local_dialog");
  });

  it("routine terminal write path does not require request_local_approval", async () => {
    const { service, missionId } = serviceWithPlan();
    await service.approveMission("owner-test", missionId, {
      authorization: APPROVAL_SOURCE_CHAT_EXPLICIT,
    });
    await expect(
      service.requestLocalApproval({
        ownerId: "owner-test",
        kind: "general",
        title: "Run unit tests",
        detail: "vitest in approved mission",
        wait: false,
      }),
    ).rejects.toThrow(/hybrid_remote/);
  });

  it("scope expansion update requires Mac confirmation path", async () => {
    const { service, missionId } = serviceWithPlan();
    await service.approveMission("owner-test", missionId, {
      authorization: APPROVAL_SOURCE_CHAT_EXPLICIT,
    });
    expect(() =>
      service.updateMission("owner-test", missionId, { workspace: "other-workspace" }),
    ).toThrow(/scope expansion/);
  });
});
