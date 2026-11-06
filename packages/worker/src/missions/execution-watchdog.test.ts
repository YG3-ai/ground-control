import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createService, initGitFixture, makeTempRoot } from "../test-utils.js";
import { contractMarkerPayload, type MissionContract } from "./contract.js";
import { enforceMissionExecutionWatchdog } from "./execution-watchdog.js";
import { missionSupervisorTick, resetSupervisorThrottleForTests } from "./supervisor.js";

const services: ReturnType<typeof createService>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  resetSupervisorThrottleForTests();
  for (const service of services.splice(0)) service.close();
});

function setup() {
  const root = makeTempRoot();
  const fixture = join(root, "fixture");
  mkdirSync(fixture, { recursive: true });
  initGitFixture(fixture);
  const service = createService(root, fixture);
  services.push(service);
  service.config.supervisor = { enabled: true, poll_missions_sec: 0, job_stale_sec: 30, connection_retry_limit: 3 };
  const contract: MissionContract = {
    version: 1,
    steps: [{ id: "implement", title: "Implement", kind: "implement", agent: "cursor", prompt: "x" }],
    supervision: { max_step_retries: 1, backoff_sec: 0 },
    evidence: { require_git_head: false, require_usability: false },
  };
  const mission = service.missions.create({
    ownerId: "owner-test", title: "Watchdog", goal: "g",
    markers: { project_active: true, ...contractMarkerPayload(contract), current_step_id: "implement", supervision_state: "running", "step_attempt:implement": 1 },
  });
  service.missions.update("owner-test", mission.id, { plan: "Implement the approved change." });
  service.missions.update("owner-test", mission.id, { status: "approved", markers: { approval_policy: "hybrid_remote", approval_source: "chat_explicit", plan_approved: true } });
  service.missions.update("owner-test", mission.id, { status: "implementing" });
  const job = service.store.createJob({
    ownerId: "owner-test", projectId: "demo-sandbox", agent: "mock", prompt: "x", workPath: fixture,
    timeoutSec: 60, idempotencyKey: "mission:" + mission.id + ":step:implement:attempt:1",
  });
  service.store.updateJob(job.id, { status: "running" });
  service.missions.update("owner-test", mission.id, { linkJobId: job.id, markers: { supervisor_last_job_id: job.id } });
  return { service, missionId: mission.id, jobId: job.id };
}

describe("mission execution watchdog", () => {
  it("stops repeated connection retries", () => {
    const { service, missionId, jobId } = setup();
    service.store.appendLogs(jobId, { stderr: "connection retry\\nretrying connection\\nconnection lost" });
    const cancel = vi.spyOn(service, "cancelTask");
    const mission = service.missions.get("owner-test", missionId)!;
    expect(enforceMissionExecutionWatchdog(service, mission)).toBe(true);
    const after = service.missions.get("owner-test", missionId)!;
    expect(cancel).toHaveBeenCalledWith("owner-test", jobId);
    expect(after.status).toBe("blocked");
    expect(String(after.markers.block_reason)).toContain("watchdog_connection_retry");
  });

  it("stops a running job with no fresh output inside the configured bound", () => {
    const { service, missionId, jobId } = setup();
    service.store.db.prepare("UPDATE jobs SET updated_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 31_000).toISOString(), jobId);
    const mission = service.missions.get("owner-test", missionId)!;
    expect(enforceMissionExecutionWatchdog(service, mission)).toBe(true);
    expect(String(service.missions.get("owner-test", missionId)!.markers.block_reason))
      .toContain("watchdog_stale_output");
  });

  it("reconciles a prior success without dispatching it again", async () => {
    const { service, missionId, jobId } = setup();
    service.store.updateJob(jobId, { status: "succeeded" });
    const dispatch = vi.spyOn(service, "startTask").mockReturnValue({ id: "fallback-job" } as never);
    await missionSupervisorTick(service);
    expect(dispatch).not.toHaveBeenCalled();
    expect(service.missions.get("owner-test", missionId)!.markers["step_done:implement"]).toBe(true);
  });
});

it("keeps budget-waiting queued work outside the output watchdog", () => {
 const {service, missionId, jobId} = setup();
 service.store.updateJob(jobId, {status: "queued"});
 service.store.db.prepare("UPDATE jobs SET updated_at = ? WHERE id = ?").run(new Date(Date.now()-60000).toISOString(),jobId);
 expect(enforceMissionExecutionWatchdog(service, service.missions.get("owner-test",missionId)!)).toBe(false);
});
it("resets historical retries after progress and ignores quoted source", () => {
 const {service,missionId,jobId} = setup();
 service.store.appendLogs(jobId,{stderr:"connection retry\nretrying connection\n"});
 service.store.appendLogs(jobId,{stdout:JSON.stringify({type:"item.completed",item:{type:"command_execution",aggregated_output:"connection retry connection lost reconnecting"}})+"\n"});
 service.store.appendLogs(jobId,{stderr:"connection lost\n"});
 expect(enforceMissionExecutionWatchdog(service,service.missions.get("owner-test",missionId)!)).toBe(false);
});
it("routes a pending step to an enabled fallback and retains its mission", async () => {
 const {service,missionId,jobId} = setup();
 service.store.updateJob(jobId,{status:"succeeded"});
 const mission=service.missions.get("owner-test",missionId)!;
 const contract=JSON.parse(String(mission.markers.mission_contract_json));
 contract.version=2;
 contract.steps.push({id:"fallback",title:"Next approved step",kind:"implement",agent:"cursor",prompt:"Continue"});
 service.missions.update("owner-test",missionId,{markers:{...contractMarkerPayload(contract),approved_contract_version:2,"step_done:implement":true,current_step_id:"fallback",supervisor_last_job_id:null,supervision_state:"idle"}});
 service.config.agents.cursor.enabled=false;
 service.config.agents.codex.enabled=true;
 const dispatch=vi.spyOn(service,"startTask").mockReturnValue({id:"fallback-job"} as never);
 await missionSupervisorTick(service);
 expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({agent:"codex",missionId}));
 expect(service.missions.get("owner-test",missionId)!.linked_job_ids).toContain("fallback-job");
});
