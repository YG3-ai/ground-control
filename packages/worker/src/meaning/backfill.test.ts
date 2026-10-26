import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventStore } from "../events/store.js";
import type { EventRecord } from "../events/types.js";
import { MissionStore } from "../missions/store.js";
import { projectWorld } from "../world/project.js";
import { runRules } from "./engine.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "ac-backfill-"));
  roots.push(dir);
  return dir;
}

type Fixture = {
  events: EventStore;
  missions: MissionStore;
};

function setup(): Fixture {
  const dir = tmp();
  return {
    events: new EventStore(join(dir, "events.db")),
    missions: new MissionStore(join(dir, "missions.db")),
  };
}

/** Insert a completed mission row directly (historical fixture). */
function seedMission(
  f: Fixture,
  id: string,
  linkedJobIds: string[],
  completedAt: string,
): void {
  f.missions.db
    .prepare(
      `INSERT INTO missions (
        id, owner_id, title, goal, status,
        linked_job_ids, linked_session_ids, markers,
        created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, 'done', ?, '[]', '{}', ?, ?, ?)`,
    )
    .run(id, "owner", `fixture mission ${id}`, "goal", JSON.stringify(linkedJobIds), completedAt, completedAt, completedAt);
}

/** Historical completion event: no job:<id> evidence refs (pre-linkage era). */
function legacyCompletion(
  f: Fixture,
  missionId: string,
  completedAt: string,
  sensitivity: "internal" | "private" = "internal",
): EventRecord {
  return f.events.emit({
    source: "missions",
    sourceRef: missionId,
    actor: "owner",
    verb: "mission.status_changed",
    objectType: "mission",
    objectId: missionId,
    fromState: "implementing",
    toState: "done",
    occurredAt: completedAt,
    observedAt: completedAt,
    evidenceRefs: [`mission:${missionId}`],
    sensitivity,
    dedupeKey: "completed",
  });
}

function jobSucceeded(f: Fixture, jobId: string, at: string): EventRecord {
  return f.events.emit({
    source: "jobs",
    sourceRef: jobId,
    actor: "agent:kimi",
    verb: "job.status_changed",
    objectType: "job",
    objectId: jobId,
    fromState: "running",
    toState: "succeeded",
    occurredAt: at,
    evidenceRefs: [`job:${jobId}`],
    sensitivity: "private",
    dedupeKey: "finished:succeeded",
  });
}

describe("backfillMissionEvidence", () => {
  it("supersedes a job-less completion with a correction carrying linked job refs, enabling reliable_delivery", () => {
    const f = setup();
    for (let i = 1; i <= 3; i++) {
      const d = String(i).padStart(2, "0");
      seedMission(f, `m-${i}`, [`j-${i}`], `2026-10-${d}T12:00:00.000Z`);
      jobSucceeded(f, `j-${i}`, `2026-10-${d}T11:00:00.000Z`);
      legacyCompletion(f, `m-${i}`, `2026-10-${d}T12:00:00.000Z`);
    }
    // Before backfill: completions carry no job refs, so no candidates.
    const before = runRules(f.events.allEvents(), projectWorld(f.events.allEvents()));
    expect(before).toHaveLength(0);

    const report = f.events.backfillMissionEvidence(f.missions);
    expect(report).toMatchObject({ scanned: 3, corrected: 3, already_ok: 0, dry_run: false });

    const all = f.events.allEvents();
    const corrections = all.filter((e) => e.corrects != null);
    expect(corrections).toHaveLength(3);
    for (const c of corrections) {
      expect(c.verb).toBe("mission.status_changed");
      expect(c.to_state).toBe("done");
      expect(c.evidence_refs.some((r) => r.startsWith("job:"))).toBe(true);
    }

    const candidates = runRules(all, projectWorld(all));
    const reliable = candidates.find((c) => c.rule_id === "reliable_delivery");
    expect(reliable).toBeDefined();
    expect(reliable!.maturity).toBe("acquired");
    expect(reliable!.sensitivity).toBe("private"); // max evidence sensitivity
    f.events.close();
    f.missions.close();
  });

  it("is idempotent: a second run corrects 0 and changes nothing", () => {
    const f = setup();
    seedMission(f, "m-1", ["j-1"], "2026-10-01T12:00:00.000Z");
    jobSucceeded(f, "j-1", "2026-10-01T11:00:00.000Z");
    legacyCompletion(f, "m-1", "2026-10-01T12:00:00.000Z");

    const r1 = f.events.backfillMissionEvidence(f.missions);
    expect(r1.corrected).toBe(1);
    const ids1 = f.events.allEvents().map((e) => e.event_id);
    const count1 = f.events.count();

    // Second run: the superseded original is skipped; the correction event is
    // itself a done-completion whose evidence is complete → already_ok.
    const r2 = f.events.backfillMissionEvidence(f.missions);
    expect(r2).toMatchObject({ scanned: 1, corrected: 0, already_ok: 1 });
    expect(f.events.count()).toBe(count1);
    expect(f.events.allEvents().map((e) => e.event_id)).toEqual(ids1);
    f.events.close();
    f.missions.close();
  });

  it("counts already-correct completions as already_ok", () => {
    const f = setup();
    seedMission(f, "m-1", ["j-1"], "2026-10-01T12:00:00.000Z");
    f.events.emit({
      source: "missions",
      sourceRef: "m-1",
      actor: "owner",
      verb: "mission.status_changed",
      objectType: "mission",
      objectId: "m-1",
      toState: "done",
      occurredAt: "2026-10-01T12:00:00.000Z",
      evidenceRefs: ["mission:m-1", "job:j-1"],
      dedupeKey: "completed",
    });
    const r = f.events.backfillMissionEvidence(f.missions);
    expect(r).toMatchObject({ scanned: 1, corrected: 0, already_ok: 1 });
    f.events.close();
    f.missions.close();
  });

  it("never links across missions and never infers from timing", () => {
    const f = setup();
    seedMission(f, "m-a", ["j-a"], "2026-10-01T12:00:00.000Z");
    seedMission(f, "m-b", ["j-b"], "2026-10-02T12:00:00.000Z");
    // A job whose timestamps align with m-a but that is NOT in its
    // linked_job_ids must not be pulled in.
    jobSucceeded(f, "j-unrelated", "2026-10-01T11:30:00.000Z");
    legacyCompletion(f, "m-a", "2026-10-01T12:00:00.000Z");
    legacyCompletion(f, "m-b", "2026-10-02T12:00:00.000Z");

    const r = f.events.backfillMissionEvidence(f.missions);
    expect(r.corrected).toBe(2);
    const all = f.events.allEvents();
    const corrA = all.find((e) => e.corrects != null && e.object_id === "m-a")!;
    const corrB = all.find((e) => e.corrects != null && e.object_id === "m-b")!;
    expect(corrA.evidence_refs).toEqual(["mission:m-a", "job:j-a"]);
    expect(corrB.evidence_refs).toEqual(["mission:m-b", "job:j-b"]);
    expect(corrA.evidence_refs).not.toContain("job:j-b");
    expect(corrA.evidence_refs).not.toContain("job:j-unrelated");
    f.events.close();
    f.missions.close();
  });

  it("leaves completions alone when the mission row is gone or has no linked jobs", () => {
    const f = setup();
    legacyCompletion(f, "m-gone", "2026-10-01T12:00:00.000Z");
    seedMission(f, "m-empty", [], "2026-10-02T12:00:00.000Z");
    legacyCompletion(f, "m-empty", "2026-10-02T12:00:00.000Z");
    const r = f.events.backfillMissionEvidence(f.missions);
    expect(r).toMatchObject({ scanned: 0, corrected: 0, already_ok: 0 });
    expect(f.events.count()).toBe(2);
    f.events.close();
    f.missions.close();
  });

  it("correction inherits the original event's sensitivity and append-only fields", () => {
    const f = setup();
    seedMission(f, "m-1", ["j-1"], "2026-10-01T12:00:00.000Z");
    const orig = legacyCompletion(f, "m-1", "2026-10-01T12:00:00.000Z", "private");

    f.events.backfillMissionEvidence(f.missions);
    const all = f.events.allEvents();
    const correction = all.find((e) => e.corrects === orig.event_id)!;
    expect(correction.sensitivity).toBe("private");
    expect(correction.confidence).toBe(orig.confidence);
    expect(correction.occurred_at).toBe(orig.occurred_at);
    expect(correction.from_state).toBe(orig.from_state);
    expect(correction.to_state).toBe(orig.to_state);

    // Append-only: the original row is untouched.
    const stillThere = all.find((e) => e.event_id === orig.event_id)!;
    expect(stillThere.evidence_refs).toEqual(["mission:m-1"]);
    expect(stillThere.corrects).toBeNull();
    f.events.close();
    f.missions.close();
  });

  it("dry run writes nothing but reports would-be corrections", () => {
    const f = setup();
    seedMission(f, "m-1", ["j-1"], "2026-10-01T12:00:00.000Z");
    legacyCompletion(f, "m-1", "2026-10-01T12:00:00.000Z");
    const r = f.events.backfillMissionEvidence(f.missions, { dryRun: true });
    expect(r).toMatchObject({ scanned: 1, corrected: 1, already_ok: 0, dry_run: true });
    expect(f.events.count()).toBe(1);
    f.events.close();
    f.missions.close();
  });
});
