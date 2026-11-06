import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthError } from "./db.js";
import {
  createService,
  initGitFixture,
  makeTempRoot,
  waitForJob,
} from "./test-utils.js";
import type { WorkerService } from "./service.js";

describe("Advisor mission gate", () => {
  const services: WorkerService[] = [];
  afterEach(() => {
    for (const service of services.splice(0)) service.close();
  });

  function setup() {
    const root = makeTempRoot();
    const fixture = join(root, "workspace");
    mkdirSync(fixture);
    initGitFixture(fixture);
    const service = createService(root, fixture);
    service.config.advisor = { enabled: true };
    service.config.worker.agent_execution = "host";
    service.config.agents.cursor = {
      enabled: true,
      adapter: "cursor",
      binary: "/usr/bin/true",
      usage: { min_gap_sec: 0 },
    };
    services.push(service);
    return { fixture, service };
  }

  it("requires the current plan revision and permits FIFO enqueue", async () => {
    const { fixture, service } = setup();
    const mission = service.createMission({
      ownerId: "owner-test",
      title: "Focused change",
      goal: "Make one approved change",
      workspace: fixture,
    });

    expect(() =>
      service.startTask({
        ownerId: "owner-test",
        agent: "cursor",
        workspace: fixture,
        prompt: "implement",
        tier: "implement",
      }),
    ).toThrow(/requires mission_id/i);

    const planned = await service.submitMissionPlan(
      "owner-test",
      mission.id,
      { plan: "1. Inspect\n2. Implement\n3. Verify", notify: false },
    );
    expect(planned.plan_revision).toBe(1);
    expect(() =>
      service.startTask({
        ownerId: "owner-test",
        agent: "cursor",
        workspace: fixture,
        prompt: "implement",
        tier: "implement",
        missionId: mission.id,
      }),
    ).toThrow(/not approved/i);

    await service.approveMission("owner-test", mission.id, {
      authorization: "chat_explicit",
    });
    const first = service.startTask({
      ownerId: "owner-test",
      agent: "cursor",
      workspace: fixture,
      prompt: "implement step one",
      tier: "implement",
      missionId: mission.id,
    });
    const second = service.startTask({
      ownerId: "owner-test",
      agent: "cursor",
      workspace: fixture,
      prompt: "implement step two",
      tier: "implement",
      missionId: mission.id,
    });
    expect(first.status).toBe("queued");
    expect(second.status).toBe("queued");
    expect(service.store.listQueued().map((job) => job.id)).toEqual([
      first.id,
      second.id,
    ]);
    expect(service.store.getJob(first.id)?.prompt).toContain(
      "[Ground Control mission packet]",
    );
    expect(service.getMission("owner-test", mission.id).linked_job_ids).toEqual([
      first.id,
      second.id,
    ]);

    service.start();
    await waitForJob(service, first.id);
    await waitForJob(service, second.id);
    const firstDone = service.getTask("owner-test", first.id);
    const secondDone = service.getTask("owner-test", second.id);
    expect({
      first: firstDone.status,
      firstError: firstDone.error,
      second: secondDone.status,
      secondError: secondDone.error,
    }).toEqual({
      first: "succeeded",
      firstError: null,
      second: "succeeded",
      secondError: null,
    });
    expect(Date.parse(secondDone.started_at!)).toBeGreaterThanOrEqual(
      Date.parse(firstDone.finished_at!),
    );
    const completedMission = service.getMission("owner-test", mission.id);
    expect(completedMission.status).toBe("verifying");
    expect(completedMission.handoff).toMatchObject({
      job_id: second.id,
      agent: "cursor",
      status: "succeeded",
    });
  });

  it("rejects direct approval and invalidates approval after revision", async () => {
    const { fixture, service } = setup();
    const mission = service.createMission({
      ownerId: "owner-test",
      title: "Revise safely",
      goal: "Require fresh consent",
      workspace: fixture,
    });
    await service.submitMissionPlan("owner-test", mission.id, {
      plan: "Initial plan",
      notify: false,
    });
    expect(() =>
      service.updateMission("owner-test", mission.id, { status: "approved" }),
    ).toThrow(AuthError);
    await service.approveMission("owner-test", mission.id, {
      authorization: "chat_explicit",
    });
    const revised = await service.submitMissionPlan("owner-test", mission.id, {
      plan: "Revised plan",
      notify: false,
    });
    expect(revised.approved_revision).toBeNull();
    expect(revised.status).toBe("plan_ready");
  });

  it("blocks the mission and holds later work when an agent cannot start", async () => {
    const { fixture, service } = setup();
    service.config.agents.cursor!.binary = join(fixture, "missing-cursor");
    const mission = service.createMission({
      ownerId: "owner-test",
      title: "Fail safely",
      goal: "Do not cascade after a launch failure",
      workspace: fixture,
    });
    await service.submitMissionPlan("owner-test", mission.id, {
      plan: "Run the approved change",
      notify: false,
    });
    await service.approveMission("owner-test", mission.id, {
      authorization: "chat_explicit",
    });
    const first = service.startTask({
      ownerId: "owner-test",
      agent: "cursor",
      workspace: fixture,
      prompt: "first",
      tier: "implement",
      missionId: mission.id,
    });
    const second = service.startTask({
      ownerId: "owner-test",
      agent: "cursor",
      workspace: fixture,
      prompt: "second",
      tier: "implement",
      missionId: mission.id,
    });

    service.start();
    await waitForJob(service, first.id);

    expect(service.getTask("owner-test", first.id).status).toBe("failed");
    expect(service.getTask("owner-test", second.id).status).toBe("queued");
    expect(service.getMission("owner-test", mission.id)).toMatchObject({
      status: "blocked",
      handoff: { job_id: first.id, status: "failed" },
    });
  });
});
