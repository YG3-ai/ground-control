import { nextRetryStreak } from "./execution-activity.js";
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  FollowupRecord,
  JobRecord,
  JobStatus,
  StartTaskInput,
} from "@agent-control/shared";
import { randomUUID } from "node:crypto";

export class JobStore {
  readonly db: Database.Database;
  /** Optional event sink (Ground Life Mirror). Metadata only — never content. */
  onEvent?: import("./events/types.js").EventSink;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        agent TEXT NOT NULL,
        mission_id TEXT,
        prompt TEXT NOT NULL,
        tier TEXT NOT NULL DEFAULT 'default',
        model TEXT,
        cursor_mode TEXT,
        status TEXT NOT NULL,
        idempotency_key TEXT,
        session_id TEXT,
        work_path TEXT,
        container_id TEXT,
        exit_code INTEGER,
        error TEXT,
        summary TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        timeout_sec INTEGER NOT NULL,
        execution_meta TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS jobs_owner_idempotency
        ON jobs(owner_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
      CREATE TABLE IF NOT EXISTS followups (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES jobs(id),
        message TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        delivered_at TEXT
      );
      CREATE TABLE IF NOT EXISTS job_logs (
        job_id TEXT PRIMARY KEY REFERENCES jobs(id),
        stdout TEXT NOT NULL DEFAULT '',
        stderr TEXT NOT NULL DEFAULT '',
        diff TEXT,
        test_results TEXT
      );
    `);
    const columns = new Set(
      (this.db.pragma("table_info(jobs)") as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    );
    if (!columns.has("mission_id")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN mission_id TEXT");
    }
    if (!columns.has("tier")) {
      this.db.exec(
        "ALTER TABLE jobs ADD COLUMN tier TEXT NOT NULL DEFAULT 'default'",
      );
    }
    if (!columns.has("model")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN model TEXT");
    }
    if (!columns.has("cursor_mode")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN cursor_mode TEXT");
    }
    if (!columns.has("execution_meta")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN execution_meta TEXT");
    }
  }

  close(): void {
    this.db.close();
  }

  createJob(
    input: StartTaskInput & {
      timeoutSec: number;
      projectId: string;
      workPath?: string | null;
      resolvedModel?: string | null;
      cursorMode?: "ask" | "plan" | null;
    },
  ): JobRecord {
    if (input.idempotencyKey) {
      const existing = this.getByIdempotency(input.ownerId, input.idempotencyKey);
      if (existing) return existing;
    }

    const now = new Date().toISOString();
    const job: JobRecord = {
      id: randomUUID(),
      owner_id: input.ownerId,
      project_id: input.projectId,
      agent: input.agent,
      mission_id: input.missionId ?? null,
      prompt: input.prompt,
      tier: input.tier ?? "default",
      model: input.resolvedModel ?? input.model ?? null,
      cursor_mode: input.cursorMode ?? null,
      status: "queued",
      idempotency_key: input.idempotencyKey ?? null,
      session_id: null,
      work_path: input.workPath ?? null,
      container_id: null,
      exit_code: null,
      error: null,
      summary: null,
      created_at: now,
      updated_at: now,
      started_at: null,
      finished_at: null,
      timeout_sec: input.timeoutSec,
      execution_meta: null,
    };

    try {
      this.db
        .prepare(
          `INSERT INTO jobs (
            id, owner_id, project_id, agent, mission_id, prompt, tier, model,
            cursor_mode, status, idempotency_key,
            session_id, work_path, container_id, exit_code, error, summary,
            created_at, updated_at, started_at, finished_at, timeout_sec, execution_meta
          ) VALUES (
            @id, @owner_id, @project_id, @agent, @mission_id, @prompt, @tier, @model,
            @cursor_mode, @status, @idempotency_key,
            @session_id, @work_path, @container_id, @exit_code, @error, @summary,
            @created_at, @updated_at, @started_at, @finished_at, @timeout_sec, @execution_meta
          )`,
        )
        .run(job);
      this.db
        .prepare(
          `INSERT INTO job_logs (job_id, stdout, stderr) VALUES (?, '', '')`,
        )
        .run(job.id);
      this.onEvent?.({
        source: "jobs",
        sourceRef: job.id,
        actor: `agent:${job.agent}`,
        verb: "job.created",
        objectType: "job",
        objectId: job.id,
        toState: job.status,
        occurredAt: job.created_at,
        evidenceRefs: [`job:${job.id}`],
        sensitivity: "private",
        dedupeKey: "created",
      });
      return job;
    } catch (err) {
      // Unique race on idempotency key — return the winner.
      if (input.idempotencyKey) {
        const existing = this.getByIdempotency(input.ownerId, input.idempotencyKey);
        if (existing) return existing;
      }
      throw err;
    }
  }

  getJob(id: string): JobRecord | null {
    const row = this.db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as
      | JobRecord
      | undefined;
    return row ?? null;
  }

  getByIdempotency(ownerId: string, key: string): JobRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM jobs WHERE owner_id = ? AND idempotency_key = ?`,
      )
      .get(ownerId, key) as JobRecord | undefined;
    return row ?? null;
  }

  listQueued(): JobRecord[] {
    return this.db
      .prepare(
        `SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at ASC`,
      )
      .all() as JobRecord[];
  }

  listRecent(ownerId: string, limit = 30): JobRecord[] {
    return this.db
      .prepare(
        `SELECT * FROM jobs WHERE owner_id = ? ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(ownerId, limit) as JobRecord[];
  }

  /** Active/non-terminal jobs touching the same work_path (host concurrency lock). */
  listActiveForWorkPath(workPath: string): JobRecord[] {
    return this.db
      .prepare(
        `SELECT * FROM jobs
         WHERE work_path = ?
           AND status IN ('queued','preparing','running','awaiting_followup','cancelling')`,
      )
      .all(workPath) as JobRecord[];
  }

  updateJob(
    id: string,
    patch: Partial<
      Pick<
        JobRecord,
        | "status"
        | "session_id"
        | "work_path"
        | "container_id"
        | "exit_code"
        | "error"
        | "summary"
        | "started_at"
        | "finished_at"
        | "execution_meta"
      >
    >,
  ): JobRecord {
    const current = this.getJob(id);
    if (!current) throw new Error(`job not found: ${id}`);
    const next: JobRecord = {
      ...current,
      ...patch,
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `UPDATE jobs SET
          status=@status, session_id=@session_id, work_path=@work_path,
          container_id=@container_id, exit_code=@exit_code, error=@error,
          summary=@summary, execution_meta=@execution_meta, updated_at=@updated_at, started_at=@started_at,
          finished_at=@finished_at
         WHERE id=@id`,
      )
      .run(next);
    if (patch.status != null && patch.status !== current.status) {
      this.onEvent?.({
        source: "jobs",
        sourceRef: next.id,
        actor: `agent:${next.agent}`,
        verb: "job.status_changed",
        objectType: "job",
        objectId: next.id,
        fromState: current.status,
        toState: next.status,
        occurredAt: next.updated_at,
        evidenceRefs: [`job:${next.id}`],
        sensitivity: "private",
        dedupeKey: `status:${current.status}>${next.status}:${next.updated_at}`,
      });
    }
    return next;
  }

  appendLogs(
    jobId: string,
    chunk: { stdout?: string; stderr?: string; diff?: string; test_results?: string },
  ): void {
    const row = this.db
      .prepare(`SELECT * FROM job_logs WHERE job_id = ?`)
      .get(jobId) as
      | {
          stdout: string;
          stderr: string;
          diff: string | null;
          test_results: string | null;
        }
      | undefined;
    if (!row) throw new Error(`logs missing for ${jobId}`);
    if (chunk.stdout || chunk.stderr) {
      const job = this.getJob(jobId);
      let meta: Record<string, unknown> = {};
      try { meta = JSON.parse(job?.execution_meta ?? "{}"); } catch { /* legacy metadata */ }
      const previous = typeof meta.watchdog_retry_streak === "number" ? meta.watchdog_retry_streak : 0;
      this.updateJob(jobId, {execution_meta: JSON.stringify({...meta, watchdog_retry_streak: nextRetryStreak(previous, chunk)})});
    }

    this.db
      .prepare(
        `UPDATE job_logs SET
          stdout = ?,
          stderr = ?,
          diff = COALESCE(?, diff),
          test_results = COALESCE(?, test_results)
         WHERE job_id = ?`,
      )
      .run(
        row.stdout + (chunk.stdout ?? ""),
        row.stderr + (chunk.stderr ?? ""),
        chunk.diff ?? null,
        chunk.test_results ?? null,
        jobId,
      );
  }

  /** Replace stdout/stderr with authoritative final buffers (after streaming). */
  replaceStdio(jobId: string, stdout: string, stderr: string): void {
    this.db
      .prepare(`UPDATE job_logs SET stdout = ?, stderr = ? WHERE job_id = ?`)
      .run(stdout, stderr, jobId);
  }

  getLogs(jobId: string): {
    stdout: string;
    stderr: string;
    diff: string | null;
    test_results: string | null;
  } {
    const row = this.db
      .prepare(`SELECT stdout, stderr, diff, test_results FROM job_logs WHERE job_id = ?`)
      .get(jobId) as
      | {
          stdout: string;
          stderr: string;
          diff: string | null;
          test_results: string | null;
        }
      | undefined;
    if (!row) throw new Error(`logs missing for ${jobId}`);
    return row;
  }

  enqueueFollowup(jobId: string, message: string): FollowupRecord {
    const rec: FollowupRecord = {
      id: randomUUID(),
      job_id: jobId,
      message,
      status: "queued",
      created_at: new Date().toISOString(),
      delivered_at: null,
    };
    this.db
      .prepare(
        `INSERT INTO followups (id, job_id, message, status, created_at, delivered_at)
         VALUES (@id, @job_id, @message, @status, @created_at, @delivered_at)`,
      )
      .run(rec);
    return rec;
  }

  listFollowups(jobId: string, status?: FollowupRecord["status"]): FollowupRecord[] {
    if (status) {
      return this.db
        .prepare(
          `SELECT * FROM followups WHERE job_id = ? AND status = ? ORDER BY created_at ASC`,
        )
        .all(jobId, status) as FollowupRecord[];
    }
    return this.db
      .prepare(`SELECT * FROM followups WHERE job_id = ? ORDER BY created_at ASC`)
      .all(jobId) as FollowupRecord[];
  }

  markFollowupDelivered(id: string): void {
    this.db
      .prepare(
        `UPDATE followups SET status = 'delivered', delivered_at = ? WHERE id = ?`,
      )
      .run(new Date().toISOString(), id);
  }

  countFollowups(jobId: string, status: FollowupRecord["status"]): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM followups WHERE job_id = ? AND status = ?`,
      )
      .get(jobId, status) as { c: number };
    return row.c;
  }

  listInFlightHostContainerIds(): { id: string; container_id: string | null }[] {
    return this.db
      .prepare(
        `SELECT id, container_id FROM jobs
         WHERE status IN ('preparing', 'running', 'cancelling', 'awaiting_followup')
           AND container_id IS NOT NULL`,
      )
      .all() as { id: string; container_id: string | null }[];
  }

  /** After restart: mark uncertain in-flight jobs failed without auto-retry. */
  recoverAfterRestart(): number {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE jobs SET
          status = 'failed',
          error = COALESCE(error, 'worker restarted while job was in-flight; not auto-retried'),
          updated_at = ?,
          finished_at = COALESCE(finished_at, ?)
         WHERE status IN ('preparing', 'running', 'cancelling', 'awaiting_followup')`,
      )
      .run(now, now);
    return result.changes;
  }

  assertOwner(jobId: string, ownerId: string): JobRecord {
    const job = this.getJob(jobId);
    if (!job) throw new AuthError("job not found");
    if (job.owner_id !== ownerId) throw new AuthError("unauthorized");
    return job;
  }
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export function isTerminal(status: JobStatus): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "timed_out"
  );
}
