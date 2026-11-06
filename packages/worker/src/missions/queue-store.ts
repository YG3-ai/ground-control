import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export const MISSION_QUEUE_STATES = [
  "queued",
  "scheduled",
  "running",
  "blocked",
  "verifying",
  "ready_for_review",
  "completed",
  "cancelled",
] as const;

export type MissionQueueState = (typeof MISSION_QUEUE_STATES)[number];

/** States that consume supervised execution capacity. */
export const MISSION_QUEUE_CAPACITY_STATES = new Set<MissionQueueState>([
  "running",
]);

export type MissionQueueEntry = {
  id: string;
  owner_id: string;
  mission_id: string;
  enqueue_key: string;
  priority: number;
  fifo_seq: number;
  depends_on: string[];
  earliest_start_at: string | null;
  schedule_until_at: string | null;
  resource_class: string;
  max_retries: number;
  backoff_sec: number;
  attempt_count: number;
  blocker_code: string | null;
  blocker_detail: string | null;
  next_run_at: string | null;
  queue_state: MissionQueueState;
  claim_token: string | null;
  claimed_at: string | null;
  lease_until: string | null;
  linked_job_id: string | null;
  created_at: string;
  updated_at: string;
};

type QueueRow = {
  id: string;
  owner_id: string;
  mission_id: string;
  enqueue_key: string;
  priority: number;
  fifo_seq: number;
  depends_on: string;
  earliest_start_at: string | null;
  schedule_until_at: string | null;
  resource_class: string;
  max_retries: number;
  backoff_sec: number;
  attempt_count: number;
  blocker_code: string | null;
  blocker_detail: string | null;
  next_run_at: string | null;
  queue_state: string;
  claim_token: string | null;
  claimed_at: string | null;
  lease_until: string | null;
  linked_job_id: string | null;
  created_at: string;
  updated_at: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function parseDepends(raw: string): string[] {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function rowToEntry(row: QueueRow): MissionQueueEntry {
  return {
    id: row.id,
    owner_id: row.owner_id,
    mission_id: row.mission_id,
    enqueue_key: row.enqueue_key,
    priority: row.priority,
    fifo_seq: row.fifo_seq,
    depends_on: parseDepends(row.depends_on),
    earliest_start_at: row.earliest_start_at,
    schedule_until_at: row.schedule_until_at,
    resource_class: row.resource_class,
    max_retries: row.max_retries,
    backoff_sec: row.backoff_sec,
    attempt_count: row.attempt_count,
    blocker_code: row.blocker_code,
    blocker_detail: row.blocker_detail,
    next_run_at: row.next_run_at,
    queue_state: row.queue_state as MissionQueueState,
    claim_token: row.claim_token,
    claimed_at: row.claimed_at,
    lease_until: row.lease_until,
    linked_job_id: row.linked_job_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class MissionQueueStore {
  readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mission_queue (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        mission_id TEXT NOT NULL,
        enqueue_key TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        fifo_seq INTEGER NOT NULL,
        depends_on TEXT NOT NULL DEFAULT '[]',
        earliest_start_at TEXT,
        schedule_until_at TEXT,
        resource_class TEXT NOT NULL DEFAULT 'default',
        max_retries INTEGER NOT NULL DEFAULT 2,
        backoff_sec INTEGER NOT NULL DEFAULT 5,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        blocker_code TEXT,
        blocker_detail TEXT,
        next_run_at TEXT,
        queue_state TEXT NOT NULL,
        claim_token TEXT,
        claimed_at TEXT,
        lease_until TEXT,
        linked_job_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS mission_queue_owner_enqueue_key
        ON mission_queue(owner_id, enqueue_key);
      CREATE INDEX IF NOT EXISTS mission_queue_owner_state_order
        ON mission_queue(owner_id, queue_state, priority DESC, fifo_seq ASC);
    `);
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS mission_queue_active_mission
        ON mission_queue(owner_id, mission_id)
        WHERE queue_state NOT IN ('completed', 'cancelled');
    `);
  }

  private nextFifoSeq(ownerId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(fifo_seq), 0) + 1 AS n FROM mission_queue WHERE owner_id = ?`,
      )
      .get(ownerId) as { n: number };
    return row.n;
  }

  getByEnqueueKey(ownerId: string, enqueueKey: string): MissionQueueEntry | null {
    const row = this.db
      .prepare(
        `SELECT * FROM mission_queue WHERE owner_id = ? AND enqueue_key = ?`,
      )
      .get(ownerId, enqueueKey) as QueueRow | undefined;
    return row ? rowToEntry(row) : null;
  }

  get(ownerId: string, id: string): MissionQueueEntry | null {
    const row = this.db
      .prepare(`SELECT * FROM mission_queue WHERE owner_id = ? AND id = ?`)
      .get(ownerId, id) as QueueRow | undefined;
    return row ? rowToEntry(row) : null;
  }

  getByMissionId(ownerId: string, missionId: string): MissionQueueEntry | null {
    const row = this.db
      .prepare(
        `SELECT * FROM mission_queue
         WHERE owner_id = ? AND mission_id = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(ownerId, missionId) as QueueRow | undefined;
    return row ? rowToEntry(row) : null;
  }

  list(
    ownerId: string,
    opts?: { states?: MissionQueueState[]; limit?: number },
  ): MissionQueueEntry[] {
    const limit = Math.min(opts?.limit ?? 50, 100);
    let rows: QueueRow[];
    if (opts?.states?.length) {
      const placeholders = opts.states.map(() => "?").join(",");
      rows = this.db
        .prepare(
          `SELECT * FROM mission_queue
           WHERE owner_id = ? AND queue_state IN (${placeholders})
           ORDER BY priority DESC, fifo_seq ASC, created_at ASC
           LIMIT ?`,
        )
        .all(ownerId, ...opts.states, limit) as QueueRow[];
    } else {
      rows = this.db
        .prepare(
          `SELECT * FROM mission_queue WHERE owner_id = ?
           ORDER BY priority DESC, fifo_seq ASC, created_at ASC
           LIMIT ?`,
        )
        .all(ownerId, limit) as QueueRow[];
    }
    return rows.map(rowToEntry);
  }

  countInStates(ownerId: string, states: MissionQueueState[]): number {
    if (!states.length) return 0;
    const placeholders = states.map(() => "?").join(",");
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM mission_queue
         WHERE owner_id = ? AND queue_state IN (${placeholders})`,
      )
      .get(ownerId, ...states) as { c: number };
    return row.c;
  }

  enqueue(input: {
    ownerId: string;
    missionId: string;
    enqueueKey: string;
    priority?: number;
    dependsOn?: string[];
    earliestStartAt?: string | null;
    scheduleUntilAt?: string | null;
    resourceClass?: string;
    maxRetries?: number;
    backoffSec?: number;
  }): MissionQueueEntry {
    const existing = this.getByEnqueueKey(input.ownerId, input.enqueueKey);
    if (existing) return existing;

    const now = nowIso();
    const rec: MissionQueueEntry = {
      id: randomUUID(),
      owner_id: input.ownerId,
      mission_id: input.missionId,
      enqueue_key: input.enqueueKey,
      priority: input.priority ?? 0,
      fifo_seq: this.nextFifoSeq(input.ownerId),
      depends_on: input.dependsOn ?? [],
      earliest_start_at: input.earliestStartAt ?? null,
      schedule_until_at: input.scheduleUntilAt ?? null,
      resource_class: (input.resourceClass ?? "default").slice(0, 40),
      max_retries: input.maxRetries ?? 2,
      backoff_sec: input.backoffSec ?? 5,
      attempt_count: 0,
      blocker_code: null,
      blocker_detail: null,
      next_run_at: null,
      queue_state: "queued",
      claim_token: null,
      claimed_at: null,
      lease_until: null,
      linked_job_id: null,
      created_at: now,
      updated_at: now,
    };

    try {
      this.db
        .prepare(
          `INSERT INTO mission_queue (
            id, owner_id, mission_id, enqueue_key, priority, fifo_seq, depends_on,
            earliest_start_at, schedule_until_at, resource_class,
            max_retries, backoff_sec, attempt_count,
            blocker_code, blocker_detail, next_run_at, queue_state,
            claim_token, claimed_at, lease_until, linked_job_id,
            created_at, updated_at
          ) VALUES (
            @id, @owner_id, @mission_id, @enqueue_key, @priority, @fifo_seq, @depends_on,
            @earliest_start_at, @schedule_until_at, @resource_class,
            @max_retries, @backoff_sec, @attempt_count,
            @blocker_code, @blocker_detail, @next_run_at, @queue_state,
            @claim_token, @claimed_at, @lease_until, @linked_job_id,
            @created_at, @updated_at
          )`,
        )
        .run({
          ...rec,
          depends_on: JSON.stringify(rec.depends_on),
        });
      return rec;
    } catch (err) {
      const dup = this.getByEnqueueKey(input.ownerId, input.enqueueKey);
      if (dup) return dup;
      throw err;
    }
  }

  update(
    ownerId: string,
    id: string,
    patch: Partial<
      Pick<
        MissionQueueEntry,
        | "priority"
        | "depends_on"
        | "earliest_start_at"
        | "schedule_until_at"
        | "resource_class"
        | "max_retries"
        | "backoff_sec"
        | "attempt_count"
        | "blocker_code"
        | "blocker_detail"
        | "next_run_at"
        | "queue_state"
        | "claim_token"
        | "claimed_at"
        | "lease_until"
        | "linked_job_id"
      >
    >,
  ): MissionQueueEntry {
    const cur = this.get(ownerId, id);
    if (!cur) throw new Error(`mission queue entry not found: ${id}`);
    const next = { ...cur, ...patch, updated_at: nowIso() };
    this.db
      .prepare(
        `UPDATE mission_queue SET
          priority=@priority, depends_on=@depends_on,
          earliest_start_at=@earliest_start_at, schedule_until_at=@schedule_until_at,
          resource_class=@resource_class, max_retries=@max_retries, backoff_sec=@backoff_sec,
          attempt_count=@attempt_count, blocker_code=@blocker_code, blocker_detail=@blocker_detail,
          next_run_at=@next_run_at, queue_state=@queue_state,
          claim_token=@claim_token, claimed_at=@claimed_at, lease_until=@lease_until,
          linked_job_id=@linked_job_id, updated_at=@updated_at
         WHERE id=@id AND owner_id=@owner_id`,
      )
      .run({
        ...next,
        depends_on: JSON.stringify(next.depends_on),
      });
    return next;
  }

  cancel(ownerId: string, id: string, reason?: string): MissionQueueEntry {
    return this.update(ownerId, id, {
      queue_state: "cancelled",
      claim_token: null,
      claimed_at: null,
      lease_until: null,
      blocker_code: reason ? "cancelled" : null,
      blocker_detail: reason ?? null,
    });
  }

  /** Atomic claim: only one winner per entry. */
  tryClaim(
    ownerId: string,
    id: string,
    claimToken: string,
    leaseUntil: string,
  ): MissionQueueEntry | null {
    const now = nowIso();
    const result = this.db
      .prepare(
        `UPDATE mission_queue SET
          queue_state = 'running',
          claim_token = @claim_token,
          claimed_at = @claimed_at,
          lease_until = @lease_until,
          updated_at = @updated_at,
          blocker_code = NULL,
          blocker_detail = NULL
         WHERE owner_id = @owner_id AND id = @id
           AND queue_state IN ('queued', 'scheduled')
           AND claim_token IS NULL`,
      )
      .run({
        owner_id: ownerId,
        id,
        claim_token: claimToken,
        claimed_at: now,
        lease_until: leaseUntil,
        updated_at: now,
      });
    if (result.changes === 0) return null;
    return this.get(ownerId, id);
  }

  releaseClaim(
    ownerId: string,
    id: string,
    patch: {
      queue_state: MissionQueueState;
      blocker_code?: string | null;
      blocker_detail?: string | null;
      next_run_at?: string | null;
      attempt_count?: number;
    },
  ): MissionQueueEntry {
    const cur = this.get(ownerId, id);
    if (!cur) throw new Error(`mission queue entry not found: ${id}`);
    return this.update(ownerId, id, {
      ...patch,
      claim_token: null,
      claimed_at: null,
      lease_until: null,
    });
  }

  listRunnableCandidates(
    ownerId: string,
    nowIso: string,
    limit = 20,
  ): MissionQueueEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM mission_queue
         WHERE owner_id = ?
           AND queue_state IN ('queued', 'scheduled')
           AND (next_run_at IS NULL OR next_run_at <= ?)
           AND (earliest_start_at IS NULL OR earliest_start_at <= ?)
           AND (schedule_until_at IS NULL OR schedule_until_at >= ?)
         ORDER BY priority DESC, fifo_seq ASC
         LIMIT ?`,
      )
      .all(ownerId, nowIso, nowIso, nowIso, limit) as QueueRow[];
    return rows.map(rowToEntry);
  }

  recoverExpiredLeases(ownerId: string, nowIso: string): number {
    const result = this.db
      .prepare(
        `UPDATE mission_queue SET
          queue_state = 'queued',
          claim_token = NULL,
          claimed_at = NULL,
          lease_until = NULL,
          updated_at = @now,
          blocker_code = 'lease_expired',
          blocker_detail = 'supervisor lease expired — re-queued'
         WHERE owner_id = @owner_id
           AND queue_state = 'running'
           AND lease_until IS NOT NULL
           AND lease_until < @now`,
      )
      .run({ owner_id: ownerId, now: nowIso });
    return result.changes;
  }
}
