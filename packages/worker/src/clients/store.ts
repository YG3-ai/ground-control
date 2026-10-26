import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type ClientRequestStatus =
  | "queued"
  | "in_progress"
  | "done"
  | "deferred"
  | "cancelled";

export type ClientRequest = {
  id: string;
  owner_id: string;
  client_id: string;
  client_name: string;
  workspace: string;
  from_email: string | null;
  subject: string;
  body: string;
  status: ClientRequestStatus;
  mission_id: string | null;
  job_id: string | null;
  fix_summary: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export type ClientDef = {
  id: string;
  name: string;
  workspace: string;
  aliases?: string[];
  update_to?: string;
};

type Row = {
  id: string;
  owner_id: string;
  client_id: string;
  client_name: string;
  workspace: string;
  from_email: string | null;
  subject: string;
  body: string;
  status: string;
  mission_id: string | null;
  job_id: string | null;
  fix_summary: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

function nowIso(): string {
  return new Date().toISOString();
}

function rowToReq(row: Row): ClientRequest {
  return {
    ...row,
    status: row.status as ClientRequestStatus,
  };
}

export class ClientRequestStore {
  readonly db: Database.Database;
  /**
   * Optional event sink (Ground Life Mirror). Receives ids/status/timestamps
   * ONLY — never subject, body, from_email, or fix_summary (those are content).
   */
  onEvent?: import("../events/types.js").EventSink;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS client_requests (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        client_name TEXT NOT NULL,
        workspace TEXT NOT NULL,
        from_email TEXT,
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL,
        mission_id TEXT,
        job_id TEXT,
        fix_summary TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS client_req_owner_status
        ON client_requests(owner_id, status, created_at);
      CREATE INDEX IF NOT EXISTS client_req_client
        ON client_requests(owner_id, client_id, created_at DESC);
    `);
  }

  close(): void {
    this.db.close();
  }

  create(input: {
    ownerId: string;
    client: ClientDef;
    fromEmail?: string;
    subject: string;
    body: string;
    missionId?: string;
  }): ClientRequest {
    const id = randomUUID();
    const now = nowIso();
    const rec: ClientRequest = {
      id,
      owner_id: input.ownerId,
      client_id: input.client.id,
      client_name: input.client.name,
      workspace: input.client.workspace,
      from_email: input.fromEmail ?? null,
      subject: input.subject.slice(0, 500),
      body: input.body.slice(0, 50_000),
      status: "queued",
      mission_id: input.missionId ?? null,
      job_id: null,
      fix_summary: null,
      created_at: now,
      updated_at: now,
      completed_at: null,
    };
    this.db
      .prepare(
        `INSERT INTO client_requests (
          id, owner_id, client_id, client_name, workspace, from_email, subject, body,
          status, mission_id, job_id, fix_summary, created_at, updated_at, completed_at
        ) VALUES (
          @id, @owner_id, @client_id, @client_name, @workspace, @from_email, @subject, @body,
          @status, @mission_id, @job_id, @fix_summary, @created_at, @updated_at, @completed_at
        )`,
      )
      .run(rec);
    this.emitEvent(rec, "client_request.created", null, rec.status, "created");
    return rec;
  }

  private emitEvent(
    rec: ClientRequest,
    verb: string,
    fromState: string | null,
    toState: string,
    dedupeKey: string,
  ): void {
    if (!this.onEvent) return;
    const evidence = [`request:${rec.id}`, `client:${rec.client_id}`];
    if (rec.mission_id) evidence.push(`mission:${rec.mission_id}`);
    this.onEvent({
      source: "clients",
      sourceRef: rec.id,
      actor: "owner",
      verb,
      objectType: "client_request",
      objectId: rec.id,
      fromState,
      toState,
      occurredAt: rec.updated_at,
      evidenceRefs: evidence,
      sensitivity: "private",
      dedupeKey,
    });
  }

  get(ownerId: string, id: string): ClientRequest | null {
    const row = this.db
      .prepare(`SELECT * FROM client_requests WHERE id = ? AND owner_id = ?`)
      .get(id, ownerId) as Row | undefined;
    return row ? rowToReq(row) : null;
  }

  list(
    ownerId: string,
    opts?: { clientId?: string; status?: ClientRequestStatus; limit?: number },
  ): ClientRequest[] {
    const limit = Math.min(opts?.limit ?? 40, 100);
    let sql = `SELECT * FROM client_requests WHERE owner_id = ?`;
    const params: unknown[] = [ownerId];
    if (opts?.clientId) {
      sql += ` AND client_id = ?`;
      params.push(opts.clientId);
    }
    if (opts?.status) {
      sql += ` AND status = ?`;
      params.push(opts.status);
    }
    sql += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);
    return (this.db.prepare(sql).all(...params) as Row[]).map(rowToReq);
  }

  update(
    ownerId: string,
    id: string,
    patch: {
      status?: ClientRequestStatus;
      missionId?: string | null;
      jobId?: string | null;
      fixSummary?: string | null;
    },
  ): ClientRequest {
    const cur = this.get(ownerId, id);
    if (!cur) throw new Error(`client request not found: ${id}`);
    const prevStatus = cur.status;
    if (patch.status) cur.status = patch.status;
    if (patch.missionId !== undefined) cur.mission_id = patch.missionId;
    if (patch.jobId !== undefined) cur.job_id = patch.jobId;
    if (patch.fixSummary !== undefined) cur.fix_summary = patch.fixSummary;
    if (patch.status === "done" && !cur.completed_at) {
      cur.completed_at = nowIso();
    }
    cur.updated_at = nowIso();
    this.db
      .prepare(
        `UPDATE client_requests SET
          status=@status, mission_id=@mission_id, job_id=@job_id,
          fix_summary=@fix_summary, updated_at=@updated_at, completed_at=@completed_at
         WHERE id=@id AND owner_id=@owner_id`,
      )
      .run(cur);
    if (cur.status !== prevStatus) {
      this.emitEvent(
        cur,
        "client_request.status_changed",
        prevStatus,
        cur.status,
        `status:${prevStatus}>${cur.status}:${cur.updated_at}`,
      );
    }
    return cur;
  }

  /**
   * Build a client update email draft from completed requests since `sinceIso`
   * (or last 24h). Writes markdown to draftsDir and returns path + body.
   */
  draftUpdateEmail(input: {
    ownerId: string;
    client: ClientDef;
    draftsDir: string;
    sinceIso?: string;
    fromYou?: string;
  }): {
    path: string;
    subject: string;
    body: string;
    items: ClientRequest[];
  } {
    const since =
      input.sinceIso ??
      new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const items = (
      this.db
        .prepare(
          `SELECT * FROM client_requests
           WHERE owner_id = ? AND client_id = ? AND status = 'done'
             AND completed_at IS NOT NULL AND completed_at >= ?
           ORDER BY completed_at ASC`,
        )
        .all(input.ownerId, input.client.id, since) as Row[]
    ).map(rowToReq);

    const dateLabel = new Date().toISOString().slice(0, 10);
    const subject = `${input.client.name} — update ${dateLabel}`;
    const lines: string[] = [
      `Hi ${input.client.name} team,`,
      ``,
      `Quick update from my side on recent fixes:`,
      ``,
    ];
    if (items.length === 0) {
      lines.push(`- No completed items in this window (since ${since.slice(0, 16)}).`);
    } else {
      for (const it of items) {
        const summary = (it.fix_summary || it.subject).trim();
        lines.push(`- ${summary}`);
      }
    }
    lines.push(
      ``,
      `Happy to dig into anything still open — just reply to this thread.`,
      ``,
      input.fromYou?.trim() || "— Partha",
      ``,
    );
    const body = lines.join("\n");
    mkdirSync(input.draftsDir, { recursive: true });
    const filename = `${input.client.id}-update-${dateLabel}-${Date.now()}.md`;
    const path = join(input.draftsDir, filename);
    writeFileSync(
      path,
      [`# Draft (not sent)`, ``, `To: ${input.client.update_to ?? "(set update_to)"}`, `Subject: ${subject}`, ``, body].join(
        "\n",
      ),
      "utf8",
    );
    return { path, subject, body, items };
  }
}

export function resolveClient(
  clients: ClientDef[],
  query: string,
): ClientDef | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  for (const c of clients) {
    if (c.id.toLowerCase() === q) return c;
    if (c.name.toLowerCase() === q) return c;
    if (c.aliases?.some((a) => a.toLowerCase() === q)) return c;
    if (c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q)) {
      return c;
    }
  }
  return null;
}
