import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { EventSensitivity } from "../events/types.js";
import type {
  CandidateDecisionAction,
  CandidateFilters,
  CandidateKind,
  CandidateStatus,
  InterpretationCandidate,
  InterpretationDecision,
  MeaningRebuildReport,
} from "./types.js";

export const MEANING_SCHEMA_VERSION = 1;

type CandidateRow = {
  candidate_id: string;
  kind: string;
  proposed_label: string;
  proposed_description: string | null;
  status: string;
  confidence: number;
  maturity: string | null;
  entity_ids: string;
  evidence_event_ids: string;
  rule_id: string;
  rule_version: number;
  sensitivity: string;
  proposed_at: string;
  updated_at: string;
  accepted_at: string | null;
  corrected_label: string | null;
  correction_note: string | null;
  supersedes: string | null;
  corrects: string | null;
};

type DecisionRow = {
  candidate_id: string;
  decision: string;
  corrected_label: string | null;
  correction_note: string | null;
  decided_at: string;
  decided_by: string;
};

function parseIds(raw: string): string[] {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function rowToCandidate(row: CandidateRow): InterpretationCandidate {
  return {
    candidate_id: row.candidate_id,
    kind: row.kind as CandidateKind,
    proposed_label: row.proposed_label,
    proposed_description: row.proposed_description ?? undefined,
    status: row.status as CandidateStatus,
    confidence: row.confidence,
    maturity: (row.maturity ?? undefined) as
      | InterpretationCandidate["maturity"]
      | undefined,
    entity_ids: parseIds(row.entity_ids),
    evidence_event_ids: parseIds(row.evidence_event_ids),
    rule_id: row.rule_id,
    rule_version: row.rule_version,
    sensitivity: row.sensitivity as EventSensitivity,
    proposed_at: row.proposed_at,
    updated_at: row.updated_at,
    accepted_at: row.accepted_at,
    corrected_label: row.corrected_label,
    correction_note: row.correction_note,
    supersedes: row.supersedes,
    corrects: row.corrects,
  };
}

function rowToDecision(row: DecisionRow): InterpretationDecision {
  return {
    candidate_id: row.candidate_id,
    decision: row.decision as CandidateDecisionAction,
    corrected_label: row.corrected_label,
    correction_note: row.correction_note,
    decided_at: row.decided_at,
    decided_by: row.decided_by,
  };
}

/**
 * Meaning store (meaning.db, WAL, beside events.db/world.db).
 * `candidates` is derived and rebuildable (wipe+regenerate); `decisions` and
 * `decision_log` are the DURABLE owner overlay — never wiped. Overlays key on
 * the deterministic candidate_id, so a rebuild that regenerates the same
 * candidate re-applies the owner's accept/dismiss/correct.
 */
export class MeaningStore {
  readonly db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS candidates (
        candidate_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        proposed_label TEXT NOT NULL,
        proposed_description TEXT,
        status TEXT NOT NULL DEFAULT 'proposed',
        confidence REAL NOT NULL,
        maturity TEXT,
        entity_ids TEXT NOT NULL DEFAULT '[]',
        evidence_event_ids TEXT NOT NULL DEFAULT '[]',
        rule_id TEXT NOT NULL,
        rule_version INTEGER NOT NULL,
        sensitivity TEXT NOT NULL DEFAULT 'internal',
        proposed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        accepted_at TEXT,
        corrected_label TEXT,
        correction_note TEXT,
        supersedes TEXT,
        corrects TEXT
      );
      CREATE INDEX IF NOT EXISTS candidates_kind_status
        ON candidates(kind, status);
      CREATE TABLE IF NOT EXISTS decisions (
        candidate_id TEXT PRIMARY KEY,
        decision TEXT NOT NULL,
        corrected_label TEXT,
        correction_note TEXT,
        decided_at TEXT NOT NULL,
        decided_by TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS decision_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        candidate_id TEXT NOT NULL,
        decision TEXT NOT NULL,
        corrected_label TEXT,
        correction_note TEXT,
        decided_at TEXT NOT NULL,
        decided_by TEXT NOT NULL
      );
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
   * Wipe + regenerate candidates, then re-apply the durable decision overlay.
   * Same candidates + same decisions in → byte-identical rows out.
   */
  replaceCandidates(candidates: InterpretationCandidate[]): void {
    const decisions = this.allDecisions();
    const byId = new Map(decisions.map((d) => [d.candidate_id, d]));
    const tx = this.db.transaction(() => {
      this.db.exec(`DELETE FROM candidates`);
      const ins = this.db.prepare(
        `INSERT INTO candidates (
          candidate_id, kind, proposed_label, proposed_description, status,
          confidence, maturity, entity_ids, evidence_event_ids, rule_id,
          rule_version, sensitivity, proposed_at, updated_at, accepted_at,
          corrected_label, correction_note, supersedes, corrects
        ) VALUES (
          @candidate_id, @kind, @proposed_label, @proposed_description, @status,
          @confidence, @maturity, @entity_ids, @evidence_event_ids, @rule_id,
          @rule_version, @sensitivity, @proposed_at, @updated_at, @accepted_at,
          @corrected_label, @correction_note, @supersedes, @corrects
        )`,
      );
      for (const c of candidates) {
        ins.run(this.applyOverlay(c, byId.get(c.candidate_id)));
      }
      this.db
        .prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run(String(MEANING_SCHEMA_VERSION));
    });
    tx();
  }

  /** Overlay mutates status/accepted_at/corrected_* only — never the proposal. */
  private applyOverlay(
    c: InterpretationCandidate,
    d: InterpretationDecision | undefined,
  ): Record<string, unknown> {
    let status: CandidateStatus = "proposed";
    let accepted_at: string | null = null;
    let corrected_label: string | null = null;
    let correction_note: string | null = null;
    if (d) {
      if (d.decision === "accept") {
        status = "accepted";
        accepted_at = d.decided_at;
      } else if (d.decision === "dismiss") {
        status = "dismissed";
      } else if (d.decision === "correct") {
        status = "corrected";
        corrected_label = d.corrected_label;
        correction_note = d.correction_note;
      }
    }
    return {
      candidate_id: c.candidate_id,
      kind: c.kind,
      proposed_label: c.proposed_label,
      proposed_description: c.proposed_description ?? null,
      status,
      confidence: c.confidence,
      maturity: c.maturity ?? null,
      entity_ids: JSON.stringify(c.entity_ids),
      evidence_event_ids: JSON.stringify(c.evidence_event_ids),
      rule_id: c.rule_id,
      rule_version: c.rule_version,
      sensitivity: c.sensitivity,
      proposed_at: c.proposed_at,
      updated_at: c.updated_at,
      accepted_at,
      corrected_label,
      correction_note,
      supersedes: c.supersedes ?? null,
      corrects: c.corrects ?? null,
    };
  }

  /**
   * Record an owner decision. Durable (decisions + append-only decision_log)
   * and immediately reflected on the candidate row when it exists. A decision
   * for a candidate that is not currently generated is still stored — it
   * re-applies if a future rebuild regenerates that deterministic id.
   */
  applyDecision(input: {
    candidate_id: string;
    decision: CandidateDecisionAction;
    corrected_label?: string | null;
    correction_note?: string | null;
    decided_at: string;
    decided_by: string;
  }): InterpretationDecision {
    const row: InterpretationDecision = {
      candidate_id: input.candidate_id,
      decision: input.decision,
      corrected_label:
        input.decision === "correct" ? (input.corrected_label ?? null) : null,
      correction_note: input.correction_note ?? null,
      decided_at: input.decided_at,
      decided_by: input.decided_by,
    };
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO decisions (
            candidate_id, decision, corrected_label, correction_note,
            decided_at, decided_by
          ) VALUES (
            @candidate_id, @decision, @corrected_label, @correction_note,
            @decided_at, @decided_by
          )
          ON CONFLICT(candidate_id) DO UPDATE SET
            decision = excluded.decision,
            corrected_label = excluded.corrected_label,
            correction_note = excluded.correction_note,
            decided_at = excluded.decided_at,
            decided_by = excluded.decided_by`,
        )
        .run(row);
      this.db
        .prepare(
          `INSERT INTO decision_log (
            candidate_id, decision, corrected_label, correction_note,
            decided_at, decided_by
          ) VALUES (
            @candidate_id, @decision, @corrected_label, @correction_note,
            @decided_at, @decided_by
          )`,
        )
        .run(row);
      const cur = this.db
        .prepare(`SELECT * FROM candidates WHERE candidate_id = ?`)
        .get(row.candidate_id) as CandidateRow | undefined;
      if (cur) {
        const candidate = rowToCandidate(cur);
        const applied = this.applyOverlay(candidate, row);
        this.db
          .prepare(
            `UPDATE candidates SET
              status=@status, accepted_at=@accepted_at,
              corrected_label=@corrected_label, correction_note=@correction_note
             WHERE candidate_id=@candidate_id`,
          )
          .run(applied);
        }
    });
    tx();
    return row;
  }

  getDecision(candidateId: string): InterpretationDecision | null {
    const row = this.db
      .prepare(`SELECT * FROM decisions WHERE candidate_id = ?`)
      .get(candidateId) as DecisionRow | undefined;
    return row ? rowToDecision(row) : null;
  }

  allDecisions(): InterpretationDecision[] {
    const rows = this.db
      .prepare(`SELECT * FROM decisions ORDER BY decided_at ASC, candidate_id ASC`)
      .all() as DecisionRow[];
    return rows.map(rowToDecision);
  }

  decisionLog(): InterpretationDecision[] {
    const rows = this.db
      .prepare(`SELECT * FROM decision_log ORDER BY id ASC`)
      .all() as DecisionRow[];
    return rows.map(rowToDecision);
  }

  listCandidates(filters?: CandidateFilters): InterpretationCandidate[] {
    const where: string[] = [];
    const params: Record<string, string> = {};
    if (filters?.kind) {
      where.push("kind = @kind");
      params.kind = filters.kind;
    }
    if (filters?.status) {
      where.push("status = @status");
      params.status = filters.status;
    }
    if (filters?.sensitivity) {
      where.push("sensitivity = @sensitivity");
      params.sensitivity = filters.sensitivity;
    }
    if (!filters?.includePrivate) {
      where.push("sensitivity != 'private'");
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM candidates ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY updated_at DESC, candidate_id ASC`,
      )
      .all(params) as CandidateRow[];
    return rows.map(rowToCandidate);
  }

  getCandidate(
    id: string,
    opts?: { includePrivate?: boolean },
  ): { candidate: InterpretationCandidate; decision: InterpretationDecision | null } | null {
    const row = this.db
      .prepare(`SELECT * FROM candidates WHERE candidate_id = ?`)
      .get(id) as CandidateRow | undefined;
    if (!row) return null;
    const candidate = rowToCandidate(row);
    if (candidate.sensitivity === "private" && !opts?.includePrivate) {
      return null;
    }
    return { candidate, decision: this.getDecision(id) };
  }

  summary(opts?: { includePrivate?: boolean }): {
    candidates_total: number;
    by_kind: Record<string, number>;
    by_status: Record<string, number>;
    by_sensitivity: Record<string, number>;
    by_rule_id: Record<string, number>;
    decisions_total: number;
  } {
    const p = opts?.includePrivate ? "" : "WHERE sensitivity != 'private'";
    const rows = this.db
      .prepare(
        `SELECT kind, status, sensitivity, rule_id, COUNT(*) AS c
         FROM candidates ${p} GROUP BY kind, status, sensitivity, rule_id`,
      )
      .all() as {
      kind: string;
      status: string;
      sensitivity: string;
      rule_id: string;
      c: number;
    }[];
    const byKind: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    const bySensitivity: Record<string, number> = {};
    const byRule: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      byKind[r.kind] = (byKind[r.kind] ?? 0) + r.c;
      byStatus[r.status] = (byStatus[r.status] ?? 0) + r.c;
      bySensitivity[r.sensitivity] = (bySensitivity[r.sensitivity] ?? 0) + r.c;
      byRule[r.rule_id] = (byRule[r.rule_id] ?? 0) + r.c;
      total += r.c;
    }
    const decisions = this.db
      .prepare(`SELECT COUNT(*) AS c FROM decisions`)
      .get() as { c: number };
    return {
      candidates_total: total,
      by_kind: byKind,
      by_status: byStatus,
      by_sensitivity: bySensitivity,
      by_rule_id: byRule,
      decisions_total: decisions.c,
    };
  }

  /** Counts-only report of the last regeneration input. */
  countReport(candidates: InterpretationCandidate[]): MeaningRebuildReport {
    const byKind: Record<string, number> = {};
    const bySensitivity: Record<EventSensitivity, number> = {
      public: 0,
      internal: 0,
      private: 0,
    };
    const byRule: Record<string, number> = {};
    for (const c of candidates) {
      byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;
      bySensitivity[c.sensitivity] += 1;
      byRule[c.rule_id] = (byRule[c.rule_id] ?? 0) + 1;
    }
    return {
      candidates_total: candidates.length,
      by_kind: byKind,
      by_sensitivity: bySensitivity,
      by_rule_id: byRule,
    };
  }
}
