import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JobStore } from "../db.js";
import { ApprovalManager } from "../local/approvals.js";
import { MissionStore } from "../missions/store.js";
import { deriveEventId, EventStore } from "./store.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "ac-events-"));
  roots.push(dir);
  return dir;
}

function sampleEvent(over: Partial<Parameters<EventStore["emit"]>[0]> = {}) {
  return {
    source: "missions",
    sourceRef: "mission-fixture-1",
    verb: "mission.status_changed",
    occurredAt: "2026-10-24T10:00:00.000Z",
    observedAt: "2026-10-24T10:00:01.000Z",
    fromState: "intake",
    toState: "researching",
    evidenceRefs: ["mission:mission-fixture-1"],
    sensitivity: "internal" as const,
    dedupeKey: "fx-status-1",
    ...over,
  };
}

describe("EventStore", () => {
  it("derives a deterministic event_id across store instances", () => {
    const dir = tmp();
    const a = new EventStore(join(dir, "a.db"));
    const e1 = a.emit(sampleEvent());
    a.close();
    const b = new EventStore(join(dir, "b.db"));
    const e2 = b.emit(sampleEvent());
    b.close();
    expect(e1.event_id).toBe(e2.event_id);
    expect(e1.event_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(
      deriveEventId({
        adapterVersion: 1,
        source: "missions",
        sourceRef: "mission-fixture-1",
        verb: "mission.status_changed",
        dedupeKey: "fx-status-1",
      }),
    ).toBe(e1.event_id);
  });

  it("dedupes the same derived event via INSERT OR IGNORE", () => {
    const dir = tmp();
    const s = new EventStore(join(dir, "events.db"));
    s.emit(sampleEvent());
    s.emit(sampleEvent());
    expect(s.count()).toBe(1);
    s.close();
  });

  it("lists events ordered by occurred_at DESC", () => {
    const dir = tmp();
    const s = new EventStore(join(dir, "events.db"));
    s.emit(sampleEvent({ dedupeKey: "older", occurredAt: "2026-10-24T09:00:00.000Z" }));
    s.emit(sampleEvent({ dedupeKey: "newer", occurredAt: "2026-10-24T11:00:00.000Z" }));
    s.emit(sampleEvent({ dedupeKey: "middle", occurredAt: "2026-10-24T10:00:00.000Z" }));
    const rows = s.list();
    expect(rows.map((r) => r.occurred_at)).toEqual([
      "2026-10-24T11:00:00.000Z",
      "2026-10-24T10:00:00.000Z",
      "2026-10-24T09:00:00.000Z",
    ]);
    s.close();
  });

  it("keeps corrections as new immutable events alongside the original", () => {
    const dir = tmp();
    const s = new EventStore(join(dir, "events.db"));
    const original = s.emit(sampleEvent());
    const correction = s.emit(
      sampleEvent({
        dedupeKey: "fx-status-1-correction",
        toState: "plan_ready",
        corrects: original.event_id,
        occurredAt: "2026-10-24T12:00:00.000Z",
      }),
    );
    const rows = s.list();
    expect(rows).toHaveLength(2);
    const stillOriginal = rows.find((r) => r.event_id === original.event_id)!;
    expect(stillOriginal.to_state).toBe("researching");
    expect(stillOriginal.corrects).toBeNull();
    expect(correction.corrects).toBe(original.event_id);
    s.close();
  });

  it("excludes private events by default and never stores source body text", async () => {
    const dir = tmp();
    const SENTINEL = "SENTINEL-BODY-7f3a9c-do-not-store";
    const jobs = new JobStore(join(dir, "jobs.db"));
    const missions = new MissionStore(join(dir, "missions.db"));
    const approvals = new ApprovalManager({
      ownerId: "owner-local",
      dataDir: join(dir, "approvals"),
    });
    const events = new EventStore(join(dir, "events.db"));
    jobs.onEvent = (e) => events.emit(e);
    missions.onEvent = (e) => events.emit(e);
    approvals.onEvent = (e) => events.emit(e);

    const job = jobs.createJob({
      ownerId: "owner-local",
      projectId: "demo",
      agent: "mock",
      prompt: `please fix the thing ${SENTINEL}`,
      timeoutSec: 60,
    });
    missions.create({
      ownerId: "owner-local",
      title: "fixture mission",
      goal: `goal containing ${SENTINEL}`,
    });
    await approvals.request({
      ownerId: "owner-local",
      kind: "general",
      title: `approve ${SENTINEL}`,
      detail: `detail ${SENTINEL}`,
      wait: false,
    });

    events.rebuildFrom({ jobs, missions, approvals });

    const internal = events.list();
    expect(internal.length).toBeGreaterThan(0);
    expect(internal.every((r) => r.sensitivity !== "private")).toBe(true);

    const everything = events.list({ includePrivate: true });
    expect(everything.length).toBeGreaterThan(internal.length);
    expect(everything.some((r) => r.source_ref === job.id)).toBe(true);

    const dump = events.db
      .prepare(`SELECT * FROM events`)
      .all()
      .map((r) => JSON.stringify(r))
      .join("\n");
    expect(dump).not.toContain(SENTINEL);

    jobs.close();
    missions.close();
    events.close();
  });

  it("rebuild is idempotent across runs", async () => {
    const dir = tmp();
    const jobs = new JobStore(join(dir, "jobs.db"));
    const missions = new MissionStore(join(dir, "missions.db"));
    const approvals = new ApprovalManager({
      ownerId: "owner-local",
      dataDir: join(dir, "approvals"),
    });
    const events = new EventStore(join(dir, "events.db"));

    jobs.createJob({
      ownerId: "owner-local",
      projectId: "demo",
      agent: "mock",
      prompt: "fixture prompt",
      timeoutSec: 60,
    });
    const m = missions.create({
      ownerId: "owner-local",
      title: "fixture",
      goal: "fixture goal",
    });
    missions.update("owner-local", m.id, { status: "researching" });
    missions.update("owner-local", m.id, { status: "approved" });
    missions.update("owner-local", m.id, { status: "done" });
    await approvals.request({
      ownerId: "owner-local",
      kind: "permission",
      title: "fixture approval",
      detail: "fixture detail",
      wait: false,
    });

    const first = events.rebuildFrom({ jobs, missions, approvals });
    const countAfterFirst = events.count();
    const second = events.rebuildFrom({ jobs, missions, approvals });
    expect(second.inserted).toBe(0);
    expect(events.count()).toBe(countAfterFirst);
    expect(first.inserted).toBeGreaterThan(0);

    jobs.close();
    missions.close();
    events.close();
  });
});
