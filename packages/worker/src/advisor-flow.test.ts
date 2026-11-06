import { contractMarkerPayload } from "./missions/contract.js";
import { missionSupervisorTick, resetSupervisorThrottleForTests } from "./missions/supervisor.js";
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
  it("carries a real managed job through acceptance and review with one usage start", async () => {
    const {fixture,service}=setup();
    service.config.advisor={enabled:true,poll_missions_sec:0};
    const contract={version:1,steps:[
      {id:"implement",title:"Implement fixture",kind:"implement",agent:"cursor",prompt:"Run the approved fixture"},
      {id:"verify",title:"Check fixture",kind:"verify",acceptance_test_id:"fixture",acceptance_command:"node -e 'process.exit(0)'"}],
      supervision:{max_step_retries:0,backoff_sec:0},evidence:{require_git_head:false,require_usability:false}};
    const mission=service.createMission({ownerId:"owner-test",title:"Advisor acceptance",goal:"Prove the full flow",workspace:fixture,
      markers:{project_active:true,...contractMarkerPayload(contract as never)}});
    await service.submitMissionPlan("owner-test",mission.id,{plan:"Run fixture, verify and stage review.",notify:false});
    await service.approveMission("owner-test",mission.id,{authorization:"chat_explicit"});
    resetSupervisorThrottleForTests();
    await missionSupervisorTick(service);
    const jobId=service.getMission("owner-test",mission.id).linked_job_ids[0]!;
    expect(jobId).toBeTruthy();
    service.start();
    await waitForJob(service,jobId);
    expect(service.getTask("owner-test",jobId).status).toBe("succeeded");
    expect(service.store.getJob(jobId)?.mission_id).toBe(mission.id);
    expect(service.usage.db.prepare("SELECT count(*) AS n FROM usage_events WHERE job_id=? AND kind='start'").get(jobId)).toMatchObject({n:1});
    await missionSupervisorTick(service);
    const review=await service.submitMissionReview("owner-test",mission.id,{summary:"Fixture passed.",review_packet_version:1,notify:false});
    expect(review.blocked).toBe(false);
    expect(service.getMission("owner-test",mission.id).status).toBe("ready_for_review");
    expect(service.getMission("owner-test",mission.id).handoff?.job_id).toBe(jobId);
  });
  it("allows mission-linked research before plan approval", async () => {
    const {fixture,service}=setup();
    const m=service.createMission({ownerId:"owner-test",title:"Research",goal:"Inspect",workspace:fixture});
    const job=service.startTask({ownerId:"owner-test",agent:"cursor",missionId:m.id,workspace:fixture,prompt:"Inspect only",tier:"research"});
    service.start();
    await waitForJob(service,job.id);
    expect(service.getTask("owner-test",job.id).status).toBe("succeeded");
  });
  it("preserves cancellation when a late successful callback arrives", async () => {
    const {fixture,service}=setup();
    const m=service.createMission({ownerId:"owner-test",title:"Stopped",goal:"Respect stop",workspace:fixture});
    await service.submitMissionPlan("owner-test",m.id,{plan:"Run fixture.",notify:false});
    await service.approveMission("owner-test",m.id,{authorization:"chat_explicit"});
    const job=service.startTask({ownerId:"owner-test",agent:"cursor",missionId:m.id,workspace:fixture,prompt:"Run",tier:"implement"});
    service.missions.update("owner-test",m.id,{status:"cancelled"});
    (service as any).finishJob(job.id,{}, {stdout:"",stderr:"",exitCode:0,killed:false,timedOut:false},"live",fixture);
    expect(service.getMission("owner-test",m.id).status).toBe("cancelled");
  });

});
