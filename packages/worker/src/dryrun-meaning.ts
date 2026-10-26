// Dry-run: meaning engine over a COPY of the live events.db. Counts only.
// Pass --missions <missions.db copy> to first apply the mission-evidence
// backfill to the COPY (never the live db) so the run reflects the fix.
import Database from "better-sqlite3";
import { EventStore } from "./events/store.js";
import { MissionStore } from "./missions/store.js";
import { projectWorld } from "./world/project.js";
import { runRules } from "./meaning/engine.js";
import type { EventRecord } from "./events/types.js";

const args = process.argv.slice(2);
const dbPath = args[0];
if (!dbPath || dbPath.startsWith("--")) {
  throw new Error(
    "usage: tsx dryrun-meaning.ts <events.db copy> [--missions <missions.db copy>]",
  );
}
let missionsPath: string | null = null;
for (let i = 1; i < args.length; i++) {
  if (args[i] === "--missions") missionsPath = args[++i] ?? null;
}

let events: EventRecord[];
let backfill: Record<string, number> | undefined;
if (missionsPath) {
  const store = new EventStore(dbPath);
  const missions = new MissionStore(missionsPath);
  const r = store.backfillMissionEvidence(missions, { dryRun: false });
  backfill = {
    scanned: r.scanned,
    corrected: r.corrected,
    already_ok: r.already_ok,
  };
  events = store.allEvents();
  missions.close();
  store.close();
} else {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const rows = db
    .prepare(`SELECT * FROM events ORDER BY occurred_at ASC, event_id ASC`)
    .all() as (Omit<EventRecord, "evidence_refs"> & { evidence_refs: string })[];
  events = rows.map((r) => ({
    ...r,
    evidence_refs: JSON.parse(r.evidence_refs) as string[],
  }));
  db.close();
}

const candidates = runRules(events, projectWorld(events));
const by: Record<string, Record<string, number>> = {};
for (const c of candidates) {
  by[c.rule_id] ??= {};
  const key = `${c.kind}/${c.sensitivity}${c.maturity ? `/${c.maturity}` : ""}`;
  by[c.rule_id]![key] = (by[c.rule_id]![key] ?? 0) + 1;
}
console.log(
  JSON.stringify(
    {
      events_total: events.length,
      ...(backfill ? { mission_evidence_backfill: backfill } : {}),
      candidates_total: candidates.length,
      by_rule: by,
    },
    null,
    2,
  ),
);
