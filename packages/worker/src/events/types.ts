export type EventSource =
  | "missions"
  | "jobs"
  | "approvals"
  | "sessions"
  | "usage"
  | "growth"
  | "second_brain"
  | (string & {});

export type EventSensitivity = "public" | "internal" | "private";

export type EventActor = "owner" | "system" | `agent:${string}` | null;

/**
 * A normalized fact. References and small safe metadata ONLY —
 * never prompt bodies, note bodies, email bodies, logs, or approval detail text.
 */
export type EventRecord = {
  event_id: string;
  occurred_at: string;
  observed_at: string;
  source: EventSource;
  source_ref: string;
  actor: EventActor;
  verb: string;
  object_type: string | null;
  object_id: string | null;
  from_state: string | null;
  to_state: string | null;
  evidence_refs: string[];
  confidence: number;
  sensitivity: EventSensitivity;
  schema_version: number;
  adapter_version: number;
  corrects: string | null;
};

export type NewEvent = {
  occurredAt?: string;
  observedAt?: string;
  source: EventSource;
  sourceRef: string;
  actor?: EventActor;
  verb: string;
  objectType?: string | null;
  objectId?: string | null;
  fromState?: string | null;
  toState?: string | null;
  evidenceRefs?: string[];
  confidence?: number;
  sensitivity?: EventSensitivity;
  schemaVersion?: number;
  adapterVersion?: number;
  corrects?: string | null;
  /**
   * Stable, content-free key that makes the derived event_id deterministic.
   * Same (adapterVersion, source, sourceRef, verb, dedupeKey) → same event_id.
   */
  dedupeKey: string;
};

export type EventSink = (e: NewEvent) => void;

// Phase 3 seam lives in ../meaning/types.ts (InterpretationCandidate).
// Interpretations are DERIVED from events, proposed to the owner, and live
// outside the events table. Events stay raw; meaning stays confirmable.
