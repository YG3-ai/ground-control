import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClientRequestStore } from "../clients/store.js";
import { UsageLedger } from "../usage/ledger.js";
import { EventStore } from "./store.js";
import { createService, initGitFixture, makeTempRoot } from "../test-utils.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "ac-adapters-"));
  roots.push(dir);
  return dir;
}

describe("usage adapter", () => {
  it("derives durable usage events (incl. blocked/rate_limited) without detail text", () => {
    const dir = tmp();
    const usage = new UsageLedger(join(dir, "usage.db"));
    const SENTINEL = "SENTINEL-DETAIL-3b91-no-store";
    usage.record({ agent: "kimi", kind: "start", jobId: "job-1", model: "k3" });
    usage.record({ agent: "kimi", kind: "blocked", detail: SENTINEL });
    usage.record({ agent: "kimi", kind: "rate_limited", detail: SENTINEL });
    usage.record({ agent: "cursor", kind: "finish", jobId: "job-2" });

    const events = new EventStore(join(dir, "events.db"));
    const report = events.rebuildFrom({ usage });
    expect(report.inserted).toBe(4);

    const rows = events.list({ includePrivate: true });
    const verbs = rows.map((r) => r.verb).sort();
    expect(verbs).toEqual([
      "usage.blocked",
      "usage.finish",
      "usage.rate_limited",
      "usage.start",
    ]);
    expect(rows.every((r) => r.sensitivity === "internal")).toBe(true);
    const blocked = rows.find((r) => r.verb === "usage.blocked")!;
    expect(blocked.actor).toBe("agent:kimi");
    expect(blocked.evidence_refs).toContain("usage:2");

    const dump = events.db
      .prepare(`SELECT * FROM events`)
      .all()
      .map((r) => JSON.stringify(r))
      .join("\n");
    expect(dump).not.toContain(SENTINEL);
    usage.close();
    events.close();
  });

  it("emits live usage events via onEvent sink", () => {
    const dir = tmp();
    const usage = new UsageLedger(join(dir, "usage.db"));
    const events = new EventStore(join(dir, "events.db"));
    usage.onEvent = (e) => events.emit(e);
    usage.record({ agent: "kimi", kind: "rate_limited" });
    const rows = events.list({ source: "usage" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.verb).toBe("usage.rate_limited");
    // live and rebuild ids agree (same row → same deterministic id)
    const report = events.rebuildFrom({ usage });
    expect(report.inserted).toBe(0);
    usage.close();
    events.close();
  });
});

describe("clients adapter", () => {
  it("derives private request lifecycle events without subject/body content", () => {
    const dir = tmp();
    const clients = new ClientRequestStore(join(dir, "clients.db"));
    const SENTINEL = "SENTINEL-CLIENT-9c41-body";
    const client = { id: "acme", name: "Acme Corp", workspace: "acme" };
    const req = clients.create({
      ownerId: "owner-1",
      client,
      subject: `subject ${SENTINEL}`,
      body: `body ${SENTINEL}`,
      fromEmail: "person@acme.example",
      missionId: "m-9",
    });
    clients.update("owner-1", req.id, { status: "in_progress" });
    clients.update("owner-1", req.id, { status: "done", fixSummary: SENTINEL });

    const events = new EventStore(join(dir, "events.db"));
    events.rebuildFrom({ clients });

    // private by default
    expect(events.list()).toHaveLength(0);
    const rows = events.list({ includePrivate: true, source: "clients" });
    expect(rows.length).toBeGreaterThanOrEqual(3); // created + status_current + completed
    expect(rows.every((r) => r.sensitivity === "private")).toBe(true);
    const created = rows.find((r) => r.verb === "client_request.created")!;
    expect(created.evidence_refs).toContain("client:acme");
    expect(created.evidence_refs).toContain("mission:m-9");

    const dump = events.db
      .prepare(`SELECT * FROM events`)
      .all()
      .map((r) => JSON.stringify(r))
      .join("\n");
    expect(dump).not.toContain(SENTINEL);
    expect(dump).not.toContain("person@acme.example");
    clients.close();
    events.close();
  });

  it("emits live create/status events via onEvent sink", () => {
    const dir = tmp();
    const clients = new ClientRequestStore(join(dir, "clients.db"));
    const events = new EventStore(join(dir, "events.db"));
    clients.onEvent = (e) => events.emit(e);
    const req = clients.create({
      ownerId: "o",
      client: { id: "c1", name: "C1", workspace: "w" },
      subject: "s",
      body: "b",
    });
    clients.update("o", req.id, { status: "done" });
    const rows = events.list({ includePrivate: true, source: "clients" });
    expect(rows.map((r) => r.verb).sort()).toEqual([
      "client_request.created",
      "client_request.status_changed",
    ]);
    clients.close();
    events.close();
  });
});

describe("controlled rebuild / dry-run", () => {
  it("dry-run reports counts only and writes nothing", () => {
    const dir = tmp();
    const usage = new UsageLedger(join(dir, "usage.db"));
    usage.record({ agent: "kimi", kind: "start", jobId: "j1" });
    const clients = new ClientRequestStore(join(dir, "clients.db"));
    clients.create({
      ownerId: "o",
      client: { id: "c", name: "C", workspace: "w" },
      subject: "s",
      body: "b",
    });

    const events = new EventStore(join(dir, "events.db"));
    const dry = events.rebuildFrom({ usage, clients }, { dryRun: true });
    expect(dry.dry_run).toBe(true);
    expect(dry.inserted).toBe(0);
    expect(events.count()).toBe(0);
    const usageRow = dry.per_source.find((p) => p.source === "usage")!;
    expect(usageRow.derived).toBe(1);
    expect(usageRow.would_insert).toBe(1);
    expect(usageRow.sensitivity.internal).toBe(1);
    const clientRow = dry.per_source.find((p) => p.source === "clients")!;
    expect(clientRow.sensitivity.private).toBe(clientRow.derived);
    // report carries no ids/refs — counts only
    expect(JSON.stringify(dry)).not.toContain("client:c");

    const applied = events.rebuildFrom({ usage, clients });
    expect(applied.inserted).toBeGreaterThan(0);
    const again = events.rebuildFrom({ usage, clients });
    expect(again.inserted).toBe(0);
    // after apply, a dry-run shows everything already present
    const dry2 = events.rebuildFrom({ usage, clients }, { dryRun: true });
    expect(dry2.per_source.every((p) => p.would_insert === 0)).toBe(true);
    usage.close();
    clients.close();
    events.close();
  });
});

describe("growth snapshot adapter", () => {
  it("stores compact metric deltas only and is idempotent per snapshot", () => {
    const dir = tmp();
    const events = new EventStore(join(dir, "events.db"));
    const first = events.emitMetricSnapshot({
      source: "growth",
      snapshotId: "snap-2026-10-24",
      generatedAt: "2026-10-24T08:00:00.000Z",
      metrics: {
        notes_total: 42,
        last_region: "inbox",
        prose: "x".repeat(500), // rejected: too long, would be content
        "bad key!": 1, // rejected: invalid key
      },
      evidenceRefs: ["second_brain:stats"],
    });
    expect(first).toHaveLength(2);
    expect(events.count()).toBe(2);
    const rows = events.list({ source: "growth" });
    expect(rows.map((r) => r.object_id).sort()).toEqual([
      "last_region",
      "notes_total",
    ]);
    expect(rows.every((r) => r.verb === "growth.snapshot_metric")).toBe(true);
    expect(rows[0]!.occurred_at).toBe("2026-10-24T08:00:00.000Z");
    // idempotent re-ingest
    events.emitMetricSnapshot({
      source: "growth",
      snapshotId: "snap-2026-10-24",
      generatedAt: "2026-10-24T08:00:00.000Z",
      metrics: { notes_total: 42, last_region: "inbox" },
    });
    expect(events.count()).toBe(2);
    events.close();
  });
});

describe("session lifecycle hooks", () => {
  it("emits session.created and session.exited with metadata only", async () => {
    const root = makeTempRoot();
    roots.push(root);
    const fixture = join(root, "fixture");
    mkdirSync(fixture, { recursive: true });
    initGitFixture(fixture);
    const service = createService(root, fixture);
    const SENTINEL = "SENTINEL-SESSION-cmd";
    const rec = service.createTerminalSession({
      ownerId: "owner-test",
      kind: "shell",
      workspace: fixture,
      idleSec: null,
    });
    service.writeTerminalInput("owner-test", rec.id, {
      data: `echo ${SENTINEL}`,
      submit: true,
    });
    await new Promise((r) => setTimeout(r, 400));
    service.closeTerminalSession("owner-test", rec.id);
    // exited event fires from the pty onExit handler — allow a beat
    await new Promise((r) => setTimeout(r, 600));

    const rows = service.events.list({
      source: "sessions",
      includePrivate: true,
    });
    const verbs = rows.map((r) => r.verb).sort();
    expect(verbs).toContain("session.created");
    expect(verbs).toContain("session.exited");
    const dump = service.events.db
      .prepare(`SELECT * FROM events WHERE source = 'sessions'`)
      .all()
      .map((r) => JSON.stringify(r))
      .join("\n");
    expect(dump).not.toContain(SENTINEL);
    expect(dump).not.toContain("/bin/"); // no command path
    service.close();
  }, 20_000);
});
