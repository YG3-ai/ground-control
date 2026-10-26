import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EventRecord } from "../events/types.js";
import { EventStore } from "../events/store.js";
import { projectWorld } from "../world/project.js";
import { runRules, rebuildMeaning } from "./engine.js";
import { RULE_CATALOG } from "./rules.js";
import { MeaningStore } from "./store.js";
import type { InterpretationCandidate } from "./types.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "ac-meaning-"));
  roots.push(dir);
  return dir;
}

let seq = 0;
function ev(over: Partial<Parameters<EventStore["emit"]>[0]>): EventRecord {
  const store = new EventStore(join(tmp(), "e.db"));
  const rec = store.emit({
    source: "missions",
    sourceRef: "m-x",
    verb: "mission.created",
    dedupeKey: `k-${seq++}`,
    ...over,
  });
  store.close();
  return rec;
}

/** One completed mission: created → job success → mission done (job-linked). */
function completedMission(
  missionId: string,
  jobId: string,
  day: number,
  opts?: { failFirst?: boolean; failureJobId?: string },
): EventRecord[] {
  const d = String(day).padStart(2, "0");
  const out: EventRecord[] = [
    ev({
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
    }),
  ];
  if (opts?.failFirst) {
    const fj = opts.failureJobId ?? `${jobId}-f`;
    out.push(
      ev({
        source: "jobs",
        sourceRef: fj,
        actor: "agent:kimi",
        verb: "job.status_changed",
        objectType: "job",
        objectId: fj,
        fromState: "running",
        toState: "failed",
        occurredAt: `2026-10-${d}T10:00:00.000Z`,
        evidenceRefs: [`job:${fj}`],
        sensitivity: "private",
      }),
    );
  }
  out.push(
    ev({
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
    }),
    ev({
      source: "missions",
      sourceRef: missionId,
      actor: "owner",
      verb: "mission.status_changed",
      objectType: "mission",
      objectId: missionId,
      fromState: "implementing",
      toState: "done",
      occurredAt: `2026-10-${d}T12:00:00.000Z`,
      evidenceRefs: opts?.failFirst
        ? [
            `mission:${missionId}`,
            `job:${opts.failureJobId ?? `${jobId}-f`}`,
            `job:${jobId}`,
          ]
        : [`mission:${missionId}`, `job:${jobId}`],
      sensitivity: "internal",
    }),
  );
  return out;
}

function missionSet(
  count: number,
  opts?: { failures?: number[] },
): EventRecord[] {
  const out: EventRecord[] = [];
  for (let i = 1; i <= count; i++) {
    out.push(
      ...completedMission(`m-${i}`, `j-${i}`, i, {
        failFirst: opts?.failures?.includes(i) ?? false,
      }),
    );
  }
  return out;
}

function candidatesFor(events: EventRecord[]): InterpretationCandidate[] {
  return runRules(events, projectWorld(events));
}

describe("meaning rules", () => {
  it("exposes versioned rule explanations with thresholds", () => {
    for (const r of RULE_CATALOG) {
      expect(r.rule_id).toBeTruthy();
      expect(r.rule_version).toBeGreaterThan(0);
      expect(r.explanation.length).toBeGreaterThan(20);
      expect(Object.keys(r.thresholds).length).toBeGreaterThan(0);
    }
    // badges are doctrine-suspect: no v1 rule emits them
    expect(RULE_CATALOG.some((r) => r.kind === "badge")).toBe(false);
  });

  it("emits no candidates on weak evidence", () => {
    const events = [
      ev({
        source: "missions",
        sourceRef: "m-1",
        actor: "owner",
        verb: "mission.created",
        objectType: "mission",
        objectId: "m-1",
        toState: "intake",
        occurredAt: "2026-10-24T09:00:00.000Z",
        evidenceRefs: ["mission:m-1"],
        sensitivity: "internal",
      }),
    ];
    expect(candidatesFor(events)).toEqual([]);
  });

  it("detects recovery_after_failure only when failure precedes completion", () => {
    const recovered = candidatesFor(missionSet(1, { failures: [1] }));
    const tp = recovered.filter((c) => c.kind === "turning_point");
    expect(tp).toHaveLength(1);
    expect(tp[0]!.rule_id).toBe("recovery_after_failure");
    expect(tp[0]!.proposed_label).toBe("Recovered after failure");
    expect(tp[0]!.sensitivity).toBe("private"); // job failure evidence is private
    expect(tp[0]!.confidence).toBeGreaterThanOrEqual(0.6);
    expect(tp[0]!.confidence).toBeLessThanOrEqual(0.9);

    const clean = candidatesFor(missionSet(1));
    expect(clean.filter((c) => c.kind === "turning_point")).toEqual([]);
  });

  it("maturity ladder boundaries: 2/3/7/15 completed missions", () => {
    const cap = (events: EventRecord[]) =>
      candidatesFor(events).find((c) => c.rule_id === "reliable_delivery");

    expect(cap(missionSet(2))).toBeUndefined();
    expect(cap(missionSet(3))?.maturity).toBe("acquired");
    expect(cap(missionSet(3))?.confidence).toBe(0.6);
    expect(cap(missionSet(7))?.maturity).toBe("reliable");
    expect(cap(missionSet(7))?.confidence).toBe(0.75);
    // 15 completions but no recovery → reliable, not hardened
    expect(cap(missionSet(15))?.maturity).toBe("reliable");
    // 15 completions + a recovery → hardened
    expect(cap(missionSet(15, { failures: [3] }))?.maturity).toBe("hardened");
    expect(cap(missionSet(15, { failures: [3] }))?.confidence).toBe(0.9);
  });

  it("self_running_system requires 10 missions, 80% clean, 2 recoveries", () => {
    const self = (events: EventRecord[]) =>
      candidatesFor(events).find((c) => c.rule_id === "self_running_system");

    // 10 clean completions but no recoveries → nothing
    expect(self(missionSet(10))).toBeUndefined();
    // 10 completions, 2 recoveries, 80% clean → hardened capability
    const withRec = self(missionSet(10, { failures: [2, 5] }));
    expect(withRec?.maturity).toBe("hardened");
    expect(withRec?.kind).toBe("capability");
    // 3 failures → clean fraction 70% < 80% → nothing
    expect(self(missionSet(10, { failures: [2, 5, 8] }))).toBeUndefined();
  });

  it("completions without successful job evidence do not count", () => {
    const orphan = [
      ev({
        source: "missions",
        sourceRef: "m-1",
        actor: "owner",
        verb: "mission.status_changed",
        objectType: "mission",
        objectId: "m-1",
        toState: "done",
        occurredAt: "2026-10-24T12:00:00.000Z",
        evidenceRefs: ["mission:m-1"],
        sensitivity: "internal",
      }),
    ];
    expect(candidatesFor(orphan)).toEqual([]);
  });

  it("excludes superseded events from evidence", () => {
    const events = missionSet(1, { failures: [1] });
    const failEvent = events.find((e) => e.to_state === "failed")!;
    const fix = ev({
      source: "jobs",
      sourceRef: "j-1-f",
      actor: "agent:kimi",
      verb: "job.status_changed",
      objectType: "job",
      objectId: "j-1-f",
      toState: "succeeded",
      occurredAt: "2026-10-01T10:30:00.000Z",
      evidenceRefs: ["job:j-1-f"],
      sensitivity: "private",
      corrects: failEvent.event_id,
    });
    const candidates = candidatesFor([...events, fix]);
    expect(candidates.filter((c) => c.kind === "turning_point")).toEqual([]);
  });

  it("evidence ids always exist in the input event set", () => {
    const events = missionSet(15, { failures: [2, 7] });
    const ids = new Set(events.map((e) => e.event_id));
    for (const c of candidatesFor(events)) {
      expect(c.evidence_event_ids.length).toBeGreaterThan(0);
      for (const id of c.evidence_event_ids) expect(ids.has(id)).toBe(true);
      expect(c.entity_ids.length).toBeGreaterThan(0);
    }
  });

  it("propagates max evidence sensitivity", () => {
    // job success/failure events are private → capability evidence is private
    const cap = candidatesFor(missionSet(3)).find(
      (c) => c.rule_id === "reliable_delivery",
    )!;
    expect(cap.sensitivity).toBe("private");
  });

  it("never emits authority/permission fields on candidates", () => {
    const banned = ["permission", "authority", "grant", "scope", "role", "allow"];
    for (const c of candidatesFor(missionSet(15, { failures: [2, 7] }))) {
      for (const key of Object.keys(c)) {
        expect(banned.some((b) => key.toLowerCase().includes(b))).toBe(false);
      }
    }
  });
});

describe("MeaningStore", () => {
  function makeStore(): { store: MeaningStore; dir: string } {
    const dir = tmp();
    return { store: new MeaningStore(join(dir, "meaning.db")), dir };
  }

  it("is deterministic and idempotent across rebuilds and wipes", () => {
    const events = missionSet(7, { failures: [2] });
    const { store, dir } = makeStore();
    const report1 = rebuildMeaning({ events, store });
    const snap1 = JSON.stringify(
      store.listCandidates({ includePrivate: true }),
    );
    const report2 = rebuildMeaning({ events, store });
    const snap2 = JSON.stringify(
      store.listCandidates({ includePrivate: true }),
    );
    expect(report1).toEqual(report2);
    expect(snap1).toBe(snap2);

    store.close();
    // wipe candidates only (decisions table would persist in the same file)
    const store2 = new MeaningStore(join(dir, "meaning.db"));
    store2.db.exec(`DELETE FROM candidates`);
    rebuildMeaning({ events, store: store2 });
    const snap3 = JSON.stringify(
      store2.listCandidates({ includePrivate: true }),
    );
    expect(snap3).toBe(snap1);
    store2.close();
  });

  it("privacy: private candidates hidden by default, shown with includePrivate", () => {
    const events = missionSet(3);
    const { store } = makeStore();
    rebuildMeaning({ events, store });
    expect(store.listCandidates()).toEqual([]);
    const priv = store.listCandidates({ includePrivate: true });
    expect(priv.length).toBeGreaterThan(0);
    expect(priv.every((c) => c.sensitivity === "private")).toBe(true);

    const id = priv[0]!.candidate_id;
    expect(store.getCandidate(id)).toBeNull();
    expect(store.getCandidate(id, { includePrivate: true })).not.toBeNull();
    store.close();
  });

  it("decision overlay survives rebuild; corrections keep the proposal", () => {
    const events = missionSet(3);
    const { store } = makeStore();
    rebuildMeaning({ events, store });
    const cap = store.listCandidates({ includePrivate: true })[0]!;

    store.applyDecision({
      candidate_id: cap.candidate_id,
      decision: "correct",
      corrected_label: "Steady delivery",
      correction_note: "owner wording",
      decided_at: "2026-10-24T15:00:00.000Z",
      decided_by: "owner",
    });
    let got = store.getCandidate(cap.candidate_id, { includePrivate: true })!;
    expect(got.candidate.status).toBe("corrected");
    expect(got.candidate.corrected_label).toBe("Steady delivery");
    expect(got.candidate.proposed_label).toBe("Reliable mission delivery");

    rebuildMeaning({ events, store });
    got = store.getCandidate(cap.candidate_id, { includePrivate: true })!;
    expect(got.candidate.status).toBe("corrected");
    expect(got.candidate.corrected_label).toBe("Steady delivery");
    expect(got.candidate.proposed_label).toBe("Reliable mission delivery");

    store.applyDecision({
      candidate_id: cap.candidate_id,
      decision: "accept",
      decided_at: "2026-10-24T16:00:00.000Z",
      decided_by: "owner",
    });
    rebuildMeaning({ events, store });
    got = store.getCandidate(cap.candidate_id, { includePrivate: true })!;
    expect(got.candidate.status).toBe("accepted");
    expect(got.candidate.accepted_at).toBe("2026-10-24T16:00:00.000Z");
    // corrections cleared by the newer accept overlay
    expect(got.candidate.corrected_label).toBeNull();

    const log = store.decisionLog();
    expect(log).toHaveLength(2);
    expect(log[0]!.decision).toBe("correct");
    expect(log[1]!.decision).toBe("accept");
    store.close();
  });

  it("summary counts by kind/status/sensitivity/rule", () => {
    const events = missionSet(10, { failures: [2, 5] });
    const { store } = makeStore();
    rebuildMeaning({ events, store });
    const s = store.summary({ includePrivate: true });
    expect(s.candidates_total).toBeGreaterThan(0);
    expect(s.by_kind.capability).toBeGreaterThan(0);
    expect(s.by_kind.turning_point).toBe(2);
    expect(s.by_rule_id.recovery_after_failure).toBe(2);
    expect(s.by_sensitivity.private).toBe(s.candidates_total);
    const pub = store.summary();
    expect(pub.candidates_total).toBe(0);
    store.close();
  });
});

describe("WorkerService meaning integration", () => {
  it("decisions emit content-free spine events and overlay transitions work", async () => {
    const { createService } = await import("../test-utils.js");
    const dir = tmp();
    const fixture = join(dir, "fixture");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(fixture, { recursive: true });
    const service = createService(dir, fixture);
    const ownerId = service.config.owner.id;

    for (const e of missionSet(3)) {
      service.events.emit({
        source: e.source,
        sourceRef: e.source_ref,
        actor: e.actor,
        verb: e.verb,
        objectType: e.object_type,
        objectId: e.object_id,
        fromState: e.from_state,
        toState: e.to_state,
        occurredAt: e.occurred_at,
        evidenceRefs: e.evidence_refs,
        sensitivity: e.sensitivity,
        dedupeKey: e.event_id, // stable re-emit of the same derived events
      });
    }

    const report = service.rebuildMeaning(ownerId);
    expect(report.candidates_total).toBeGreaterThan(0);
    expect(report.by_rule_id.reliable_delivery).toBe(1);

    const listed = service.listMeaningCandidates(ownerId, {
      includePrivate: true,
    });
    const cap = listed.candidates.find(
      (c) => c.rule_id === "reliable_delivery",
    )!;
    expect(cap.status).toBe("proposed");

    // default list hides private candidates
    expect(service.listMeaningCandidates(ownerId).candidates).toEqual([]);

    const before = service.events.count();
    service.correctMeaningCandidate(ownerId, cap.candidate_id, {
      label: "Steady delivery",
      note: "private owner note",
    });
    service.acceptMeaningCandidate(ownerId, cap.candidate_id);
    service.dismissMeaningCandidate(ownerId, cap.candidate_id);
    expect(service.events.count()).toBe(before + 3);

    const decisionEvents = service.events
      .list({ source: "meaning", includePrivate: true })
      .filter((e) => e.object_id === cap.candidate_id);
    expect(decisionEvents.map((e) => e.verb).sort()).toEqual([
      "candidate.accepted",
      "candidate.corrected",
      "candidate.dismissed",
    ]);
    for (const e of decisionEvents) {
      expect(e.object_type).toBe("interpretation_candidate");
      // note bodies never enter the spine
      expect(JSON.stringify(e)).not.toContain("private owner note");
    }

    // latest decision (dismiss) wins and survives a rebuild
    service.rebuildMeaning(ownerId);
    const got = service.getMeaningCandidate(ownerId, cap.candidate_id, {
      includePrivate: true,
    })!;
    expect(got.candidate.status).toBe("dismissed");
    expect(got.decision?.decision).toBe("dismiss");
    expect(got.evidence.length).toBeGreaterThan(0);
    for (const s of got.evidence) {
      expect(Object.keys(s).sort()).toEqual([
        "event_id",
        "from_state",
        "object_id",
        "object_type",
        "occurred_at",
        "sensitivity",
        "source",
        "source_ref",
        "to_state",
        "verb",
      ]);
    }

    // overlay summary counts decisions
    expect(service.meaningSummary(ownerId).decisions_total).toBe(1);
    service.close();
  });
});
