import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { JobRecord } from "@agent-control/shared";
import { missionAttemptKey } from "./contract.js";
import {
  createService,
  dockerAvailable,
  ensureMockImage,
  initGitFixture,
  makeTempRoot,
} from "../test-utils.js";
import { contractMarkerPayload, type MissionContract } from "./contract.js";
import { assertCanSubmitReview } from "./completion-gate.js";
import { resolveGitHead } from "./completion-gate.js";
import {
  missionSupervisorOnJobFinished,
  missionSupervisorTick,
  resetSupervisorThrottleForTests,
} from "./supervisor.js";
import type { WorkerService } from "../service.js";

const services: WorkerService[] = [];
afterEach(() => {
  for (const s of services.splice(0)) {
    try {
      s.stop();
    } catch {
      s.close();
    }
  }
});

function attachService(root: string, fixture: string): WorkerService {
  const service = createService(root, fixture);
  service.config.supervisor = { enabled: true, poll_missions_sec: 0 };
  services.push(service);
  return service;
}

function seedSucceededJob(
  service: WorkerService,
  opts: {
    idempotencyKey?: string;
    workPath?: string;
  } = {},
): string {
  const job = service.store.createJob({
    ownerId: "owner-test",
    projectId: "demo-sandbox",
    agent: "mock",
    prompt: "acceptance",
    workPath: opts.workPath,
    timeoutSec: 60,
    idempotencyKey: opts.idempotencyKey,
  });
  service.store.updateJob(job.id, {
    status: "succeeded",
    exit_code: 0,
    finished_at: new Date().toISOString(),
    work_path: opts.workPath ?? job.work_path,
  });
  return job.id;
}

describe("mission supervisor recovery (isolated acceptance)", () => {
  it("rejects ready_for_review when usability contract is unmet", () => {
    const root = makeTempRoot();
    const fixture = join(root, "fixture");
    mkdirSync(fixture, { recursive: true });
    initGitFixture(fixture);
    const service = attachService(root, fixture);
    const head = resolveGitHead(fixture)!;
    const contract: MissionContract = {
      version: 1,
      steps: [{ id: "only", title: "One", kind: "synthetic", agent: "mock", project_id: "demo-sandbox" }],
      supervision: { max_step_retries: 1, backoff_sec: 0 },
      evidence: { require_git_head: true, require_usability: true },
    };
    const impl = seedSucceededJob(service, { workPath: fixture });
    const mission = service.missions.create({
      ownerId: "owner-test",
      title: "gate",
      goal: "usability",
      markers: {
        project_active: true,
        ...contractMarkerPayload(contract),
        "step_done:only": true,
        evidence_git_head: head,
        supervisor_work_path: fixture,
        review_packet_version: 1,
      },
    });
    service.missions.update("owner-test", mission.id, {
      status: "verifying",
      linkJobId: impl,
    });
    const m = service.missions.get("owner-test", mission.id)!;
    const jobs = new Map<string, JobRecord>();
    for (const id of m.linked_job_ids) {
      const j = service.store.getJob(id);
      if (j) jobs.set(id, j);
    }
    const gate = assertCanSubmitReview(m, jobs);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.code).toBe("usability_evidence");
  });

  it("recovers a failed synthetic step without duplicate idempotency, survives service restart, and stages review with usability evidence", async () => {
    const root = makeTempRoot();
    const fixture = join(root, "fixture");
    mkdirSync(fixture, { recursive: true });
    initGitFixture(fixture);
    const head = resolveGitHead(fixture)!;

    let service = attachService(root, fixture);

    const contract: MissionContract = {
      version: 1,
      steps: [
        { id: "s1", title: "stage one", kind: "synthetic", agent: "mock", project_id: "demo-sandbox" },
        { id: "s2", title: "stage two", kind: "synthetic", agent: "mock", project_id: "demo-sandbox" },
      ],
      supervision: { max_step_retries: 2, backoff_sec: 0 },
      evidence: { require_git_head: true, require_usability: true },
    };

    const mission = service.missions.create({
      ownerId: "owner-test",
      title: "recovery acceptance",
      goal: "no-chat bounded recovery",
      markers: {
        project_active: true,
        ...contractMarkerPayload(contract),
        approved_contract_version: 1,
        plan_approved: true,
      },
    });
    service.missions.update("owner-test", mission.id, { plan: "Run the bounded recovery contract." });
    service.missions.update("owner-test", mission.id, {
      status: "approved", markers: { supervision_state: "idle", approval_policy: "hybrid_remote", approval_source: "chat_explicit" },
    });

    resetSupervisorThrottleForTests();
    missionSupervisorTick(service);
    const afterTick = service.missions.get("owner-test", mission.id)!;
    const job1 = String(afterTick.markers.supervisor_last_job_id);
    expect(job1).toBeTruthy();
    const key1 = service.store.getJob(job1)?.idempotency_key;
    expect(key1).toMatch(/:attempt:1$/);

    service.store.updateJob(job1, {
      status: "failed",
      error: "synthetic fixture failure",
      finished_at: new Date().toISOString(),
    });
    missionSupervisorOnJobFinished(service, job1, "failed");
    expect(service.missions.get("owner-test", mission.id)!.markers.supervision_state).toBe(
      "recovering",
    );

    resetSupervisorThrottleForTests();
    missionSupervisorTick(service);
    const job2 = String(
      service.missions.get("owner-test", mission.id)!.markers.supervisor_last_job_id,
    );
    expect(job2).not.toBe(job1);
    const key2 = service.store.getJob(job2)?.idempotency_key;
    expect(key2).toMatch(/:attempt:2$/);

    service.store.updateJob(job2, {
      status: "succeeded",
      exit_code: 0,
      work_path: fixture,
      finished_at: new Date().toISOString(),
    });
    missionSupervisorOnJobFinished(service, job2, "succeeded");
    expect(service.missions.get("owner-test", mission.id)!.markers["step_done:s1"]).toBe(true);

    resetSupervisorThrottleForTests();
    missionSupervisorTick(service);
    const job3 = String(
      service.missions.get("owner-test", mission.id)!.markers.supervisor_last_job_id,
    );
    service.store.updateJob(job3, {
      status: "succeeded",
      exit_code: 0,
      work_path: fixture,
      finished_at: new Date().toISOString(),
    });
    missionSupervisorOnJobFinished(service, job3, "succeeded");
    const mid = service.missions.get("owner-test", mission.id)!;
    expect(mid.status).toBe("verifying");
    expect(mid.markers["step_done:s2"]).toBe(true);
    expect(resolveGitHead(fixture)).toBe(head);

    service.close();
    service = attachService(root, fixture);

    const desktop = seedSucceededJob(service, { workPath: fixture });
    const mobile = seedSucceededJob(service, { workPath: fixture });
    service.missions.update("owner-test", mission.id, {
      linkJobId: desktop,
    });
    service.missions.update("owner-test", mission.id, {
      linkJobId: mobile,
      markers: {
        qa_job_desktop: desktop,
        qa_job_mobile: mobile,
        supervisor_work_path: fixture,
        evidence_git_head: head,
        review_packet_version: 1,
      },
    });

    const review = await service.submitMissionReview("owner-test", mission.id, {
      summary: "isolated acceptance: supervisor recovery + usability gates",
      notify: false,
    });
    expect(review.blocked).toBe(false);
    expect(review.mission.status).toBe("ready_for_review");
    expect(key1).toBe(missionAttemptKey(mission.id, "s1", 1));
    expect(key2).toBe(missionAttemptKey(mission.id, "s1", 2));
  });

  it.skipIf(!dockerAvailable())(
    "docker: full worker tick advances synthetic steps without chat",
    async () => {
      ensureMockImage();
      const root = makeTempRoot();
      const fixture = join(root, "fixture");
      mkdirSync(fixture, { recursive: true });
      initGitFixture(fixture);
      const service = attachService(root, fixture);
      service.start();
      resetSupervisorThrottleForTests();

      const contract: MissionContract = {
        version: 1,
        steps: [
          {
            id: "d1",
            title: "docker one",
            kind: "synthetic",
            agent: "mock",
            project_id: "demo-sandbox",
          },
        ],
        supervision: { max_step_retries: 1, backoff_sec: 0 },
        evidence: { require_git_head: false, require_usability: false },
      };

      const mission = service.missions.create({
        ownerId: "owner-test",
        title: "docker tick",
        goal: "e2e",
        markers: {
          project_active: true,
          ...contractMarkerPayload(contract),
        },
      });
      service.missions.update("owner-test", mission.id, { status: "approved", markers: { approval_policy: "hybrid_remote", approval_source: "chat_explicit", plan_approved: true } });

      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        const m = service.missions.get("owner-test", mission.id)!;
        if (m.markers["step_done:d1"] === true) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(service.missions.get("owner-test", mission.id)!.markers["step_done:d1"]).toBe(
        true,
      );
      service.stop();
    },
    120_000,
  );
});
