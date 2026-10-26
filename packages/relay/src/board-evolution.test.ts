import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  RelayClient,
  WorkerService,
  initGitFixture,
  makeTempRoot,
  buildTestConfig,
} from "@agent-control/worker";
import { startRelay } from "./server.js";
import type { RelayConfig } from "./config.js";

const port = 28789;
const boardKey = "evolution-board-secret-test";
const ownerId = "owner-test";

function seedMeaning(service: WorkerService): string {
  for (let i = 1; i <= 3; i++) {
    const d = String(i).padStart(2, "0");
    const missionId = `evo-m-${i}`;
    const jobId = `evo-j-${i}`;
    service.events.emit({
      source: "missions",
      sourceRef: missionId,
      actor: "owner",
      verb: "mission.created",
      objectType: "mission",
      objectId: missionId,
      toState: "intake",
      occurredAt: `2026-10-${d}T09:00:00.000Z`,
      evidenceRefs: [`mission:${missionId}`],
      sensitivity: "internal",
      dedupeKey: `evo-seed-created-${i}`,
    });
    service.events.emit({
      source: "jobs",
      sourceRef: jobId,
      actor: "agent:kimi",
      verb: "job.status_changed",
      objectType: "job",
      objectId: jobId,
      fromState: "running",
      toState: "succeeded",
      occurredAt: `2026-10-${d}T11:00:00.000Z`,
      evidenceRefs: [`job:${jobId}`],
      sensitivity: "private",
      dedupeKey: `evo-seed-job-${i}`,
    });
    service.events.emit({
      source: "missions",
      sourceRef: missionId,
      actor: "owner",
      verb: "mission.status_changed",
      objectType: "mission",
      objectId: missionId,
      fromState: "implementing",
      toState: "done",
      occurredAt: `2026-10-${d}T12:00:00.000Z`,
      evidenceRefs: [`mission:${missionId}`, `job:${jobId}`],
      sensitivity: "internal",
      dedupeKey: `evo-seed-done-${i}`,
    });
  }
  service.rebuildMeaning(ownerId);
  const listed = service.listMeaningCandidates(ownerId, { includePrivate: true });
  const cap = listed.candidates.find((c) => c.rule_id === "reliable_delivery");
  if (!cap) throw new Error("expected reliable_delivery candidate in test data");
  return cap.candidate_id;
}

describe("board evolution UI source", () => {
  it("lists candidates from API shape and keeps overflow guard", () => {
    const html = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "board.html"),
      "utf8",
    );
    expect(html).toContain("evoList.candidates");
    expect(html).not.toContain("evoList.items");
    expect(html).toMatch(/overflow-x:\s*hidden/);
    expect(html).toContain('min-height:44px');
    expect(html).toContain("evidenceRowView");
    expect(html).toContain("evoEntityCtx");
    expect(html).toContain("resolveEvoEntityContexts");
  });
});

describe("board evolution (owner-only meaning UI API)", () => {
  const root = makeTempRoot();
  const fixture = join(root, "fixture");
  let relay: Awaited<ReturnType<typeof startRelay>>;
  let service: WorkerService;
  let client: RelayClient;
  let candidateId: string;

  const base = `http://127.0.0.1:${port}`;
  const headers = { "x-ground-board-key": boardKey };

  beforeAll(async () => {
    mkdirSync(fixture);
    initGitFixture(fixture);

    const cfg: RelayConfig = {
      host: "127.0.0.1",
      port,
      publicBaseUrl: `http://127.0.0.1:${port}`,
      jwtSecret: "test-jwt-secret-at-least-32-chars-long!!",
      workerToken: "test-worker-token-at-least-24c",
      ownerId,
      ownerApprovalSecret: "approval-secret-test",
      boardViewSecret: boardKey,
      boardPublicReadOnly: true,
      boardUnlockPasswordHash: null,
      allowDevToken: false,
      dataDir: join(root, "relay-data"),
      publicRepoUrl: "https://github.com/YG3-ai/ground-control",
      publicDonationUrl: null,
    };
    relay = await startRelay(cfg);

    const workerCfg = buildTestConfig(root, fixture);
    workerCfg.owner.id = ownerId;
    workerCfg.relay.url = `ws://127.0.0.1:${port}/worker`;
    service = new WorkerService({
      config: workerCfg,
      dbPath: join(root, "data", "worker", "jobs.db"),
      configRoot: root,
    });
    service.start();
    client = new RelayClient(workerCfg.relay.url, cfg.workerToken, service);
    client.start();

    const start = Date.now();
    while (!relay.hub.connected && Date.now() - start < 10_000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(relay.hub.connected).toBe(true);
    candidateId = seedMeaning(service);
  }, 60_000);

  afterAll(async () => {
    client?.stop();
    service?.close();
    await relay?.close();
  });

  it("anonymous and public read audiences get 401 with no meaning payload", async () => {
    const paths = [
      "/api/board/evolution/summary",
      "/api/board/evolution/candidates",
      `/api/board/evolution/candidates/${candidateId}`,
    ];
    for (const path of paths) {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(401);
      const text = await res.text();
      expect(text).not.toMatch(/reliable_delivery/);
      expect(text).not.toMatch(/candidate_id/);
      expect(text).not.toMatch(/proposed_label/);
      expect(JSON.parse(text)).toEqual({ error: "unauthorized" });
    }

    const post = await fetch(`${base}/api/board/evolution/candidates/${candidateId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "accept" }),
    });
    expect(post.status).toBe(401);
    expect(await post.json()).toEqual({ error: "unauthorized" });
  });

  it("public read-only GET /api/board still works without evolution leakage", async () => {
    const board = await fetch(`${base}/api/board`);
    expect(board.status).toBe(200);
    const text = await board.text();
    expect(text).not.toMatch(/reliable_delivery/);
    expect(text).not.toMatch(candidateId);
  });

  it("owner reads summary, list, and detail with private evidence", async () => {
    const summary = await fetch(`${base}/api/board/evolution/summary`, { headers });
    expect(summary.status).toBe(200);
    const sumBody = (await summary.json()) as {
      candidates_total: number;
      by_rule_id: Record<string, number>;
    };
    expect(sumBody.candidates_total).toBeGreaterThan(0);
    expect(sumBody.by_rule_id.reliable_delivery).toBe(1);

    const list = await fetch(`${base}/api/board/evolution/candidates`, { headers });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { candidates: { candidate_id: string }[] };
    expect(listBody.candidates.some((c) => c.candidate_id === candidateId)).toBe(true);

    const detail = await fetch(
      `${base}/api/board/evolution/candidates/${candidateId}`,
      { headers },
    );
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as {
      candidate: { status: string };
      evidence: {
        verb: string;
        event_id: string;
        source_ref?: string;
        object_id?: string | null;
      }[];
      rule: { explanation: string };
    };
    expect(detailBody.candidate.status).toBe("proposed");
    expect(detailBody.rule.explanation.length).toBeGreaterThan(10);
    expect(detailBody.evidence.length).toBeGreaterThan(0);
    expect(detailBody.evidence[0]?.verb).toBeTruthy();
    expect(detailBody.evidence[0]?.source_ref).toBeTruthy();
  });

  it("owner accept/dismiss/correct persist across rebuild", async () => {
    const accept = await fetch(
      `${base}/api/board/evolution/candidates/${candidateId}`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ action: "accept" }),
      },
    );
    expect(accept.status).toBe(200);
    const acceptBody = (await accept.json()) as { candidate: { status: string } };
    expect(acceptBody.candidate.status).toBe("accepted");

    service.rebuildMeaning(ownerId);
    const afterAccept = service.getMeaningCandidate(ownerId, candidateId, {
      includePrivate: true,
    })!;
    expect(afterAccept.candidate.status).toBe("accepted");

    const correct = await fetch(
      `${base}/api/board/evolution/candidates/${candidateId}`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          action: "correct",
          label: "Steady delivery",
          note: "owner-only note",
        }),
      },
    );
    expect(correct.status).toBe(200);
    const correctBody = (await correct.json()) as {
      candidate: { status: string; corrected_label: string | null };
    };
    expect(correctBody.candidate.status).toBe("corrected");
    expect(correctBody.candidate.corrected_label).toBe("Steady delivery");

    service.rebuildMeaning(ownerId);
    const afterCorrect = service.getMeaningCandidate(ownerId, candidateId, {
      includePrivate: true,
    })!;
    expect(afterCorrect.candidate.status).toBe("corrected");
    expect(afterCorrect.candidate.corrected_label).toBe("Steady delivery");
    expect(afterCorrect.candidate.correction_note).toBe("owner-only note");

    const dismiss = await fetch(
      `${base}/api/board/evolution/candidates/${candidateId}`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ action: "dismiss" }),
      },
    );
    expect(dismiss.status).toBe(200);

    service.rebuildMeaning(ownerId);
    const afterDismiss = service.getMeaningCandidate(ownerId, candidateId, {
      includePrivate: true,
    })!;
    expect(afterDismiss.candidate.status).toBe("dismissed");
  });

  it("rejects invalid actions and requires label/note for correct", async () => {
    const badAction = await fetch(
      `${base}/api/board/evolution/candidates/${candidateId}`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ action: "maybe" }),
      },
    );
    expect(badAction.status).toBe(400);

    const badCorrect = await fetch(
      `${base}/api/board/evolution/candidates/${candidateId}`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ action: "correct" }),
      },
    );
    expect(badCorrect.status).toBe(400);
  });
});
