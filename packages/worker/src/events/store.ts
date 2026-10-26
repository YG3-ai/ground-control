import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { JobStore } from "../db.js";
import type { ApprovalManager, ApprovalRecord } from "../local/approvals.js";
import type { MissionStore } from "../missions/store.js";
import type { UsageLedger } from "../usage/ledger.js";
import type { ClientRequestStore } from "../clients/store.js";
import type {
  EventRecord,
  EventSensitivity,
  EventSource,
  NewEvent,
} from "./types.js";

export const EVENTS_ADAPTER_VERSION = 1;
export const EVENTS_SCHEMA_VERSION = 1;

/** Deterministic UUID v-shaped id from content-free key material. */
export function deriveEventId(input: {
  adapterVersion: number;
  source: string;
  sourceRef: string;
  verb: string;
  dedupeKey: string;
}): string {
  const hex = createHash("sha256")
    .update(
      [
        input.adapterVersion,
        input.source,
        input.sourceRef,
        input.verb,
        input.dedupeKey,
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

type EventRow = Omit<EventRecord, "evidence_refs"> & { evidence_refs: string };

function rowToEvent(row: EventRow): EventRecord {
  let refs: string[] = [];
  try {
    const v = JSON.parse(row.evidence_refs) as unknown;
    if (Array.isArray(v)) refs = v.map(String);
  } catch {
    refs = [];
  }
  return { ...row, evidence_refs: refs };
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Append-only event spine ("Ground Life Mirror", Phase 1).
 * Own SQLite file (events.db) beside usage.db; fully rebuildable from the
 * source stores via rebuildFrom(). Never a source of truth itself.
 */
export type RebuildSources = {
  jobs?: JobStore;
  missions?: MissionStore;
  approvals?: ApprovalManager;
  usage?: UsageLedger;
  clients?: ClientRequestStore;
};

/** One source's derived batch — the unit a dry-run reports on. */
export type RebuildPlanEntry = {
  source: string;
  events: NewEvent[];
};

/** Counts-only dry-run report. Never carries event content. */
export type RebuildReport = {
  inserted: number;
  dry_run: boolean;
  per_source: {
    source: string;
    derived: number;
    already_present: number;
    would_insert: number;
    sensitivity: Record<EventSensitivity, number>;
  }[];
};

/** Counts-only report for backfillMissionEvidence(). Never carries content. */
export type MissionEvidenceBackfillReport = {
  scanned: number;
  corrected: number;
  already_ok: number;
  dry_run: boolean;
};

export class EventStore {
  readonly db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        occurred_at TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        source TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        actor TEXT,
        verb TEXT NOT NULL,
        object_type TEXT,
        object_id TEXT,
        from_state TEXT,
        to_state TEXT,
        evidence_refs TEXT NOT NULL DEFAULT '[]',
        confidence REAL NOT NULL DEFAULT 1.0,
        sensitivity TEXT NOT NULL DEFAULT 'internal',
        schema_version INTEGER NOT NULL DEFAULT 1,
        adapter_version INTEGER NOT NULL DEFAULT 1,
        corrects TEXT
      );
      CREATE INDEX IF NOT EXISTS events_occurred ON events(occurred_at DESC);
      CREATE INDEX IF NOT EXISTS events_source_ref ON events(source, source_ref);
      CREATE INDEX IF NOT EXISTS events_verb_occurred ON events(verb, occurred_at DESC);
    `);
  }

  close(): void {
    this.db.close();
  }

  /** Idempotent append. Returns the stored row (existing on dedupe). */
  emit(e: NewEvent): EventRecord {
    const adapterVersion = e.adapterVersion ?? EVENTS_ADAPTER_VERSION;
    const rec: EventRecord = {
      event_id: deriveEventId({
        adapterVersion,
        source: e.source,
        sourceRef: e.sourceRef,
        verb: e.verb,
        dedupeKey: e.dedupeKey,
      }),
      occurred_at: e.occurredAt ?? nowIso(),
      observed_at: e.observedAt ?? nowIso(),
      source: e.source,
      source_ref: e.sourceRef,
      actor: e.actor ?? null,
      verb: e.verb,
      object_type: e.objectType ?? null,
      object_id: e.objectId ?? null,
      from_state: e.fromState ?? null,
      to_state: e.toState ?? null,
      evidence_refs: e.evidenceRefs ?? [],
      confidence: e.confidence ?? 1.0,
      sensitivity: e.sensitivity ?? "internal",
      schema_version: e.schemaVersion ?? EVENTS_SCHEMA_VERSION,
      adapter_version: adapterVersion,
      corrects: e.corrects ?? null,
    };
    this.db
      .prepare(
        `INSERT OR IGNORE INTO events (
          event_id, occurred_at, observed_at, source, source_ref, actor, verb,
          object_type, object_id, from_state, to_state, evidence_refs,
          confidence, sensitivity, schema_version, adapter_version, corrects
        ) VALUES (
          @event_id, @occurred_at, @observed_at, @source, @source_ref, @actor, @verb,
          @object_type, @object_id, @from_state, @to_state, @evidence_refs,
          @confidence, @sensitivity, @schema_version, @adapter_version, @corrects
        )`,
      )
      .run({ ...rec, evidence_refs: JSON.stringify(rec.evidence_refs) });
    return rec;
  }

  /**
   * Read-only query. Private rows are excluded unless includePrivate=true.
   * No raw content exists in this store, so nothing here can leak bodies.
   */
  list(opts?: {
    limit?: number;
    since?: string;
    source?: string;
    verb?: string;
    includePrivate?: boolean;
  }): EventRecord[] {
    const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 500);
    const where: string[] = [];
    const params: Record<string, string | number> = { limit };
    if (opts?.since) {
      where.push("occurred_at >= @since");
      params.since = opts.since;
    }
    if (opts?.source) {
      where.push("source = @source");
      params.source = opts.source;
    }
    if (opts?.verb) {
      where.push("verb = @verb");
      params.verb = opts.verb;
    }
    if (!opts?.includePrivate) {
      where.push("sensitivity != 'private'");
    }
    const sql = `SELECT * FROM events ${
      where.length ? `WHERE ${where.join(" AND ")}` : ""
    } ORDER BY occurred_at DESC LIMIT @limit`;
    const rows = this.db.prepare(sql).all(params) as EventRow[];
    return rows.map(rowToEvent);
  }

  count(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM events`)
      .get() as { c: number };
    return row.c;
  }

  /**
   * Deterministic materialization from source stores. Because event_ids are
   * content-derived, running this repeatedly (or after deleting events.db)
   * yields the same rows. Only live-hook events for ephemeral sources
   * (e.g. terminal sessions) are not reproducible here.
   *
   * With `dryRun: true` nothing is written; the report carries COUNTS ONLY
   * (per source and per sensitivity) — never event content.
   */
  rebuildFrom(
    sources: RebuildSources,
    opts?: { dryRun?: boolean },
  ): RebuildReport {
    const plan = this.planRebuild(sources);
    const report: RebuildReport = {
      inserted: 0,
      dry_run: opts?.dryRun === true,
      per_source: [],
    };
    for (const entry of plan) {
      const sensitivity: Record<EventSensitivity, number> = {
        public: 0,
        internal: 0,
        private: 0,
      };
      let already = 0;
      let wouldInsert = 0;
      for (const e of entry.events) {
        sensitivity[e.sensitivity ?? "internal"] += 1;
        const id = deriveEventId({
          adapterVersion: e.adapterVersion ?? EVENTS_ADAPTER_VERSION,
          source: e.source,
          sourceRef: e.sourceRef,
          verb: e.verb,
          dedupeKey: e.dedupeKey,
        });
        if (this.has(id)) {
          already += 1;
          continue;
        }
        wouldInsert += 1;
        if (!report.dry_run) {
          this.emit(e);
          report.inserted += 1;
        }
      }
      report.per_source.push({
        source: entry.source,
        derived: entry.events.length,
        already_present: already,
        would_insert: wouldInsert,
        sensitivity,
      });
    }
    return report;
  }

  /** Derive every rebuildable source's events without writing anything. */
  planRebuild(sources: RebuildSources): RebuildPlanEntry[] {
    const plan: RebuildPlanEntry[] = [];
    if (sources.missions) {
      plan.push({ source: "missions", events: this.deriveMissionEvents(sources.missions) });
    }
    if (sources.jobs) {
      plan.push({ source: "jobs", events: this.deriveJobEvents(sources.jobs) });
    }
    if (sources.approvals) {
      plan.push({ source: "approvals", events: this.deriveApprovalEvents(sources.approvals) });
    }
    if (sources.usage) {
      plan.push({ source: "usage", events: this.deriveUsageEvents(sources.usage) });
    }
    if (sources.clients) {
      plan.push({ source: "clients", events: this.deriveClientRequestEvents(sources.clients) });
    }
    return plan;
  }

  private has(eventId: string): boolean {
    return (
      this.db
        .prepare(`SELECT 1 FROM events WHERE event_id = ?`)
        .get(eventId) !== undefined
    );
  }

  /**
   * Deterministic, append-only evidence backfill for historical mission
   * completion events (mission.status_changed → done). Completions emitted
   * before linked-job evidence existed lack `job:<id>` refs, which the meaning
   * rules rely on. For each such stored event we append a CORRECTION event —
   * the original row is never updated — carrying the evidence the rebuild
   * derivation computes today from `missions.linked_job_ids` (the ONLY linkage
   * source; no title/timestamp/client heuristics), with `corrects` pointing at
   * the original event_id and sensitivity/confidence inherited from it.
   *
   * Correction event_id scheme: deriveEventId over the ORIGINAL event's
   * adapterVersion/source/sourceRef/verb with dedupeKey
   * `evidence-correction-v1|<original event_id>`. The original dedupeKey is not
   * stored, so the original event_id is the stable anchor; re-runs hit
   * INSERT OR IGNORE and are no-ops. Missions whose row is gone or whose
   * linked_job_ids are empty are left alone.
   */
  backfillMissionEvidence(
    missions: MissionStore,
    opts?: { dryRun?: boolean },
  ): MissionEvidenceBackfillReport {
    const dryRun = opts?.dryRun === true;
    const missionRows = missions.db
      .prepare(
        `SELECT id, linked_job_ids FROM missions WHERE completed_at IS NOT NULL`,
      )
      .all() as { id: string; linked_job_ids: string }[];
    const expectedRefs = new Map<string, string[]>();
    for (const m of missionRows) {
      let linkedJobs: string[] = [];
      try {
        const v = JSON.parse(m.linked_job_ids) as unknown;
        if (Array.isArray(v)) linkedJobs = v.map(String);
      } catch {
        linkedJobs = [];
      }
      if (linkedJobs.length === 0) continue;
      expectedRefs.set(m.id, [
        `mission:${m.id}`,
        ...linkedJobs.map((j) => `job:${j}`),
      ]);
    }

    const superseded = new Set(
      (
        this.db
          .prepare(`SELECT corrects FROM events WHERE corrects IS NOT NULL`)
          .all() as { corrects: string }[]
      ).map((r) => r.corrects),
    );
    const rows = this.db
      .prepare(
        `SELECT * FROM events
         WHERE verb = 'mission.status_changed'
           AND to_state = 'done'
           AND object_type = 'mission'`,
      )
      .all() as EventRow[];

    const report: MissionEvidenceBackfillReport = {
      scanned: 0,
      corrected: 0,
      already_ok: 0,
      dry_run: dryRun,
    };
    for (const row of rows) {
      const orig = rowToEvent(row);
      if (superseded.has(orig.event_id)) continue;
      if (orig.object_id == null) continue;
      const derived = expectedRefs.get(orig.object_id);
      if (!derived) continue; // mission gone or no linked jobs — leave alone
      report.scanned += 1;
      if (derived.every((r) => orig.evidence_refs.includes(r))) {
        report.already_ok += 1;
        continue;
      }
      const merged = [...orig.evidence_refs];
      for (const r of derived) if (!merged.includes(r)) merged.push(r);
      if (!dryRun) {
        this.emit({
          source: orig.source,
          sourceRef: orig.source_ref,
          actor: orig.actor,
          verb: orig.verb,
          objectType: orig.object_type,
          objectId: orig.object_id,
          fromState: orig.from_state,
          toState: orig.to_state,
          occurredAt: orig.occurred_at,
          evidenceRefs: merged,
          confidence: orig.confidence,
          sensitivity: orig.sensitivity,
          corrects: orig.event_id,
          dedupeKey: `evidence-correction-v1|${orig.event_id}`,
        });
      }
      report.corrected += 1;
    }
    return report;
  }

  /** All events including private — for internal derived projections only. */
  allEvents(): EventRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM events ORDER BY occurred_at ASC, event_id ASC`)
      .all() as EventRow[];
    return rows.map(rowToEvent);
  }

  /**
   * Compact metric/state snapshot (growth / lifecycle / skills adapters).
   * One event per metric key: numbers, booleans, short state strings ONLY —
   * never note bodies, insight prose, or raw content. The snapshot itself is
   * referenced by `source` + `snapshotId`; `generatedAt` is the source's own
   * timestamp, so re-ingesting the same snapshot is idempotent.
   */
  emitMetricSnapshot(input: {
    source: EventSource;
    snapshotId: string;
    generatedAt: string;
    metrics: Record<string, number | string | boolean | null>;
    evidenceRefs?: string[];
    sensitivity?: EventSensitivity;
  }): EventRecord[] {
    const out: EventRecord[] = [];
    for (const [key, value] of Object.entries(input.metrics)) {
      if (!/^[a-z0-9_.-]{1,64}$/i.test(key)) continue;
      if (value === null || value === undefined) continue;
      const str = typeof value === "string" ? value : JSON.stringify(value);
      if (str.length > 120) continue; // prose guard: metrics stay compact
      out.push(
        this.emit({
          source: input.source,
          sourceRef: input.snapshotId,
          actor: "system",
          verb: `${input.source}.snapshot_metric`,
          objectType: "metric",
          objectId: key,
          toState: str,
          occurredAt: input.generatedAt,
          evidenceRefs: input.evidenceRefs ?? [`${input.source}:${input.snapshotId}`],
          sensitivity: input.sensitivity ?? "internal",
          dedupeKey: `${input.snapshotId}:${key}`,
        }),
      );
    }
    return out;
  }

  private deriveMissionEvents(store: MissionStore): NewEvent[] {
    const rows = store.db
      .prepare(
        `SELECT id, owner_id, status, created_at, updated_at, approved_at, completed_at, linked_job_ids
         FROM missions`,
      )
      .all() as {
      id: string;
      owner_id: string;
      status: string;
      created_at: string;
      updated_at: string;
      approved_at: string | null;
      completed_at: string | null;
      linked_job_ids: string;
    }[];
    const out: NewEvent[] = [];
    for (const m of rows) {
      let linkedJobs: string[] = [];
      try {
        const v = JSON.parse(m.linked_job_ids) as unknown;
        if (Array.isArray(v)) linkedJobs = v.map(String);
      } catch {
        linkedJobs = [];
      }
      const base = {
        source: "missions",
        sourceRef: m.id,
        actor: "owner" as const,
        objectType: "mission",
        objectId: m.id,
        evidenceRefs: [
          `mission:${m.id}`,
          ...linkedJobs.map((j) => `job:${j}`),
        ],
        sensitivity: "internal" as EventSensitivity,
      };
      out.push({
        ...base,
        verb: "mission.created",
        occurredAt: m.created_at,
        observedAt: m.created_at,
        toState: "intake",
        dedupeKey: "created",
      });
      out.push({
        ...base,
        verb: "mission.status_current",
        occurredAt: m.updated_at,
        observedAt: m.updated_at,
        toState: m.status,
        dedupeKey: `status_current:${m.status}`,
      });
      if (m.approved_at) {
        out.push({
          ...base,
          verb: "mission.status_changed",
          occurredAt: m.approved_at,
          observedAt: m.approved_at,
          toState: "approved",
          dedupeKey: "approved",
        });
      }
      if (m.completed_at) {
        out.push({
          ...base,
          verb: "mission.status_changed",
          occurredAt: m.completed_at,
          observedAt: m.completed_at,
          toState: "done",
          dedupeKey: "completed",
        });
      }
    }
    return out;
  }

  private deriveJobEvents(store: JobStore): NewEvent[] {
    const rows = store.db
      .prepare(
        `SELECT id, owner_id, agent, status, created_at, started_at, finished_at
         FROM jobs`,
      )
      .all() as {
      id: string;
      owner_id: string;
      agent: string;
      status: string;
      created_at: string;
      started_at: string | null;
      finished_at: string | null;
    }[];
    const out: NewEvent[] = [];
    for (const j of rows) {
      const base = {
        source: "jobs",
        sourceRef: j.id,
        actor: `agent:${j.agent}` as `agent:${string}`,
        objectType: "job",
        objectId: j.id,
        evidenceRefs: [`job:${j.id}`],
        sensitivity: "private" as EventSensitivity,
      };
      out.push({
        ...base,
        verb: "job.created",
        occurredAt: j.created_at,
        observedAt: j.created_at,
        toState: "queued",
        dedupeKey: "created",
      });
      if (j.started_at) {
        out.push({
          ...base,
          verb: "job.status_changed",
          occurredAt: j.started_at,
          observedAt: j.started_at,
          fromState: "queued",
          toState: "running",
          dedupeKey: "started",
        });
      }
      if (j.finished_at) {
        out.push({
          ...base,
          verb: "job.status_changed",
          occurredAt: j.finished_at,
          observedAt: j.finished_at,
          fromState: "running",
          toState: j.status,
          dedupeKey: `finished:${j.status}`,
        });
      }
    }
    return out;
  }

  private deriveApprovalEvents(manager: ApprovalManager): NewEvent[] {
    const records: ApprovalRecord[] = manager.listAll();
    const out: NewEvent[] = [];
    for (const a of records) {
      const base = {
        source: "approvals",
        sourceRef: a.id,
        objectType: "approval",
        objectId: a.id,
        // kind only — never title/detail/note/payload
        evidenceRefs: [`approval:${a.id}`],
        sensitivity: "private" as EventSensitivity,
        confidence: 1.0,
      };
      out.push({
        ...base,
        verb: "approval.requested",
        actor: "system",
        occurredAt: a.created_at,
        observedAt: a.created_at,
        toState: a.kind,
        dedupeKey: "requested",
      });
      if (a.resolved_at) {
        out.push({
          ...base,
          verb: "approval.resolved",
          actor: "owner",
          occurredAt: a.resolved_at,
          observedAt: a.resolved_at,
          fromState: "pending",
          toState: a.status,
          dedupeKey: "resolved",
        });
      }
    }
    return out;
  }

  /**
   * Usage ledger (usage.db). Durable rows: start/finish/rate_limited/blocked.
   * Emits kind + agent + optional job link + model/tier only — the ledger's
   * free-text `detail` column is content and is never copied.
   */
  private deriveUsageEvents(ledger: UsageLedger): NewEvent[] {
    const rows = ledger.db
      .prepare(
        `SELECT id, agent, kind, job_id, tier, model, created_at
         FROM usage_events ORDER BY id ASC`,
      )
      .all() as {
      id: number;
      agent: string;
      kind: "start" | "finish" | "rate_limited" | "blocked";
      job_id: string | null;
      tier: string | null;
      model: string | null;
      created_at: string;
    }[];
    const out: NewEvent[] = [];
    for (const u of rows) {
      const evidence = [`usage:${u.id}`];
      if (u.job_id) evidence.push(`job:${u.job_id}`);
      out.push({
        source: "usage",
        sourceRef: `usage:${u.id}`,
        actor: `agent:${u.agent}`,
        verb: `usage.${u.kind}`,
        objectType: u.job_id ? "job" : "agent",
        objectId: u.job_id ?? u.agent,
        toState: u.kind,
        occurredAt: u.created_at,
        observedAt: u.created_at,
        evidenceRefs: evidence,
        sensitivity: "internal",
        dedupeKey: `row:${u.id}`,
      });
    }
    return out;
  }

  /**
   * Client requests (clients.db). PRIVATE by default: subject/body/email are
   * content and are never copied — only ids, status, and timestamps. The
   * mission link (when present) is carried as an evidence ref so the world
   * model can prove request→mission relations without seeing content.
   */
  private deriveClientRequestEvents(store: ClientRequestStore): NewEvent[] {
    const rows = store.db
      .prepare(
        `SELECT id, client_id, status, mission_id, created_at, updated_at, completed_at
         FROM client_requests`,
      )
      .all() as {
      id: string;
      client_id: string;
      status: string;
      mission_id: string | null;
      created_at: string;
      updated_at: string;
      completed_at: string | null;
    }[];
    const out: NewEvent[] = [];
    for (const r of rows) {
      const evidence = [`request:${r.id}`, `client:${r.client_id}`];
      if (r.mission_id) evidence.push(`mission:${r.mission_id}`);
      const base = {
        source: "clients",
        sourceRef: r.id,
        actor: "owner" as const,
        objectType: "client_request",
        objectId: r.id,
        evidenceRefs: evidence,
        sensitivity: "private" as EventSensitivity,
      };
      out.push({
        ...base,
        verb: "client_request.created",
        occurredAt: r.created_at,
        observedAt: r.created_at,
        toState: "queued",
        dedupeKey: "created",
      });
      out.push({
        ...base,
        verb: "client_request.status_current",
        occurredAt: r.updated_at,
        observedAt: r.updated_at,
        toState: r.status,
        dedupeKey: `status_current:${r.status}`,
      });
      if (r.completed_at) {
        out.push({
          ...base,
          verb: "client_request.status_changed",
          occurredAt: r.completed_at,
          observedAt: r.completed_at,
          toState: r.status,
          dedupeKey: `completed:${r.status}`,
        });
      }
    }
    return out;
  }
}

export type { EventRecord, NewEvent } from "./types.js";
