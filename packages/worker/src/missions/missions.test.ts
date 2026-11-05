import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MissionStore } from "./store.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("MissionStore", () => {
  it("runs research → plan → approve → implement → done", () => {
    const dir = mkdtempSync(join(tmpdir(), "ac-mission-"));
    roots.push(dir);
    const store = new MissionStore(join(dir, "missions.db"));
    const m = store.create({
      ownerId: "owner-local",
      title: "Optimize outbound",
      goal: "Improve reply rate without hurting deliverability",
      workspace: "partha-work",
      markers: { area: "outbound" },
    });
    expect(m.status).toBe("intake");

    store.update("owner-local", m.id, {
      status: "researching",
      findings: "Subject A wins in last 7d",
      linkJobId: "job-1",
    });
    store.update("owner-local", m.id, {
      status: "plan_ready",
      plan: "1) Pause weak template\n2) Raise winner volume 20%",
    });
    const approved = store.update("owner-local", m.id, { status: "approved" });
    expect(approved.approved_at).toBeTruthy();

    store.update("owner-local", m.id, {
      status: "implementing",
      linkSessionId: "sess-1",
    });
    const done = store.update("owner-local", m.id, {
      status: "done",
      summary: "Shipped volume bump; marker reply_rate=watch",
      markers: { reply_rate: "watching", board: "green" },
    });
    expect(done.completed_at).toBeTruthy();
    expect(done.linked_job_ids).toContain("job-1");
    expect(done.markers.board).toBe("green");
    store.close();
  });

  it("increments plan revisions and invalidates stale approval", () => {
    const dir = mkdtempSync(join(tmpdir(), "ac-mission-revision-"));
    roots.push(dir);
    const store = new MissionStore(join(dir, "missions.db"));
    const mission = store.create({
      ownerId: "owner-local",
      title: "Ship safely",
      goal: "Use an approved plan",
    });
    const planned = store.update("owner-local", mission.id, {
      status: "plan_ready",
      plan: "1. Inspect\n2. Implement\n3. Verify",
    });
    expect(planned.plan_revision).toBe(1);
    const approved = store.update("owner-local", mission.id, {
      status: "approved",
    });
    expect(approved.approved_revision).toBe(1);

    const revised = store.update("owner-local", mission.id, {
      plan: "1. Inspect\n2. Implement narrowly\n3. Verify",
    });
    expect(revised.plan_revision).toBe(2);
    expect(revised.approved_revision).toBeNull();
    expect(revised.approved_at).toBeNull();
    expect(revised.status).toBe("plan_ready");
    store.close();
  });
});
