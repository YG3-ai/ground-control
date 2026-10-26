import { createHash } from "node:crypto";
import type { EventRecord, EventSensitivity } from "../events/types.js";
import type {
  EntityType,
  WorldEntity,
  WorldFact,
  WorldHistoryRef,
  WorldProjection,
  WorldRelation,
} from "./types.js";

const SENS_RANK: Record<EventSensitivity, number> = {
  public: 0,
  internal: 1,
  private: 2,
};

function maxSens(a: EventSensitivity, b: EventSensitivity): EventSensitivity {
  return SENS_RANK[b] > SENS_RANK[a] ? b : a;
}

/** Deterministic UUID-shaped id from the entity's canonical alias. */
export function deriveEntityId(canonicalAlias: string): string {
  const hex = createHash("sha256").update(`entity|${canonicalAlias}`).digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

function deriveRelationId(
  kind: string,
  fromEntity: string,
  toEntity: string,
): string {
  const hex = createHash("sha256")
    .update(`relation|${kind}|${fromEntity}|${toEntity}`)
    .digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

type EntityAcc = {
  entity_id: string;
  entity_type: EntityType;
  label: string;
  state: string | null;
  /** null = untouched yet; first real event sensitivity wins then maxes. */
  sensitivity: EventSensitivity;
  sensitivityLocked: boolean;
  first_seen_at: string;
  last_seen_at: string;
};

type FactAcc = {
  entity_id: string;
  key: string;
  value: string;
  sensitivity: EventSensitivity;
  evidence: Set<string>;
  updated_at: string;
};

type RelationAcc = {
  relation_id: string;
  kind: string;
  from_entity: string;
  to_entity: string;
  sensitivity: EventSensitivity;
  evidence: Set<string>;
};

const EVIDENCE_CAP = 50;

/**
 * Pure, deterministic projection: same events in → same world out.
 * Entities are only created where events prove them: actors (owner/system/
 * agents), mission objects, clients referenced by client-request evidence,
 * and one service entity per event source. Jobs, approvals, sessions and
 * metric rows are deliberately NOT entities in Phase 2 — they are evidence.
 */
export function projectWorld(events: EventRecord[]): WorldProjection {
  const sorted = [...events].sort((a, b) =>
    a.occurred_at === b.occurred_at
      ? a.event_id.localeCompare(b.event_id)
      : a.occurred_at.localeCompare(b.occurred_at),
  );

  // Corrections: an event whose id is referenced by another event's
  // `corrects` is superseded — kept in history, excluded from current state.
  const supersededIds = new Set<string>();
  for (const e of sorted) {
    if (e.corrects) supersededIds.add(e.corrects);
  }

  const entities = new Map<string, EntityAcc>(); // keyed by canonical alias
  const facts = new Map<string, FactAcc>(); // keyed `${alias}|${key}`
  const relations = new Map<string, RelationAcc>(); // keyed relation_id
  const history: WorldHistoryRef[] = [];

  const ensure = (
    alias: string,
    type: EntityType,
    label: string,
    at: string,
    sensitivity: EventSensitivity,
    sensitivityLocked: boolean,
  ): EntityAcc => {
    let e = entities.get(alias);
    if (!e) {
      e = {
        entity_id: deriveEntityId(alias),
        entity_type: type,
        label,
        state: null,
        sensitivity,
        sensitivityLocked,
        first_seen_at: at,
        last_seen_at: at,
      };
      entities.set(alias, e);
      return e;
    }
    if (at < e.first_seen_at) e.first_seen_at = at;
    if (at > e.last_seen_at) e.last_seen_at = at;
    if (!e.sensitivityLocked) {
      e.sensitivity = maxSens(e.sensitivity, sensitivity);
    }
    return e;
  };

  const touchHistory = (
    acc: EntityAcc,
    e: EventRecord,
    superseded: boolean,
  ): void => {
    history.push({
      entity_id: acc.entity_id,
      event_id: e.event_id,
      occurred_at: e.occurred_at,
      verb: e.verb,
      from_state: e.from_state,
      to_state: e.to_state,
      superseded,
    });
  };

  const addFact = (
    acc: EntityAcc,
    alias: string,
    key: string,
    value: string,
    e: EventRecord,
  ): void => {
    const fk = `${alias}|${key}`;
    let f = facts.get(fk);
    if (!f) {
      f = {
        entity_id: acc.entity_id,
        key,
        value,
        sensitivity: e.sensitivity,
        evidence: new Set(),
        updated_at: e.occurred_at,
      };
      facts.set(fk, f);
    }
    f.value = value;
    f.sensitivity = maxSens(f.sensitivity, e.sensitivity);
    if (f.evidence.size < EVIDENCE_CAP) f.evidence.add(e.event_id);
    if (e.occurred_at > f.updated_at) f.updated_at = e.occurred_at;
  };

  const bumpCounter = (
    acc: EntityAcc,
    alias: string,
    key: string,
    e: EventRecord,
  ): void => {
    const fk = `${alias}|${key}`;
    const cur = facts.get(fk);
    const next = String((cur ? Number(cur.value) || 0 : 0) + 1);
    addFact(acc, alias, key, next, e);
  };

  const addRelation = (
    kind: string,
    fromAcc: EntityAcc,
    toAcc: EntityAcc,
    e: EventRecord,
  ): void => {
    const id = deriveRelationId(kind, fromAcc.entity_id, toAcc.entity_id);
    let r = relations.get(id);
    if (!r) {
      r = {
        relation_id: id,
        kind,
        from_entity: fromAcc.entity_id,
        to_entity: toAcc.entity_id,
        sensitivity: e.sensitivity,
        evidence: new Set(),
      };
      relations.set(id, r);
    }
    r.sensitivity = maxSens(r.sensitivity, e.sensitivity);
    if (r.evidence.size < EVIDENCE_CAP) r.evidence.add(e.event_id);
  };

  for (const e of sorted) {
    const superseded = supersededIds.has(e.event_id);

    // One service entity per source (system/services represented by sources).
    const service = ensure(
      `service:${e.source}`,
      "service",
      e.source,
      e.occurred_at,
      "internal",
      true,
    );
    touchHistory(service, e, superseded);
    if (!superseded) {
      bumpCounter(service, `service:${e.source}`, "events_count", e);
      addFact(service, `service:${e.source}`, "last_event_at", e.occurred_at, e);
    }

    // Actor entities. Actor-only entities are operational identity ("owner",
    // "system", "agent:<name>") — internal regardless of event sensitivity;
    // the sensitive part is what they touched, which lives on private facts.
    let actorAcc: EntityAcc | null = null;
    let actorAlias: string | null = null;
    if (e.actor === "owner") {
      actorAlias = "actor:owner";
      actorAcc = ensure(actorAlias, "person", "owner", e.occurred_at, "internal", true);
    } else if (e.actor === "system") {
      actorAlias = "actor:system";
      actorAcc = ensure(actorAlias, "service", "system", e.occurred_at, "internal", true);
    } else if (e.actor && e.actor.startsWith("agent:")) {
      const name = e.actor.slice("agent:".length);
      actorAlias = `agent:${name}`;
      actorAcc = ensure(actorAlias, "agent", name, e.occurred_at, "internal", true);
    }
    if (actorAcc && actorAlias) {
      touchHistory(actorAcc, e, superseded);
      if (!superseded) {
        addFact(actorAcc, actorAlias, "last_active_at", e.occurred_at, e);
      }
    }

    // Mission objects.
    let missionAcc: EntityAcc | null = null;
    let missionAlias: string | null = null;
    if (e.object_type === "mission" && e.object_id) {
      missionAlias = `mission:${e.object_id}`;
      missionAcc = ensure(
        missionAlias,
        "mission",
        `mission ${e.object_id.slice(0, 8)}`,
        e.occurred_at,
        "internal",
        true,
      );
      touchHistory(missionAcc, e, superseded);
      if (!superseded) {
        if (e.verb === "mission.created" && actorAcc) {
          addRelation("created_by", missionAcc, actorAcc, e);
        }
        if (
          (e.verb === "mission.status_changed" ||
            e.verb === "mission.status_current") &&
          e.to_state
        ) {
          missionAcc.state = e.to_state;
          addFact(missionAcc, missionAlias, "status", e.to_state, e);
          if (e.to_state === "approved" && actorAcc) {
            addRelation("approved_by", missionAcc, actorAcc, e);
          }
        }
      }
    }

    // Client/organization entities — proven only by client-request evidence
    // refs (`client:<id>`). Private by construction.
    const clientIds = e.evidence_refs
      .filter((r) => r.startsWith("client:"))
      .map((r) => r.slice("client:".length));
    for (const clientId of clientIds) {
      const alias = `client:${clientId}`;
      const org = ensure(alias, "organization", clientId, e.occurred_at, "private", true);
      touchHistory(org, e, superseded);
      if (superseded) continue;
      bumpCounter(org, alias, "requests_count", e);
      addFact(org, alias, "last_request_at", e.occurred_at, e);
      if (e.verb === "client_request.created" && actorAcc) {
        addRelation("filed_request_for", actorAcc, org, e);
      }
      if (e.evidence_refs.some((r) => r.startsWith("mission:")) && missionAcc == null) {
        const missionRef = e.evidence_refs
          .find((r) => r.startsWith("mission:"))!
          .slice("mission:".length);
        const linkedAlias = `mission:${missionRef}`;
        const linked = ensure(
          linkedAlias,
          "mission",
          `mission ${missionRef.slice(0, 8)}`,
          e.occurred_at,
          "internal",
          true,
        );
        touchHistory(linked, e, superseded);
        addRelation("served_by", org, linked, e);
      }
    }

    // Session lifecycle: actor → sessions service relation (metadata only).
    if (e.source === "sessions" && e.verb === "session.created" && actorAcc) {
      if (!superseded) {
        addRelation("opened_session", actorAcc, service, e);
        bumpCounter(actorAcc, actorAlias!, "sessions_opened", e);
      }
    }

    // Usage ledger counters per agent (kind only — never detail text).
    if (e.source === "usage" && actorAcc && actorAlias && !superseded) {
      const kind = e.verb.replace("usage.", "");
      bumpCounter(actorAcc, actorAlias, `usage_${kind}`, e);
    }

    // Job events: agent counters (private facts; the agent entity itself
    // stays internal — only the facts carry private sensitivity).
    if (e.source === "jobs" && actorAcc && actorAlias && !superseded) {
      if (e.verb === "job.created") {
        bumpCounter(actorAcc, actorAlias, "jobs_created", e);
      } else if (e.verb === "job.status_changed" && e.to_state) {
        addFact(actorAcc, actorAlias, "last_job_state", e.to_state, e);
      }
    }
  }

  const outEntities: WorldEntity[] = [...entities.values()]
    .map((e) => ({
      entity_id: e.entity_id,
      entity_type: e.entity_type,
      label: e.label,
      state: e.state,
      sensitivity: e.sensitivity,
      first_seen_at: e.first_seen_at,
      last_seen_at: e.last_seen_at,
    }))
    .sort((a, b) => a.entity_id.localeCompare(b.entity_id));

  const outAliases = [...entities.entries()]
    .map(([alias, e]) => ({ alias, entity_id: e.entity_id }))
    .sort((a, b) => a.alias.localeCompare(b.alias));

  const outFacts: WorldFact[] = [...facts.values()]
    .map((f) => ({
      entity_id: f.entity_id,
      key: f.key,
      value: f.value,
      sensitivity: f.sensitivity,
      evidence_event_ids: [...f.evidence].sort(),
      updated_at: f.updated_at,
    }))
    .sort((a, b) =>
      a.entity_id === b.entity_id
        ? a.key.localeCompare(b.key)
        : a.entity_id.localeCompare(b.entity_id),
    );

  const outRelations: WorldRelation[] = [...relations.values()]
    .map((r) => ({
      relation_id: r.relation_id,
      kind: r.kind,
      from_entity: r.from_entity,
      to_entity: r.to_entity,
      sensitivity: r.sensitivity,
      evidence_event_ids: [...r.evidence].sort(),
    }))
    .sort((a, b) => a.relation_id.localeCompare(b.relation_id));

  return {
    entities: outEntities,
    aliases: outAliases,
    facts: outFacts,
    relations: outRelations,
    history,
  };
}
