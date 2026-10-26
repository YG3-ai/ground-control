import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { EventRecord, EventSensitivity } from "../events/types.js";
import { projectWorld } from "./project.js";
import type {
  WorldEntity,
  WorldFact,
  WorldHistoryRef,
  WorldProjection,
  WorldRelation,
  WorldSummary,
} from "./types.js";

export const WORLD_SCHEMA_VERSION = 1;

type EntityRow = {
  entity_id: string;
  entity_type: string;
  label: string;
  state: string | null;
  sensitivity: string;
  first_seen_at: string;
  last_seen_at: string;
};

type FactRow = {
  entity_id: string;
  key: string;
  value: string;
  sensitivity: string;
  evidence_event_ids: string;
  updated_at: string;
};

type RelationRow = {
  relation_id: string;
  kind: string;
  from_entity: string;
  to_entity: string;
  sensitivity: string;
  evidence_event_ids: string;
};

type HistoryRow = {
  entity_id: string;
  event_id: string;
  occurred_at: string;
  verb: string;
  from_state: string | null;
  to_state: string | null;
  superseded: number;
};

function parseIds(raw: string): string[] {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function rowToEntity(row: EntityRow): WorldEntity {
  return { ...row, entity_type: row.entity_type as WorldEntity["entity_type"], sensitivity: row.sensitivity as EventSensitivity };
}

function rowToFact(row: FactRow): WorldFact {
  return {
    ...row,
    sensitivity: row.sensitivity as EventSensitivity,
    evidence_event_ids: parseIds(row.evidence_event_ids),
  };
}

function rowToRelation(row: RelationRow): WorldRelation {
  return {
    ...row,
    sensitivity: row.sensitivity as EventSensitivity,
    evidence_event_ids: parseIds(row.evidence_event_ids),
  };
}

function rowToHistory(row: HistoryRow): WorldHistoryRef {
  return { ...row, superseded: row.superseded === 1 };
}

/**
 * Rebuildable living-world store (world.db, WAL, beside events.db).
 * Deterministically re-materialized from the event spine; never written to
 * by anything except rebuildFromEvents(). Private entities/facts/relations
 * are stored (the projection is internal) but excluded from query results
 * unless includePrivate=true.
 */
export class WorldStore {
  readonly db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        entity_id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        label TEXT NOT NULL,
        state TEXT,
        sensitivity TEXT NOT NULL DEFAULT 'internal',
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS entities_type_state
        ON entities(entity_type, state);
      CREATE TABLE IF NOT EXISTS entity_aliases (
        alias TEXT PRIMARY KEY,
        entity_id TEXT NOT NULL REFERENCES entities(entity_id)
      );
      CREATE TABLE IF NOT EXISTS entity_facts (
        entity_id TEXT NOT NULL REFERENCES entities(entity_id),
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        sensitivity TEXT NOT NULL DEFAULT 'internal',
        evidence_event_ids TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL,
        PRIMARY KEY (entity_id, key)
      );
      CREATE TABLE IF NOT EXISTS entity_relations (
        relation_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        from_entity TEXT NOT NULL,
        to_entity TEXT NOT NULL,
        sensitivity TEXT NOT NULL DEFAULT 'internal',
        evidence_event_ids TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS entity_history (
        entity_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        verb TEXT NOT NULL,
        from_state TEXT,
        to_state TEXT,
        superseded INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (entity_id, event_id)
      );
      CREATE INDEX IF NOT EXISTS history_entity_time
        ON entity_history(entity_id, occurred_at DESC);
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Full deterministic re-materialization from events. Wipes and rebuilds
   * in one transaction; same events in → byte-identical rows out.
   */
  rebuildFromEvents(events: EventRecord[]): {
    entities: number;
    facts: number;
    relations: number;
    history: number;
  } {
    const projection: WorldProjection = projectWorld(events);
    const tx = this.db.transaction(() => {
      this.db.exec(`
        DELETE FROM entity_history;
        DELETE FROM entity_relations;
        DELETE FROM entity_facts;
        DELETE FROM entity_aliases;
        DELETE FROM entities;
      `);
      const insEntity = this.db.prepare(
        `INSERT INTO entities (entity_id, entity_type, label, state, sensitivity, first_seen_at, last_seen_at)
         VALUES (@entity_id, @entity_type, @label, @state, @sensitivity, @first_seen_at, @last_seen_at)`,
      );
      const insAlias = this.db.prepare(
        `INSERT INTO entity_aliases (alias, entity_id) VALUES (@alias, @entity_id)`,
      );
      const insFact = this.db.prepare(
        `INSERT INTO entity_facts (entity_id, key, value, sensitivity, evidence_event_ids, updated_at)
         VALUES (@entity_id, @key, @value, @sensitivity, @evidence_event_ids, @updated_at)`,
      );
      const insRelation = this.db.prepare(
        `INSERT INTO entity_relations (relation_id, kind, from_entity, to_entity, sensitivity, evidence_event_ids)
         VALUES (@relation_id, @kind, @from_entity, @to_entity, @sensitivity, @evidence_event_ids)`,
      );
      const insHistory = this.db.prepare(
        `INSERT INTO entity_history (entity_id, event_id, occurred_at, verb, from_state, to_state, superseded)
         VALUES (@entity_id, @event_id, @occurred_at, @verb, @from_state, @to_state, @superseded)`,
      );
      for (const e of projection.entities) insEntity.run(e);
      for (const a of projection.aliases) insAlias.run(a);
      for (const f of projection.facts) {
        insFact.run({ ...f, evidence_event_ids: JSON.stringify(f.evidence_event_ids) });
      }
      for (const r of projection.relations) {
        insRelation.run({ ...r, evidence_event_ids: JSON.stringify(r.evidence_event_ids) });
      }
      for (const h of projection.history) {
        insHistory.run({ ...h, superseded: h.superseded ? 1 : 0 });
      }
      this.db
        .prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run(String(WORLD_SCHEMA_VERSION));
    });
    tx();
    return {
      entities: projection.entities.length,
      facts: projection.facts.length,
      relations: projection.relations.length,
      history: projection.history.length,
    };
  }

  resolveAlias(alias: string): string | null {
    const row = this.db
      .prepare(`SELECT entity_id FROM entity_aliases WHERE alias = ?`)
      .get(alias) as { entity_id: string } | undefined;
    return row?.entity_id ?? null;
  }

  listEntities(opts?: {
    type?: string;
    state?: string;
    includePrivate?: boolean;
  }): WorldEntity[] {
    const where: string[] = [];
    const params: Record<string, string> = {};
    if (opts?.type) {
      where.push("entity_type = @type");
      params.type = opts.type;
    }
    if (opts?.state) {
      where.push("state = @state");
      params.state = opts.state;
    }
    if (!opts?.includePrivate) {
      where.push("sensitivity != 'private'");
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM entities ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY entity_type ASC, label ASC`,
      )
      .all(params) as EntityRow[];
    return rows.map(rowToEntity);
  }

  getEntity(
    entityIdOrAlias: string,
    opts?: { includePrivate?: boolean },
  ): {
    entity: WorldEntity;
    aliases: string[];
    facts: WorldFact[];
    relations: WorldRelation[];
    history: WorldHistoryRef[];
  } | null {
    const id = this.resolveAlias(entityIdOrAlias) ?? entityIdOrAlias;
    const row = this.db
      .prepare(`SELECT * FROM entities WHERE entity_id = ?`)
      .get(id) as EntityRow | undefined;
    if (!row) return null;
    const entity = rowToEntity(row);
    if (entity.sensitivity === "private" && !opts?.includePrivate) return null;

    const aliases = (
      this.db
        .prepare(`SELECT alias FROM entity_aliases WHERE entity_id = ? ORDER BY alias`)
        .all(id) as { alias: string }[]
    ).map((r) => r.alias);

    const factRows = this.db
      .prepare(
        `SELECT * FROM entity_facts WHERE entity_id = ?
         ${opts?.includePrivate ? "" : "AND sensitivity != 'private'"}
         ORDER BY key`,
      )
      .all(id) as FactRow[];

    const relRows = this.db
      .prepare(
        `SELECT * FROM entity_relations
         WHERE (from_entity = ? OR to_entity = ?)
         ${opts?.includePrivate ? "" : "AND sensitivity != 'private'"}
         ORDER BY kind`,
      )
      .all(id, id) as RelationRow[];

    const histRows = this.db
      .prepare(
        `SELECT * FROM entity_history WHERE entity_id = ?
         ORDER BY occurred_at DESC, event_id DESC LIMIT 200`,
      )
      .all(id) as HistoryRow[];

    return {
      entity,
      aliases,
      facts: factRows.map(rowToFact),
      relations: relRows.map(rowToRelation),
      history: histRows.map(rowToHistory),
    };
  }

  summary(opts?: { includePrivate?: boolean }): WorldSummary {
    const p = opts?.includePrivate ? "" : "WHERE sensitivity != 'private'";
    const entities = this.db
      .prepare(`SELECT entity_type, state, COUNT(*) AS c FROM entities ${p} GROUP BY entity_type, state`)
      .all() as { entity_type: string; state: string | null; c: number }[];
    const byType: Record<string, number> = {};
    const byState: Record<string, number> = {};
    let total = 0;
    for (const r of entities) {
      byType[r.entity_type] = (byType[r.entity_type] ?? 0) + r.c;
      if (r.state) byState[r.state] = (byState[r.state] ?? 0) + r.c;
      total += r.c;
    }
    const facts = this.db
      .prepare(`SELECT COUNT(*) AS c FROM entity_facts ${p}`)
      .get() as { c: number };
    const relations = this.db
      .prepare(`SELECT COUNT(*) AS c FROM entity_relations ${p}`)
      .get() as { c: number };
    const ev = this.db
      .prepare(
        `SELECT COUNT(DISTINCT event_id) AS total,
                COUNT(DISTINCT CASE WHEN superseded = 1 THEN event_id END) AS superseded
         FROM entity_history`,
      )
      .get() as { total: number; superseded: number };
    return {
      generated_from_events: ev.total,
      superseded_events: ev.superseded,
      entities_total: total,
      by_type: byType,
      by_state: byState,
      facts_total: facts.c,
      relations_total: relations.c,
    };
  }
}
