import type { EventRecord } from "../events/types.js";
import { projectWorld } from "../world/project.js";
import type { WorldProjection } from "../world/types.js";
import { RULES } from "./rules.js";
import type { MeaningStore } from "./store.js";
import type { InterpretationCandidate, MeaningRebuildReport } from "./types.js";

/**
 * Rules run over LIVE events only: superseded events (targeted by another
 * event's `corrects`) are excluded before rules see them, so a rule can never
 * cite evidence the owner has already corrected away.
 */
export function runRules(
  events: EventRecord[],
  projection: WorldProjection,
): InterpretationCandidate[] {
  const superseded = new Set<string>();
  for (const e of events) {
    if (e.corrects) superseded.add(e.corrects);
  }
  const live = events
    .filter((e) => !superseded.has(e.event_id))
    .sort((a, b) =>
      a.occurred_at === b.occurred_at
        ? a.event_id.localeCompare(b.event_id)
        : a.occurred_at.localeCompare(b.occurred_at),
    );
  const out: InterpretationCandidate[] = [];
  for (const rule of RULES) {
    out.push(...rule.run({ events: live, projection }));
  }
  return out.sort((a, b) => a.candidate_id.localeCompare(b.candidate_id));
}

/**
 * Full deterministic re-materialization of meaning.db from the event spine:
 * regenerate candidates, wipe+rewrite the candidates table, re-apply the
 * durable decision overlay, and return COUNTS ONLY. Idempotent — two
 * consecutive rebuilds over unchanged events produce identical candidate rows.
 */
export function rebuildMeaning(deps: {
  events: EventRecord[];
  store: MeaningStore;
}): MeaningRebuildReport {
  const projection = projectWorld(deps.events);
  const candidates = runRules(deps.events, projection);
  deps.store.replaceCandidates(candidates);
  return deps.store.countReport(candidates);
}
