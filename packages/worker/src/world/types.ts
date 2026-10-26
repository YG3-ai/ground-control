import type { EventSensitivity } from "../events/types.js";

/**
 * Living world model ("Ground Life Mirror", Phase 2) — a derived, fully
 * rebuildable projection of the event spine. Doctrine: source stores and
 * Second Brain stay canonical; the world model is an index, never a source
 * of truth. WorldFacts carry evidence_event_ids and stay separate from the
 * InterpretationCandidate seam (Phase 3, ../meaning/types.ts) — facts here are
 * provable from events only; no inferred biography, purpose, badge, capability, or
 * private identity claims.
 */

export type EntityType =
  | "person"
  | "agent"
  | "organization"
  | "mission"
  | "service";

export type WorldEntity = {
  entity_id: string;
  entity_type: EntityType;
  /** Content-free label derived from stable ids only (never names/titles). */
  label: string;
  state: string | null;
  sensitivity: EventSensitivity;
  first_seen_at: string;
  last_seen_at: string;
};

export type WorldFact = {
  entity_id: string;
  key: string;
  value: string;
  sensitivity: EventSensitivity;
  evidence_event_ids: string[];
  /** occurred_at of the newest contributing event — deterministic. */
  updated_at: string;
};

export type WorldRelation = {
  relation_id: string;
  kind: string;
  from_entity: string;
  to_entity: string;
  sensitivity: EventSensitivity;
  evidence_event_ids: string[];
};

/** History reference: pointer back into the event spine (no content). */
export type WorldHistoryRef = {
  entity_id: string;
  event_id: string;
  occurred_at: string;
  verb: string;
  from_state: string | null;
  to_state: string | null;
  superseded: boolean;
};

export type WorldProjection = {
  entities: WorldEntity[];
  aliases: { alias: string; entity_id: string }[];
  facts: WorldFact[];
  relations: WorldRelation[];
  history: WorldHistoryRef[];
};

export type WorldSummary = {
  generated_from_events: number;
  superseded_events: number;
  entities_total: number;
  by_type: Record<string, number>;
  by_state: Record<string, number>;
  facts_total: number;
  relations_total: number;
};
