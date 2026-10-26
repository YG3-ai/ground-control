import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EventRecord } from "../events/types.js";
import { deriveEventId, EventStore } from "../events/store.js";
import { deriveEntityId, projectWorld } from "./project.js";
import { WorldStore } from "./store.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "ac-world-"));
  roots.push(dir);
  return dir;
}

function ev(over: Partial<Parameters<EventStore["emit"]>[0]>): EventRecord {
  const store = new EventStore(join(tmp(), "e.db"));
  const rec = store.emit({
    source: "missions",
    sourceRef: "m-1",
    verb: "mission.created",
    dedupeKey: `k-${Math.random()}`,
    ...over,
  });
  store.close();
  return rec;
}

function fixtureEvents(): EventRecord[] {
  return [
    ev({
      source: "missions",
      sourceRef: "m-1",
      actor: "owner",
      verb: "mission.created",
      objectType: "mission",
      objectId: "m-1",
      toState: "intake",
      occurredAt: "2026-10-24T10:00:00.000Z",
      evidenceRefs: ["mission:m-1"],
      sensitivity: "internal",
      dedupeKey: "m1-created",
    }),
    ev({
      source: "missions",
      sourceRef: "m-1",
      actor: "owner",
      verb: "mission.status_changed",
      objectType: "mission",
      objectId: "m-1",
      fromState: "intake",
      toState: "approved",
      occurredAt: "2026-10-24T11:00:00.000Z",
      evidenceRefs: ["mission:m-1"],
      sensitivity: "internal",
      dedupeKey: "m1-approved",
    }),
    ev({
      source: "jobs",
      sourceRef: "j-1",
      actor: "agent:kimi",
      verb: "job.created",
      objectType: "job",
      objectId: "j-1",
      toState: "queued",
      occurredAt: "2026-10-24T11:05:00.000Z",
      evidenceRefs: ["job:j-1"],
      sensitivity: "private",
      dedupeKey: "j1-created",
    }),
    ev({
      source: "usage",
      sourceRef: "usage:7",
      actor: "agent:kimi",
      verb: "usage.rate_limited",
      objectType: "agent",
      objectId: "kimi",
      toState: "rate_limited",
      occurredAt: "2026-10-24T12:00:00.000Z",
      evidenceRefs: ["usage:7"],
      sensitivity: "internal",
      dedupeKey: "u7",
    }),
    ev({
      source: "clients",
      sourceRef: "r-1",
      actor: "owner",
      verb: "client_request.created",
      objectType: "client_request",
      objectId: "r-1",
      toState: "queued",
      occurredAt: "2026-10-24T09:00:00.000Z",
      evidenceRefs: ["request:r-1", "client:acme", "mission:m-1"],
      sensitivity: "private",
      dedupeKey: "r1-created",
    }),
  ];
}

describe("projectWorld", () => {
  it("derives stable entity ids and aliases from events", () => {
    const events = fixtureEvents();
    const a = projectWorld(events);
    const b = projectWorld([...events].reverse());
    expect(a).toEqual(b);

    const ownerId = deriveEntityId("actor:owner");
    const missionId = deriveEntityId("mission:m-1");
    const agentId = deriveEntityId("agent:kimi");
    const clientId = deriveEntityId("client:acme");

    for (const id of [ownerId, missionId, agentId, clientId]) {
      expect(a.entities.some((e) => e.entity_id === id)).toBe(true);
    }
    expect(a.aliases).toContainEqual({ alias: "actor:owner", entity_id: ownerId });
    expect(a.aliases).toContainEqual({ alias: "mission:m-1", entity_id: missionId });

    const mission = a.entities.find((e) => e.entity_id === missionId)!;
    expect(mission.entity_type).toBe("mission");
    expect(mission.state).toBe("approved");
    expect(mission.first_seen_at).toBe("2026-10-24T09:00:00.000Z"); // touched by client event
    expect(mission.last_seen_at).toBe("2026-10-24T11:00:00.000Z");
  });

  it("emits facts with evidence event ids that exist in the spine", () => {
    const events = fixtureEvents();
    const p = projectWorld(events);
    const ids = new Set(events.map((e) => e.event_id));
    expect(p.facts.length).toBeGreaterThan(0);
    for (const f of p.facts) {
      expect(f.evidence_event_ids.length).toBeGreaterThan(0);
      for (const id of f.evidence_event_ids) expect(ids.has(id)).toBe(true);
    }
    const kimi = deriveEntityId("agent:kimi");
    const rl = p.facts.find((f) => f.entity_id === kimi && f.key === "usage_rate_limited");
    expect(rl?.value).toBe("1");
    const jobsCreated = p.facts.find(
      (f) => f.entity_id === kimi && f.key === "jobs_created",
    );
    expect(jobsCreated?.value).toBe("1");
    expect(jobsCreated?.sensitivity).toBe("private");
  });

  it("emits relations with evidence and tracks sensitivity", () => {
    const p = projectWorld(fixtureEvents());
    const kinds = p.relations.map((r) => r.kind);
    expect(kinds).toContain("created_by");
    expect(kinds).toContain("approved_by");
    expect(kinds).toContain("filed_request_for");
    expect(kinds).toContain("served_by");
    const served = p.relations.find((r) => r.kind === "served_by")!;
    expect(served.sensitivity).toBe("private");
    expect(served.evidence_event_ids.length).toBe(1);
  });

  it("applies corrections: superseded events leave history but not state", () => {
    const events = fixtureEvents();
    const bad = ev({
      source: "missions",
      sourceRef: "m-1",
      actor: "owner",
      verb: "mission.status_changed",
      objectType: "mission",
      objectId: "m-1",
      toState: "cancelled",
      occurredAt: "2026-10-24T12:30:00.000Z",
      evidenceRefs: ["mission:m-1"],
      sensitivity: "internal",
      dedupeKey: "m1-bad",
    });
    const fix = ev({
      source: "missions",
      sourceRef: "m-1",
      actor: "owner",
      verb: "mission.status_changed",
      objectType: "mission",
      objectId: "m-1",
      toState: "done",
      occurredAt: "2026-10-24T12:31:00.000Z",
      evidenceRefs: ["mission:m-1"],
      sensitivity: "internal",
      dedupeKey: "m1-fix",
      corrects: bad.event_id,
    });
    const p = projectWorld([...events, bad, fix]);
    const mission = p.entities.find(
      (e) => e.entity_id === deriveEntityId("mission:m-1"),
    )!;
    expect(mission.state).toBe("done");
    const hist = p.history.filter(
      (h) => h.entity_id === mission.entity_id && h.event_id === bad.event_id,
    );
    expect(hist).toHaveLength(1);
    expect(hist[0]!.superseded).toBe(true);
  });
});

describe("WorldStore", () => {
  it("rebuilds deterministically and idempotently", () => {
    const dir = tmp();
    const store = new WorldStore(join(dir, "world.db"));
    const events = fixtureEvents();
    const first = store.rebuildFromEvents(events);
    const snapshot1 = JSON.stringify({
      e: store.listEntities({ includePrivate: true }),
      s: store.summary({ includePrivate: true }),
    });
    const second = store.rebuildFromEvents(events);
    const snapshot2 = JSON.stringify({
      e: store.listEntities({ includePrivate: true }),
      s: store.summary({ includePrivate: true }),
    });
    expect(first).toEqual(second);
    expect(snapshot1).toBe(snapshot2);
    store.close();
  });

  it("filters private entities and facts by default", () => {
    const dir = tmp();
    const store = new WorldStore(join(dir, "world.db"));
    store.rebuildFromEvents(fixtureEvents());

    const publicList = store.listEntities();
    expect(publicList.some((e) => e.entity_type === "organization")).toBe(false);
    const fullList = store.listEntities({ includePrivate: true });
    expect(fullList.some((e) => e.entity_type === "organization")).toBe(true);

    const kimiId = deriveEntityId("agent:kimi");
    const pub = store.getEntity(kimiId)!;
    expect(pub).not.toBeNull();
    expect(pub.facts.some((f) => f.sensitivity === "private")).toBe(false);
    const priv = store.getEntity(kimiId, { includePrivate: true })!;
    expect(priv.facts.some((f) => f.key === "jobs_created")).toBe(true);

    const clientId = deriveEntityId("client:acme");
    expect(store.getEntity(clientId)).toBeNull();
    expect(store.getEntity(clientId, { includePrivate: true })).not.toBeNull();
    expect(store.getEntity("client:acme", { includePrivate: true })?.entity.entity_id)
      .toBe(clientId);
    store.close();
  });

  it("exposes state history with superseded flags and evidence ids", () => {
    const dir = tmp();
    const store = new WorldStore(join(dir, "world.db"));
    const events = fixtureEvents();
    store.rebuildFromEvents(events);
    const missionId = deriveEntityId("mission:m-1");
    const got = store.getEntity(missionId)!;
    expect(got.entity.state).toBe("approved");
    const verbs = got.history.map((h) => h.verb);
    expect(verbs).toContain("mission.created");
    expect(verbs).toContain("mission.status_changed");
    // history references point at real event ids
    const ids = new Set(events.map((e) => e.event_id));
    for (const h of got.history) expect(ids.has(h.event_id)).toBe(true);

    const summary = store.summary();
    expect(summary.entities_total).toBeGreaterThan(0);
    expect(summary.by_type.mission).toBe(1);
    expect(summary.by_type.agent).toBe(1);
    expect(summary.by_state.approved).toBe(1);
    store.close();
  });

  it("entity id derivation matches deriveEventId format and is distinct per alias", () => {
    const a = deriveEntityId("actor:owner");
    const b = deriveEntityId("agent:kimi");
    expect(a).not.toBe(b);
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    // distinct namespace from event ids
    expect(a).not.toBe(
      deriveEventId({
        adapterVersion: 1,
        source: "actor",
        sourceRef: "owner",
        verb: "x",
        dedupeKey: "x",
      }),
    );
  });
});
