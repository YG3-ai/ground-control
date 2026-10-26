import { createHash } from "node:crypto";
import type { EventRecord, EventSensitivity } from "../events/types.js";
import { deriveEntityId } from "../world/project.js";
import type { WorldProjection } from "../world/types.js";
import type {
  CapabilityMaturity,
  CandidateKind,
  InterpretationCandidate,
} from "./types.js";

const SENS_RANK: Record<EventSensitivity, number> = {
  public: 0,
  internal: 1,
  private: 2,
};

function maxSens(list: EventSensitivity[]): EventSensitivity {
  let out: EventSensitivity = "public";
  for (const s of list) if (SENS_RANK[s] > SENS_RANK[out]) out = s;
  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Deterministic UUID-shaped id from rule identity + kind + sorted ids. */
export function deriveCandidateId(input: {
  ruleId: string;
  ruleVersion: number;
  kind: CandidateKind;
  entityIds: string[];
  evidenceEventIds: string[];
}): string {
  const hex = createHash("sha256")
    .update(
      [
        "candidate",
        input.ruleId,
        String(input.ruleVersion),
        input.kind,
        [...input.entityIds].sort().join(","),
        [...input.evidenceEventIds].sort().join(","),
      ].join("|"),
    )
    .digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

export type RuleContext = {
  /** Live (non-superseded) events, sorted occurred_at ASC, event_id ASC. */
  events: EventRecord[];
  projection: WorldProjection;
};

export type RuleExplanation = {
  rule_id: string;
  rule_version: number;
  kind: CandidateKind;
  explanation: string;
  thresholds: Record<string, number | string>;
};

export type Rule = RuleExplanation & {
  run(ctx: RuleContext): InterpretationCandidate[];
};

const JOB_FAILURE_STATES = new Set(["failed", "timed_out", "cancelled"]);

function isCompletion(e: EventRecord): boolean {
  return (
    e.verb === "mission.status_changed" &&
    e.to_state === "done" &&
    e.object_type === "mission" &&
    e.object_id != null
  );
}

function isJobFailure(e: EventRecord): boolean {
  return (
    e.source === "jobs" &&
    e.verb === "job.status_changed" &&
    e.to_state != null &&
    JOB_FAILURE_STATES.has(e.to_state)
  );
}

function isJobSuccess(e: EventRecord): boolean {
  return (
    e.source === "jobs" &&
    e.verb === "job.status_changed" &&
    e.to_state === "succeeded"
  );
}

function linkedJobIds(e: EventRecord): string[] {
  return e.evidence_refs
    .filter((r) => r.startsWith("job:"))
    .map((r) => r.slice("job:".length));
}

function buildCandidate(input: {
  rule: RuleExplanation;
  kind: CandidateKind;
  label: string;
  description?: string;
  confidence: number;
  maturity?: CapabilityMaturity;
  entityIds: string[];
  evidence: EventRecord[];
  projection: WorldProjection;
}): InterpretationCandidate | null {
  const entitySet = new Set(input.projection.entities.map((e) => e.entity_id));
  const entityIds = [...new Set(input.entityIds)].filter((id) =>
    entitySet.has(id),
  );
  if (entityIds.length === 0 || input.evidence.length === 0) return null;
  const evidenceIds = [...new Set(input.evidence.map((e) => e.event_id))].sort();
  const times = input.evidence.map((e) => e.occurred_at).sort();
  return {
    candidate_id: deriveCandidateId({
      ruleId: input.rule.rule_id,
      ruleVersion: input.rule.rule_version,
      kind: input.kind,
      entityIds,
      evidenceEventIds: evidenceIds,
    }),
    kind: input.kind,
    proposed_label: input.label,
    proposed_description: input.description,
    status: "proposed",
    confidence: input.confidence,
    maturity: input.maturity,
    entity_ids: entityIds.sort(),
    evidence_event_ids: evidenceIds,
    rule_id: input.rule.rule_id,
    rule_version: input.rule.rule_version,
    sensitivity: maxSens(input.evidence.map((e) => e.sensitivity)),
    proposed_at: times[0]!,
    updated_at: times[times.length - 1]!,
    accepted_at: null,
    corrected_label: null,
    correction_note: null,
    supersedes: null,
    corrects: null,
  };
}

type Recovery = {
  missionId: string;
  failures: EventRecord[];
  completion: EventRecord;
};

/**
 * Per mission: job failure/interruption events for a job linked to the
 * mission (via `job:<id>` evidence refs on the completion event), followed
 * chronologically by the mission reaching `done`.
 */
function findRecoveries(events: EventRecord[]): Recovery[] {
  const completions = events.filter(isCompletion);
  const failures = events.filter(isJobFailure);
  const out: Recovery[] = [];
  for (const c of completions) {
    const jobIds = new Set(linkedJobIds(c));
    if (jobIds.size === 0) continue;
    const fs = failures.filter(
      (f) =>
        f.object_id != null &&
        jobIds.has(f.object_id) &&
        f.occurred_at < c.occurred_at,
    );
    if (fs.length > 0) {
      out.push({ missionId: c.object_id!, failures: fs, completion: c });
    }
  }
  return out;
}

const HOUR_MS = 3_600_000;

const recoveryAfterFailure: Rule = {
  rule_id: "recovery_after_failure",
  rule_version: 1,
  kind: "turning_point",
  explanation:
    "One candidate per mission where a linked job event shows failure/interruption " +
    "(job.status_changed to failed|timed_out|cancelled) followed chronologically by " +
    "the mission reaching done (mission.status_changed to done carrying job:<id> " +
    "evidence refs). Evidence = the failure events plus the completion event. " +
    "confidence = min(0.9, 0.6 + 0.05*min(failures,4) + proximity) where proximity " +
    "is 0.1 if recovery landed within 24h of the last failure, 0.05 within 7d, else 0.",
  thresholds: {
    failure_states: "failed|timed_out|cancelled",
    base_confidence: 0.6,
    per_failure_bonus: 0.05,
    max_failure_bonus_count: 4,
    proximity_24h_bonus: 0.1,
    proximity_7d_bonus: 0.05,
    max_confidence: 0.9,
  },
  run(ctx) {
    const out: InterpretationCandidate[] = [];
    for (const r of findRecoveries(ctx.events)) {
      const lastFailure = r.failures[r.failures.length - 1]!;
      const gapMs =
        Date.parse(r.completion.occurred_at) -
        Date.parse(lastFailure.occurred_at);
      const proximity =
        gapMs <= 24 * HOUR_MS ? 0.1 : gapMs <= 7 * 24 * HOUR_MS ? 0.05 : 0;
      const confidence = round2(
        Math.min(0.9, 0.6 + 0.05 * Math.min(r.failures.length, 4) + proximity),
      );
      const c = buildCandidate({
        rule: recoveryAfterFailure,
        kind: "turning_point",
        label: "Recovered after failure",
        description:
          "The mission hit a job failure and later reached completion.",
        confidence,
        entityIds: [deriveEntityId(`mission:${r.missionId}`)],
        evidence: [...r.failures, r.completion],
        projection: ctx.projection,
      });
      if (c) out.push(c);
    }
    return out;
  },
};

/**
 * Distinct missions that reached done WITH successful job evidence: a linked
 * job (job:<id> evidence ref on the completion event) that has a
 * job.status_changed to succeeded event.
 */
function completedMissionsWithSuccess(events: EventRecord[]): {
  missionId: string;
  completion: EventRecord;
  successes: EventRecord[];
}[] {
  const successes = events.filter(isJobSuccess);
  const out: {
    missionId: string;
    completion: EventRecord;
    successes: EventRecord[];
  }[] = [];
  for (const c of events.filter(isCompletion)) {
    const jobIds = new Set(linkedJobIds(c));
    if (jobIds.size === 0) continue;
    const ss = successes.filter(
      (s) => s.object_id != null && jobIds.has(s.object_id),
    );
    if (ss.length > 0) {
      out.push({ missionId: c.object_id!, completion: c, successes: ss });
    }
  }
  return out;
}

const reliableDelivery: Rule = {
  rule_id: "reliable_delivery",
  rule_version: 1,
  kind: "capability",
  explanation:
    "Counts DISTINCT missions that reached done with successful job evidence " +
    "(a linked job with a job.status_changed to succeeded event). Maturity " +
    "ladder: acquired at >=3, reliable at >=7, hardened at >=15 completed " +
    "missions AND >=1 observed recovery_after_failure pattern. Emits ONE " +
    "capability candidate at the highest justified maturity; nothing below " +
    "acquired. confidence is fixed per maturity: acquired 0.6, reliable 0.75, " +
    "hardened 0.9. Labels are generic — never title-derived.",
  thresholds: {
    acquired_min_completed_missions: 3,
    reliable_min_completed_missions: 7,
    hardened_min_completed_missions: 15,
    hardened_min_recoveries: 1,
    confidence_acquired: 0.6,
    confidence_reliable: 0.75,
    confidence_hardened: 0.9,
  },
  run(ctx) {
    const completed = completedMissionsWithSuccess(ctx.events);
    const count = completed.length;
    const recoveries = findRecoveries(ctx.events).length;
    let maturity: CapabilityMaturity | null = null;
    if (count >= 15 && recoveries >= 1) maturity = "hardened";
    else if (count >= 7) maturity = "reliable";
    else if (count >= 3) maturity = "acquired";
    if (!maturity) return [];
    const confidence =
      maturity === "hardened" ? 0.9 : maturity === "reliable" ? 0.75 : 0.6;
    const evidence = completed.flatMap((m) => [m.completion, ...m.successes]);
    const c = buildCandidate({
      rule: reliableDelivery,
      kind: "capability",
      label: "Reliable mission delivery",
      description:
        "Missions repeatedly reach completion with successful job evidence.",
      confidence,
      maturity,
      entityIds: [deriveEntityId("actor:owner")],
      evidence,
      projection: ctx.projection,
    });
    return c ? [c] : [];
  },
};

const selfRunningSystem: Rule = {
  rule_id: "self_running_system",
  rule_version: 1,
  kind: "capability",
  explanation:
    "Hardened-only capability. Emitted only when >=10 distinct missions " +
    "completed with successful job evidence, >=80% of them completed with NO " +
    "linked job failure events at all, and >=2 recovery_after_failure " +
    "patterns were observed. If any condition is not provable, nothing is " +
    "emitted. confidence = min(0.95, round2(0.7 + 0.25 * clean_fraction)).",
  thresholds: {
    min_completed_missions: 10,
    min_clean_fraction: 0.8,
    min_recoveries: 2,
    base_confidence: 0.7,
    clean_fraction_weight: 0.25,
    max_confidence: 0.95,
  },
  run(ctx) {
    const completed = completedMissionsWithSuccess(ctx.events);
    if (completed.length < 10) return [];
    const failures = ctx.events.filter(isJobFailure);
    const clean = completed.filter((m) => {
      const jobIds = new Set(linkedJobIds(m.completion));
      return !failures.some(
        (f) => f.object_id != null && jobIds.has(f.object_id),
      );
    });
    const cleanFraction = clean.length / completed.length;
    const recoveries = findRecoveries(ctx.events).length;
    if (cleanFraction < 0.8 || recoveries < 2) return [];
    const confidence = round2(Math.min(0.95, 0.7 + 0.25 * cleanFraction));
    const evidence = completed.flatMap((m) => [m.completion, ...m.successes]);
    const c = buildCandidate({
      rule: selfRunningSystem,
      kind: "capability",
      label: "Self-running mission pipeline",
      description:
        "Missions complete largely without intervention, and the few failures " +
        "that occurred were recovered.",
      confidence,
      maturity: "hardened",
      entityIds: [deriveEntityId("actor:owner")],
      evidence,
      projection: ctx.projection,
    });
    return c ? [c] : [];
  },
};

/**
 * Versioned rule catalogue. Conservative by design: a rule prefers zero
 * candidates over a weak one. No rule emits kind "badge" in v1 — badges are
 * doctrine-suspect — the kind stays in the type for future use.
 */
export const RULES: Rule[] = [
  recoveryAfterFailure,
  reliableDelivery,
  selfRunningSystem,
];

export const RULE_CATALOG: RuleExplanation[] = RULES.map(
  ({ rule_id, rule_version, kind, explanation, thresholds }) => ({
    rule_id,
    rule_version,
    kind,
    explanation,
    thresholds,
  }),
);
