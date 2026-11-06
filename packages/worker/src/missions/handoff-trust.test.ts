import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createService, initGitFixture, makeTempRoot } from "../test-utils.js";
import type { WorkerService } from "../service.js";
import { contractMarkerPayload, missionAttemptKey, type MissionContract } from "./contract.js";
import { buildStepPrompt, missionSupervisorTick, missionSupervisorOnJobFinished,
  resetSupervisorThrottleForTests } from "./supervisor.js";
import { assertCanComplete } from "./completion-gate.js";

const services: WorkerService[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const s of services.splice(0)) s.close();
  resetSupervisorThrottleForTests();
});
function setup(kind: "synthetic" | "implement" = "synthetic") {
  const root = makeTempRoot(), fixture = join(root, "fixture");
  mkdirSync(fixture, { recursive: true });
  initGitFixture(fixture);
  const service = createService(root, fixture);
  service.config.supervisor = { enabled: true, poll_missions_sec: 0 };
  services.push(service);
  const contract: MissionContract = {
    version: 1,
    steps: [
      { id: "one", title: "First", kind, agent: kind === "synthetic" ? "mock" : "cursor",
        prompt: "Improve the draft", project_id: "demo-sandbox" },
      { id: "two", title: "Verify", kind: "synthetic", agent: "mock", project_id: "demo-sandbox" },
    ],
    supervision: { max_step_retries: 2, backoff_sec: 0 },
    evidence: { require_git_head: false, require_usability: false },
  };
  const m = service.missions.create({
    ownerId: "owner-test", title: "OM output quality", goal: "Compare with earlier posts",
    markers: { ...contractMarkerPayload(contract), project_active: true,
      approved_contract_version: 1, plan_approved: true, current_step_id: "one",
      "step_attempt:one": 1, supervision_state: "running", review_packet_version: 1 },
  });
  // A plan mutation invalidates approval, so establish the revision before
  // recording its approval (the legacy fixture did both in one update).
  service.missions.update("owner-test", m.id, {
    plan: "Keep autocompose OFF. Do not publish.",
  });
  service.missions.update("owner-test", m.id, { status: "approved", markers: { approval_policy: "hybrid_remote", approval_source: "chat_explicit", plan_approved: true } });
  service.missions.update("owner-test", m.id, { status: "implementing" });
  const job = service.store.createJob({
    ownerId: "owner-test", projectId: "demo-sandbox", agent: "mock", prompt: "fixture",
    timeoutSec: 60, workPath: fixture,
    idempotencyKey: missionAttemptKey(m.id, "one", 1),
  });
  service.missions.update("owner-test", m.id, {
    linkJobId: job.id, markers: { supervisor_last_job_id: job.id },
  });
  const get = () => service.missions.get("owner-test", m.id)!;
  const dispatch = vi.spyOn(service, "startTask");
  return { service, job, get, dispatch, contract };
}

describe("handoff trust", () => {
  it("reports the running service configuration rather than relying on old mission notes", () => {
    const { service } = setup();
    expect(service.getSituation("owner-test").supervisor).toEqual({
      enabled: true, poll_missions_sec: 0, queue_max_concurrent: 1,
    });
  });
  it("carries outcome, constraints, custom instructions and latest handoff together", () => {
    const { get, contract } = setup();
    const p = buildStepPrompt(get(), contract.steps[0], "Earlier draft repeated its title");
    for (const text of ["Compare with earlier posts", "Keep autocompose OFF",
      "Do not publish", "Improve the draft", "Earlier draft repeated its title"]) {
      expect(p).toContain(text);
    }
  });
  it.each([true, false])("never retries cancellation (callback delivered=%s)", callback => {
    const { service, job, get, dispatch } = setup();
    service.store.updateJob(job.id, { status: "cancelled" });
    if (callback) missionSupervisorOnJobFinished(service, job.id, "cancelled");
    missionSupervisorTick(service);
    expect(get().status).toBe("blocked");
    expect(get().markers.block_reason).toContain("explicit resume");
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("does not revive a cancelled mission on late success", () => {
    const { service, job, get } = setup();
    service.missions.update("owner-test", get().id, { status: "cancelled" });
    missionSupervisorOnJobFinished(service, job.id, "succeeded");
    expect(get().status).toBe("cancelled");
    expect(get().markers["step_done:one"]).not.toBe(true);
  });
  it("honors a pause over callbacks and ticks", () => {
    const { service, job, get, dispatch } = setup();
    service.missions.update("owner-test", get().id, { markers: { supervision_state: "paused" } });
    service.store.updateJob(job.id, { status: "succeeded" });
    missionSupervisorOnJobFinished(service, job.id, "succeeded");
    missionSupervisorTick(service);
    expect(get().markers.supervision_state).toBe("paused");
    expect(get().markers["step_done:one"]).not.toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("ignores a delayed callback from an earlier attempt", () => {
    const { service, job, get } = setup();
    service.missions.update("owner-test", get().id, { markers: { "step_attempt:one": 2 } });
    missionSupervisorOnJobFinished(service, job.id, "succeeded");
    expect(get().markers["step_done:one"]).not.toBe(true);
  });
  it("does not start another step while cancellation is in progress", () => {
    const { service, job, dispatch } = setup();
    service.store.updateJob(job.id, { status: "cancelling" });
    missionSupervisorTick(service);
    expect(dispatch).not.toHaveBeenCalled();
  });
  it.each([true, false])("does not replay uncertain real work (callback delivered=%s)", callback => {
    const { service, job, get, dispatch } = setup("implement");
    service.store.updateJob(job.id, { status: "failed", error: "worker restarted after work began" });
    if (callback) missionSupervisorOnJobFinished(service, job.id, "failed");
    missionSupervisorTick(service);
    expect(get().status).toBe("blocked");
    expect(get().markers.block_reason).toContain("reconciliation");
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("reconciles successful work after a missed callback without executing again", () => {
    const { service, job, get, dispatch } = setup();
    service.store.updateJob(job.id, { status: "succeeded" });
    missionSupervisorTick(service);
    expect(get().markers["step_done:one"]).toBe(true);
    expect(get().markers.current_step_id).toBe("two");
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("stops contract version drift before dispatch", () => {
    const { service, job, get, dispatch } = setup();
    service.store.updateJob(job.id, { status: "failed" });
    service.missions.update("owner-test", get().id, { markers: { approved_contract_version: 2 } });
    missionSupervisorTick(service);
    expect(get().markers.block_reason).toContain("contract changed");
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("does not substitute mock success for a real implementation with no agent", () => {
    const { service, job, get, dispatch, contract } = setup("implement");
    contract.steps[0].agent = undefined;
    service.store.updateJob(job.id, { status: "succeeded" });
    service.missions.update("owner-test", get().id, { markers: {
      ...contractMarkerPayload(contract), supervisor_last_job_id: null,
    } });
    missionSupervisorTick(service);
    expect(get().markers.block_reason).toContain("explicit execution agent");
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("allows completion after review and owner release with valid evidence", () => {
    const { service, job, get } = setup();
    service.store.updateJob(job.id, { status: "succeeded" });
    service.missions.update("owner-test", get().id, {
      status: "ready_for_review", markers: { "step_done:one": true, "step_done:two": true },
    });
    expect(assertCanComplete(get(), new Map([[job.id, service.store.getJob(job.id)!]]),
      { ownerReleaseAuthorized: true })).toEqual({ ok: true });
  });
  it("continues to reject incomplete evidence after owner release", () => {
    const { service, job, get } = setup();
    service.store.updateJob(job.id, { status: "succeeded" });
    service.missions.update("owner-test", get().id, { status: "ready_for_review" });
    expect(assertCanComplete(get(), new Map([[job.id, service.store.getJob(job.id)!]]),
      { ownerReleaseAuthorized: true })).toMatchObject({ ok: false, code: "steps_incomplete" });
  });
});

describe("normal pacing is a wait", () => {
  it("waits until the deadline, then dispatches without consuming a failed attempt", () => {
    const { service, job, get, dispatch } = setup();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    service.store.updateJob(job.id, { status: "succeeded" });
    missionSupervisorOnJobFinished(service, job.id, "succeeded");
    dispatch.mockImplementationOnce(() => {
      throw new Error("usage budget: cursor min_gap_sec=45 not met (39s left) (retry_after_sec=39)");
    }).mockImplementationOnce(input => {
      const next = service.store.createJob({
        ownerId: "owner-test", projectId: "demo-sandbox", agent: "mock",
        prompt: input.prompt, timeoutSec: 60, idempotencyKey: input.idempotencyKey,
      });
      return { id: next.id } as never;
    });
    missionSupervisorTick(service);
    expect(get().status).toBe("implementing");
    expect(get().markers.supervision_state).toBe("waiting");
    expect(get().markers.block_reason).toBeNull();
    expect(get().markers["step_attempt:two"]).toBeUndefined();
    expect(Date.parse(String(get().markers.supervision_next_run_at))).toBe(now + 39_000);
    clock.mockReturnValue(now + 38_000);
    missionSupervisorTick(service);
    expect(dispatch).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(now + 39_000);
    missionSupervisorTick(service);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(get().markers.supervision_state).toBe("running");
    expect(get().markers["step_attempt:two"]).toBe(1);
    expect(get().markers.supervision_next_run_at).toBeNull();
    expect(get().linked_job_ids).toHaveLength(2);
  });

  it("retains the pacing deadline across a service reconstruction", () => {
    const { service, job, get, dispatch } = setup();
    service.store.updateJob(job.id, { status: "succeeded" });
    missionSupervisorOnJobFinished(service, job.id, "succeeded");
    dispatch.mockImplementation(() => {
      throw new Error("usage budget: cooldown (retry_after_sec=60)");
    });
    missionSupervisorTick(service);
    const id = get().id;
    const deadline = get().markers.supervision_next_run_at;
    const root = service.configRoot;
    const fixture = service.config.projects[0].source_path;
    service.close();
    services.splice(services.indexOf(service), 1);
    const resumed = createService(root, fixture);
    resumed.config.supervisor = { enabled: true, poll_missions_sec: 0 };
    services.push(resumed);
    const start = vi.spyOn(resumed, "startTask");
    resetSupervisorThrottleForTests();
    missionSupervisorTick(resumed);
    expect(resumed.missions.get("owner-test", id)!.markers.supervision_next_run_at).toBe(deadline);
    expect(start).not.toHaveBeenCalled();
  });

  it("surfaces an actual dispatch failure as blocked instead of hiding it in implementing", () => {
    const { service, job, get, dispatch } = setup();
    service.store.updateJob(job.id, { status: "succeeded" });
    missionSupervisorOnJobFinished(service, job.id, "succeeded");
    dispatch.mockImplementation(() => { throw new Error("Authentication required"); });
    missionSupervisorTick(service);
    expect(get().status).toBe("blocked");
    expect(get().markers.block_reason).toContain("Authentication required");
  });
});
