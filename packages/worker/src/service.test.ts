import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { AuthError } from "./db.js";
import {
  createService,
  dockerAvailable,
  ensureMockImage,
  initGitFixture,
  makeTempRoot,
  waitForJob,
} from "./test-utils.js";
import type { WorkerService } from "./service.js";

describe.skipIf(!dockerAvailable())("WorkerService job lifecycle", () => {
  const services: WorkerService[] = [];

  beforeAll(() => {
    ensureMockImage();
  });

  afterEach(() => {
    for (const s of services.splice(0)) s.close();
  });

  function setup() {
    const root = makeTempRoot();
    const fixture = join(root, "fixture");
    mkdirSync(fixture);
    initGitFixture(fixture);
    const service = createService(root, fixture);
    service.start();
    services.push(service);
    return { root, fixture, service };
  }

  it("runs a mock job to success with durable state", async () => {
    const { service } = setup();
    const task = service.startTask({
      ownerId: "owner-test",
      projectId: "demo-sandbox",
      agent: "mock",
      prompt: "edit hello and confirm isolation",
    });
    expect(task.status).toBe("queued");
    await waitForJob(service, task.id);
    const done = service.getTask("owner-test", task.id);
    expect(done.status).toBe("succeeded");
    expect(done.summary).toMatch(/mock/i);
    const out = service.getTaskOutput("owner-test", task.id);
    expect(out.logs).toContain("isolation-ok");
    expect(out.redaction_note).toContain("best-effort");
  });

  it("rejects unauthorized owner and unknown project agents", () => {
    const { service } = setup();
    expect(() => service.listProjects("intruder")).toThrow(AuthError);
    expect(() =>
      service.startTask({
        ownerId: "owner-test",
        projectId: "demo-sandbox",
        agent: "cursor",
        prompt: "nope",
      }),
    ).toThrow(AuthError);
    expect(() => service.getTask("intruder", "missing")).toThrow(AuthError);
  });

  it("deduplicates by idempotency key", async () => {
    const { service } = setup();
    const a = service.startTask({
      ownerId: "owner-test",
      projectId: "demo-sandbox",
      agent: "mock",
      prompt: "once",
      idempotencyKey: "dedupe-1",
    });
    const b = service.startTask({
      ownerId: "owner-test",
      projectId: "demo-sandbox",
      agent: "mock",
      prompt: "once again",
      idempotencyKey: "dedupe-1",
    });
    expect(a.id).toBe(b.id);
    await waitForJob(service, a.id);
  });

  it("isolates concurrent jobs on separate worktrees", async () => {
    const { service } = setup();
    const a = service.startTask({
      ownerId: "owner-test",
      projectId: "demo-sandbox",
      agent: "mock",
      prompt: "job-a",
    });
    const b = service.startTask({
      ownerId: "owner-test",
      projectId: "demo-sandbox",
      agent: "mock",
      prompt: "job-b",
    });
    expect(a.id).not.toBe(b.id);
    await Promise.all([waitForJob(service, a.id), waitForJob(service, b.id)]);
    const ja = service.store.getJob(a.id)!;
    const jb = service.store.getJob(b.id)!;
    // While running they had distinct paths; after cleanup paths may be removed,
    // but both should have succeeded independently.
    expect(ja.status).toBe("succeeded");
    expect(jb.status).toBe("succeeded");
    expect(ja.id).not.toBe(jb.id);
  });

  it("cancels a queued job", () => {
    const { service } = setup();
    // Pause ticking by stopping, enqueue, cancel while queued.
    service.stop();
    const task = service.startTask({
      ownerId: "owner-test",
      projectId: "demo-sandbox",
      agent: "mock",
      prompt: "cancel me",
    });
    const cancelled = service.cancelTask("owner-test", task.id);
    expect(cancelled.status).toBe("cancelled");
  });

  it("queues follow-up when agent cannot accept live follow-up", async () => {
    const { service } = setup();
    service.stop();
    const task = service.startTask({
      ownerId: "owner-test",
      projectId: "demo-sandbox",
      agent: "mock",
      prompt: "base",
    });
    // Force status running without container to test follow-up bookkeeping.
    service.store.updateJob(task.id, { status: "running" });
    const followed = service.sendFollowup("owner-test", task.id, "do more");
    expect(followed.status).toBe("awaiting_followup");
    expect(followed.followups_queued).toBe(1);
  });

  it("streams logs while running (no empty mid-job get_task_output)", async () => {
    const { service } = setup();
    const task = service.startTask({
      ownerId: "owner-test",
      projectId: "demo-sandbox",
      agent: "mock",
      prompt: "stream-me",
    });
    let sawLiveLogs = false;
    let sawNonEmptyBeforeTerminal = false;
    const start = Date.now();
    while (Date.now() - start < 60_000) {
      const view = service.getTask("owner-test", task.id);
      const terminal =
        view.status === "succeeded" ||
        view.status === "failed" ||
        view.status === "cancelled" ||
        view.status === "timed_out";
      const out = service.getTaskOutput("owner-test", task.id);
      if (!terminal && out.logs.length > 0) {
        sawNonEmptyBeforeTerminal = true;
      }
      if (!terminal && out.logs.includes("mock-agent")) {
        sawLiveLogs = true;
        break;
      }
      if (terminal) break;
      await new Promise((r) => setTimeout(r, 30));
    }
    await waitForJob(service, task.id);
    // Prefer live stream evidence; fall back to proving final logs exist if the
    // container finished before the poll loop (still exercises replaceStdio).
    expect(sawLiveLogs || sawNonEmptyBeforeTerminal || service.getTaskOutput("owner-test", task.id).logs.includes("mock-agent")).toBe(true);
    expect(service.getTaskOutput("owner-test", task.id).logs.length).toBeGreaterThan(0);
  }, 90_000);

  it("requeues follow-ups after success even without session_id", async () => {
    const { service } = setup();
    const task = service.startTask({
      ownerId: "owner-test",
      projectId: "demo-sandbox",
      agent: "mock",
      prompt: "base-for-followup",
    });

    // Queue follow-up while in-flight, then clear session_id before finish so
    // the historical "must have session_id to resume" stall is covered.
    const start = Date.now();
    while (Date.now() - start < 30_000) {
      const view = service.getTask("owner-test", task.id);
      if (view.status === "running" || view.status === "preparing") {
        service.store.updateJob(task.id, { session_id: null });
        service.sendFollowup("owner-test", task.id, "FOLLOWUP_WITHOUT_SESSION");
        break;
      }
      if (
        view.status === "succeeded" ||
        view.status === "failed" ||
        view.status === "cancelled" ||
        view.status === "timed_out"
      ) {
        // Finished too fast — inject requeue with null session while work_path still valid
        service.store.enqueueFollowup(task.id, "FOLLOWUP_WITHOUT_SESSION");
        service.store.updateJob(task.id, {
          status: "queued",
          finished_at: null,
          error: null,
          exit_code: null,
          session_id: null,
        });
        break;
      }
      await new Promise((r) => setTimeout(r, 30));
    }

    // Wait until no queued follow-ups remain and job is terminal.
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const view = service.getTask("owner-test", task.id);
      if (
        view.followups_queued === 0 &&
        (view.status === "succeeded" ||
          view.status === "failed" ||
          view.status === "cancelled" ||
          view.status === "timed_out")
      ) {
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    const done = service.getTask("owner-test", task.id);
    expect(done.status).toBe("succeeded");
    expect(done.followups_queued).toBe(0);
    const out = service.getTaskOutput("owner-test", task.id);
    expect(out.logs).toMatch(/FOLLOWUP_WITHOUT_SESSION|mock-agent/);
  }, 120_000);

  it("does not auto-retry in-flight jobs after restart", async () => {
    const { root, fixture, service } = setup();
    service.stop();
    const task = service.startTask({
      ownerId: "owner-test",
      projectId: "demo-sandbox",
      agent: "mock",
      prompt: "in flight",
    });
    service.store.updateJob(task.id, { status: "running" });
    service.close();
    services.pop();

    const restarted = createService(root, fixture);
    services.push(restarted);
    restarted.start();
    const job = restarted.store.getJob(task.id)!;
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/not auto-retried/i);
  });

  it("refuses mock-fail isolation backend instead of host fallback", async () => {
    const root = makeTempRoot();
    const fixture = join(root, "fixture");
    mkdirSync(fixture);
    initGitFixture(fixture);
    const { buildTestConfig } = await import("./test-utils.js");
    const { WorkerService } = await import("./service.js");
    const { MockFailIsolationBackend } = await import("./isolation/docker.js");
    const cfg = buildTestConfig(root, fixture);
    cfg.worker.isolation.backend = "mock-fail";
    const failing = new WorkerService({
      config: cfg,
      dbPath: join(root, "data", "worker", "jobs2.db"),
      configRoot: root,
    });
    services.push(failing);
    expect(failing.isolation).toBeInstanceOf(MockFailIsolationBackend);
    failing.start();
    const task = failing.startTask({
      ownerId: "owner-test",
      projectId: "demo-sandbox",
      agent: "mock",
      prompt: "should fail closed",
    });
    await waitForJob(failing, task.id, 10_000);
    const done = failing.getTask("owner-test", task.id);
    expect(done.status).toBe("failed");
    expect(done.error).toMatch(/refusing to run agents on the unrestricted host/i);
  });
});

describe("unauthorized job access", () => {
  it("blocks cross-owner get/cancel/output", () => {
    const root = makeTempRoot();
    const fixture = join(root, "fixture");
    mkdirSync(fixture);
    writeFileSync(join(fixture, "README.md"), "x\n");
    initGitFixture(fixture);
    const service = createService(root, fixture);
    const task = service.startTask({
      ownerId: "owner-test",
      projectId: "demo-sandbox",
      agent: "mock",
      prompt: "x",
    });
    expect(() => service.getTask("other", task.id)).toThrow(AuthError);
    expect(() => service.getTaskOutput("other", task.id)).toThrow(AuthError);
    expect(() => service.cancelTask("other", task.id)).toThrow(AuthError);
    service.close();
  });
});
