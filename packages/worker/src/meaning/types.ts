import type { EventSensitivity } from "../events/types.js";

/**
 * Meaning engine ("Ground Life Mirror", Phase 3). Interpretations are DERIVED
 * from the event spine, proposed to the owner, and live outside the events
 * table. Events stay raw; meaning stays confirmable. Candidates carry no
 * permission, authority, or capability-to-act fields — they are descriptions
 * of the past, never grants of power.
 */

export type CandidateKind = "capability" | "turning_point" | "chapter" | "badge";

export type CandidateStatus =
  | "proposed"
  | "accepted"
  | "dismissed"
  | "corrected"
  | "superseded";

export type CapabilityMaturity = "acquired" | "reliable" | "hardened";

export type InterpretationCandidate = {
  /** Deterministic: hash of rule identity + kind + sorted ids. */
  candidate_id: string;
  kind: CandidateKind;
  /** Generic, content-free label — never derived from titles/bodies. */
  proposed_label: string;
  proposed_description?: string;
  status: CandidateStatus;
  /** Deterministic, rule-explainable, 0..1. */
  confidence: number;
  /** Capability kind only. */
  maturity?: CapabilityMaturity;
  entity_ids: string[];
  evidence_event_ids: string[];
  rule_id: string;
  rule_version: number;
  /** private if ANY evidence event is private. */
  sensitivity: EventSensitivity;
  /** Derived from evidence timestamps — rebuild-stable, never wall clock. */
  proposed_at: string;
  updated_at: string;
  accepted_at?: string | null;
  corrected_label?: string | null;
  correction_note?: string | null;
  supersedes?: string | null;
  corrects?: string | null;
};

export type CandidateDecisionAction = "accept" | "dismiss" | "correct";

/**
 * Durable owner overlay. Lives in the decisions table, NEVER wiped by a
 * rebuild: keyed by deterministic candidate_id, so a rebuild that regenerates
 * the same candidate re-applies it. A candidate whose evidence changed gets a
 * new id and starts as proposed again.
 */
export type InterpretationDecision = {
  candidate_id: string;
  decision: CandidateDecisionAction;
  corrected_label: string | null;
  correction_note: string | null;
  decided_at: string;
  decided_by: string;
};

export type CandidateFilters = {
  kind?: CandidateKind;
  status?: CandidateStatus;
  sensitivity?: EventSensitivity;
  includePrivate?: boolean;
};

/** Content-free evidence pointer returned by getCandidate — never bodies. */
export type EvidenceSummary = {
  event_id: string;
  verb: string;
  occurred_at: string;
  sensitivity: EventSensitivity;
  source?: string;
  /** Stable id in the source store (e.g. mission uuid, job id). */
  source_ref?: string;
  object_type?: string | null;
  object_id?: string | null;
  from_state?: string | null;
  to_state?: string | null;
};

/** Counts-only rebuild report. Never carries candidate content. */
export type MeaningRebuildReport = {
  candidates_total: number;
  by_kind: Record<string, number>;
  by_sensitivity: Record<EventSensitivity, number>;
  by_rule_id: Record<string, number>;
};
