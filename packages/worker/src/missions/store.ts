import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const MISSION_STATUSES = [
  "intake",
  "researching",
  "plan_ready",
  "approved",
  "implementing",
  "verifying",
  "done",
  "blocked",
  "cancelled",
] as const;

export type MissionStatus = (typeof MISSION_STATUSES)[number];

export type MissionRecord = {
  id: string;
  owner_id: string;
  title: string;
  goal: string;
  workspace: string | null;
  status: MissionStatus;
  plan: string | null;
  findings: string | null;
  summary: string | null;
  linked_job_ids: string[];
  linked_session_ids: string[];
  /** Free-form status markers / KPIs for the whiteboard */
  markers: Record<string, string | number | boolean | null>;
  created_at: string;
  updated_at: string;
  approved_at: string | null;
  completed_at: string | null;
};

type MissionRow = {
  id: string;
  owner_id: string;
  title: string;
  goal: string;
  workspace: string | null;
  status: string;
  plan: string | null;
  findings: string | null;
  summary: string | null;
  linked_job_ids: string;
  linked_session_ids: string;
  markers: string;
  created_at: string;
  updated_at: string;
  approved_at: string | null;
  completed_at: string | null;
};

function nowIso(): string {
  return new Date().toISOString();
}

function parseJsonArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function parseMarkers(raw: string): MissionRecord["markers"] {
  try {
    const v = JSON.parse(raw) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return v as MissionRecord["markers"];
    }
  } catch {
    // ignore
  }
  return {};
}

function rowToMission(row: MissionRow): MissionRecord {
  return {
    id: row.id,
    owner_id: row.owner_id,
    title: row.title,
    goal: row.goal,
    workspace: row.workspace,
    status: row.status as MissionStatus,
    plan: row.plan,
    findings: row.findings,
    summary: row.summary,
    linked_job_ids: parseJsonArray(row.linked_job_ids),
    linked_session_ids: parseJsonArray(row.linked_session_ids),
    markers: parseMarkers(row.markers),
    created_at: row.created_at,
    updated_at: row.updated_at,
    approved_at: row.approved_at,
    completed_at: row.completed_at,
  };
}

export class MissionStore {
  readonly db: Database.Database;
  /** Optional event sink (Ground Life Mirror). Metadata only — never content. */
  onEvent?: import("../events/types.js").EventSink;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS missions (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        workspace TEXT,
        status TEXT NOT NULL,
        plan TEXT,
        findings TEXT,
        summary TEXT,
        linked_job_ids TEXT NOT NULL DEFAULT '[]',
        linked_session_ids TEXT NOT NULL DEFAULT '[]',
        markers TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        approved_at TEXT,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS missions_owner_updated
        ON missions(owner_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS missions_owner_status
        ON missions(owner_id, status);
    `);
  }

  close(): void {
    this.db.close();
  }

  create(input: {
    ownerId: string;
    title: string;
    goal: string;
    workspace?: string;
    markers?: MissionRecord["markers"];
  }): MissionRecord {
    const id = randomUUID();
    const now = nowIso();
    const rec: MissionRecord = {
      id,
      owner_id: input.ownerId,
      title: input.title.slice(0, 200),
      goal: input.goal.slice(0, 20_000),
      workspace: input.workspace?.slice(0, 500) ?? null,
      status: "intake",
      plan: null,
      findings: null,
      summary: null,
      linked_job_ids: [],
      linked_session_ids: [],
      markers: input.markers ?? {},
      created_at: now,
      updated_at: now,
      approved_at: null,
      completed_at: null,
    };
    this.db
      .prepare(
        `INSERT INTO missions (
          id, owner_id, title, goal, workspace, status, plan, findings, summary,
          linked_job_ids, linked_session_ids, markers,
          created_at, updated_at, approved_at, completed_at
        ) VALUES (
          @id, @owner_id, @title, @goal, @workspace, @status, @plan, @findings, @summary,
          @linked_job_ids, @linked_session_ids, @markers,
          @created_at, @updated_at, @approved_at, @completed_at
        )`,
      )
      .run({
        ...rec,
        linked_job_ids: JSON.stringify(rec.linked_job_ids),
        linked_session_ids: JSON.stringify(rec.linked_session_ids),
        markers: JSON.stringify(rec.markers),
      });
    this.onEvent?.({
      source: "missions",
      sourceRef: rec.id,
      actor: "owner",
      verb: "mission.created",
      objectType: "mission",
      objectId: rec.id,
      toState: rec.status,
      occurredAt: rec.created_at,
      evidenceRefs: [`mission:${rec.id}`],
      sensitivity: "internal",
      dedupeKey: "created",
    });
    return rec;
  }

  get(ownerId: string, id: string): MissionRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM missions WHERE id = ? AND owner_id = ?`)
      .get(id, ownerId) as MissionRow | undefined;
    return row ? rowToMission(row) : null;
  }

  list(
    ownerId: string,
    opts?: { status?: MissionStatus; limit?: number },
  ): MissionRecord[] {
    const limit = Math.min(opts?.limit ?? 40, 100);
    let rows: MissionRow[];
    if (opts?.status) {
      rows = this.db
        .prepare(
          `SELECT * FROM missions WHERE owner_id = ? AND status = ?
           ORDER BY updated_at DESC LIMIT ?`,
        )
        .all(ownerId, opts.status, limit) as MissionRow[];
    } else {
      rows = this.db
        .prepare(
          `SELECT * FROM missions WHERE owner_id = ?
           ORDER BY updated_at DESC LIMIT ?`,
        )
        .all(ownerId, limit) as MissionRow[];
    }
    return rows.map(rowToMission);
  }

  update(
    ownerId: string,
    id: string,
    patch: {
      title?: string;
      goal?: string;
      workspace?: string | null;
      status?: MissionStatus;
      plan?: string | null;
      findings?: string | null;
      summary?: string | null;
      markers?: MissionRecord["markers"];
      linkJobId?: string;
      linkSessionId?: string;
    },
  ): MissionRecord {
    const cur = this.get(ownerId, id);
    if (!cur) throw new Error(`mission not found: ${id}`);
    const prevStatus = cur.status;

    if (patch.title != null) cur.title = patch.title.slice(0, 200);
    if (patch.goal != null) cur.goal = patch.goal.slice(0, 20_000);
    if (patch.workspace !== undefined) {
      cur.workspace =
        patch.workspace === null ? null : patch.workspace.slice(0, 500);
    }
    if (patch.status != null) {
      if (!MISSION_STATUSES.includes(patch.status)) {
        throw new Error(`invalid status: ${patch.status}`);
      }
      cur.status = patch.status;
      if (patch.status === "approved" && !cur.approved_at) {
        cur.approved_at = nowIso();
      }
      if (patch.status === "done" && !cur.completed_at) {
        cur.completed_at = nowIso();
      }
    }
    if (patch.plan !== undefined) {
      cur.plan = patch.plan === null ? null : patch.plan.slice(0, 50_000);
    }
    if (patch.findings !== undefined) {
      cur.findings =
        patch.findings === null ? null : patch.findings.slice(0, 50_000);
    }
    if (patch.summary !== undefined) {
      cur.summary =
        patch.summary === null ? null : patch.summary.slice(0, 20_000);
    }
    if (patch.markers) {
      cur.markers = { ...cur.markers, ...patch.markers };
    }
    if (patch.linkJobId && !cur.linked_job_ids.includes(patch.linkJobId)) {
      cur.linked_job_ids = [...cur.linked_job_ids, patch.linkJobId].slice(-20);
    }
    if (
      patch.linkSessionId &&
      !cur.linked_session_ids.includes(patch.linkSessionId)
    ) {
      cur.linked_session_ids = [
        ...cur.linked_session_ids,
        patch.linkSessionId,
      ].slice(-20);
    }
    cur.updated_at = nowIso();

    this.db
      .prepare(
        `UPDATE missions SET
          title=@title, goal=@goal, workspace=@workspace, status=@status,
          plan=@plan, findings=@findings, summary=@summary,
          linked_job_ids=@linked_job_ids, linked_session_ids=@linked_session_ids,
          markers=@markers, updated_at=@updated_at,
          approved_at=@approved_at, completed_at=@completed_at
         WHERE id=@id AND owner_id=@owner_id`,
      )
      .run({
        ...cur,
        linked_job_ids: JSON.stringify(cur.linked_job_ids),
        linked_session_ids: JSON.stringify(cur.linked_session_ids),
        markers: JSON.stringify(cur.markers),
      });
    if (cur.status !== prevStatus) {
      this.onEvent?.({
        source: "missions",
        sourceRef: cur.id,
        actor: "owner",
        verb: "mission.status_changed",
        objectType: "mission",
        objectId: cur.id,
        fromState: prevStatus,
        toState: cur.status,
        occurredAt: cur.updated_at,
        evidenceRefs: [
          `mission:${cur.id}`,
          ...cur.linked_job_ids.map((j) => `job:${j}`),
        ],
        sensitivity: "internal",
        dedupeKey: `status:${prevStatus}>${cur.status}:${cur.updated_at}`,
      });
    }
    return cur;
  }
}
