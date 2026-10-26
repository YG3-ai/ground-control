import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type UsageAgent = "cursor" | "kimi";

export type UsageEvent = {
  id: number;
  agent: UsageAgent;
  kind: "start" | "finish" | "rate_limited" | "blocked";
  job_id: string | null;
  tier: string | null;
  model: string | null;
  detail: string | null;
  created_at: string;
};

export type AgentUsagePolicy = {
  /** Rolling window used for pacing (Kimi ≈ 5h). */
  window_sec: number;
  /** Max agent starts inside the rolling window. */
  max_starts_per_window: number;
  /** Minimum seconds between starts for this agent. */
  min_gap_sec: number;
  /** Max concurrent in-flight managed jobs. */
  max_concurrent: number;
  /** Default model when caller omits one. */
  default_model: string | null;
  /** Model for research / triage / ask passes. */
  research_model: string | null;
  /** Model for implementation / bugfix writes. */
  implement_model: string | null;
  /** Cursor CLI --mode for research tier (ask|plan). */
  research_mode: "ask" | "plan" | null;
  /** Seconds to pause after detecting a rate-limit. */
  cooldown_after_rate_limit_sec: number;
};

export const DEFAULT_CURSOR_POLICY: AgentUsagePolicy = {
  window_sec: 5 * 3600,
  max_starts_per_window: 40,
  min_gap_sec: 30,
  max_concurrent: 1,
  default_model: "composer-2.5",
  research_model: "composer-2.5",
  implement_model: "composer-2.5",
  research_mode: "ask",
  cooldown_after_rate_limit_sec: 600,
};

/** Conservative pacing so the rolling 5h Kimi window lasts a workday. */
export const DEFAULT_KIMI_POLICY: AgentUsagePolicy = {
  window_sec: 5 * 3600,
  max_starts_per_window: 10,
  min_gap_sec: 12 * 60,
  max_concurrent: 1,
  default_model: "kimi-code/k3-256k",
  research_model: "kimi-code/k3-256k",
  implement_model: "kimi-code/k3-256k",
  research_mode: null,
  cooldown_after_rate_limit_sec: 30 * 60,
};

function nowIso(): string {
  return new Date().toISOString();
}

function nowMs(): number {
  return Date.now();
}

export function looksLikeRateLimit(text: string): boolean {
  const t = text.toLowerCase();
  return (
    t.includes("rate limit") ||
    t.includes("rate-limited") ||
    t.includes("too many requests") ||
    t.includes("quota exceeded") ||
    t.includes("usage limit") ||
    t.includes("5-hour") ||
    t.includes("5 hour") ||
    t.includes("rolling window") ||
    /\b429\b/.test(t)
  );
}

export class UsageLedger {
  readonly db: Database.Database;
  /** Optional event sink (Ground Life Mirror). Metadata only — never `detail`. */
  onEvent?: import("../events/types.js").EventSink;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent TEXT NOT NULL,
        kind TEXT NOT NULL,
        job_id TEXT,
        tier TEXT,
        model TEXT,
        detail TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS usage_agent_created
        ON usage_events(agent, created_at DESC);
    `);
  }

  close(): void {
    this.db.close();
  }

  record(input: {
    agent: UsageAgent;
    kind: UsageEvent["kind"];
    jobId?: string | null;
    tier?: string | null;
    model?: string | null;
    detail?: string | null;
  }): void {
    const createdAt = nowIso();
    const result = this.db
      .prepare(
        `INSERT INTO usage_events (agent, kind, job_id, tier, model, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.agent,
        input.kind,
        input.jobId ?? null,
        input.tier ?? null,
        input.model ?? null,
        input.detail ?? null,
        createdAt,
      );
    const rowId = Number(result.lastInsertRowid);
    const evidence = [`usage:${rowId}`];
    if (input.jobId) evidence.push(`job:${input.jobId}`);
    this.onEvent?.({
      source: "usage",
      sourceRef: `usage:${rowId}`,
      actor: `agent:${input.agent}`,
      verb: `usage.${input.kind}`,
      objectType: input.jobId ? "job" : "agent",
      objectId: input.jobId ?? input.agent,
      toState: input.kind,
      occurredAt: createdAt,
      evidenceRefs: evidence,
      sensitivity: "internal",
      dedupeKey: `row:${rowId}`,
    });
  }

  private recentStarts(agent: UsageAgent, windowSec: number): UsageEvent[] {
    const since = new Date(nowMs() - windowSec * 1000).toISOString();
    return this.db
      .prepare(
        `SELECT * FROM usage_events
         WHERE agent = ? AND kind = 'start' AND created_at >= ?
         ORDER BY created_at DESC`,
      )
      .all(agent, since) as UsageEvent[];
  }

  lastEvent(
    agent: UsageAgent,
    kind?: UsageEvent["kind"],
  ): UsageEvent | null {
    if (kind) {
      return (
        (this.db
          .prepare(
            `SELECT * FROM usage_events WHERE agent = ? AND kind = ?
             ORDER BY created_at DESC LIMIT 1`,
          )
          .get(agent, kind) as UsageEvent | undefined) ?? null
      );
    }
    return (
      (this.db
        .prepare(
          `SELECT * FROM usage_events WHERE agent = ?
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(agent) as UsageEvent | undefined) ?? null
    );
  }

  /**
   * Decide whether a new start is allowed under the rolling window policy.
   */
  checkBudget(
    agent: UsageAgent,
    policy: AgentUsagePolicy,
    concurrentInFlight: number,
  ): {
    allowed: boolean;
    reason: string | null;
    retry_after_sec: number | null;
    starts_in_window: number;
    window_sec: number;
    max_starts_per_window: number;
  } {
    if (concurrentInFlight >= policy.max_concurrent) {
      return {
        allowed: false,
        reason: `${agent} already has ${concurrentInFlight} in-flight job(s); max_concurrent=${policy.max_concurrent}`,
        retry_after_sec: 60,
        starts_in_window: this.recentStarts(agent, policy.window_sec).length,
        window_sec: policy.window_sec,
        max_starts_per_window: policy.max_starts_per_window,
      };
    }

    const rateLimited = this.lastEvent(agent, "rate_limited");
    if (rateLimited) {
      const elapsed =
        (nowMs() - Date.parse(rateLimited.created_at)) / 1000;
      const cool = policy.cooldown_after_rate_limit_sec;
      if (elapsed < cool) {
        return {
          allowed: false,
          reason: `${agent} cooling down after rate limit (${Math.ceil(cool - elapsed)}s left)`,
          retry_after_sec: Math.ceil(cool - elapsed),
          starts_in_window: this.recentStarts(agent, policy.window_sec).length,
          window_sec: policy.window_sec,
          max_starts_per_window: policy.max_starts_per_window,
        };
      }
    }

    const starts = this.recentStarts(agent, policy.window_sec);
    if (starts.length >= policy.max_starts_per_window) {
      const oldest = starts[starts.length - 1]!;
      const ageSec = (nowMs() - Date.parse(oldest.created_at)) / 1000;
      const retry = Math.max(1, Math.ceil(policy.window_sec - ageSec));
      return {
        allowed: false,
        reason: `${agent} hit max_starts_per_window=${policy.max_starts_per_window} in rolling ${policy.window_sec}s (protects the 5h usage window)`,
        retry_after_sec: retry,
        starts_in_window: starts.length,
        window_sec: policy.window_sec,
        max_starts_per_window: policy.max_starts_per_window,
      };
    }

    const lastStart = starts[0];
    if (lastStart && policy.min_gap_sec > 0) {
      const gap = (nowMs() - Date.parse(lastStart.created_at)) / 1000;
      if (gap < policy.min_gap_sec) {
        return {
          allowed: false,
          reason: `${agent} min_gap_sec=${policy.min_gap_sec} not met (${Math.ceil(policy.min_gap_sec - gap)}s left)`,
          retry_after_sec: Math.ceil(policy.min_gap_sec - gap),
          starts_in_window: starts.length,
          window_sec: policy.window_sec,
          max_starts_per_window: policy.max_starts_per_window,
        };
      }
    }

    return {
      allowed: true,
      reason: null,
      retry_after_sec: null,
      starts_in_window: starts.length,
      window_sec: policy.window_sec,
      max_starts_per_window: policy.max_starts_per_window,
    };
  }

  snapshot(agent: UsageAgent, policy: AgentUsagePolicy) {
    const starts = this.recentStarts(agent, policy.window_sec);
    const budget = this.checkBudget(agent, policy, 0);
    const lastRate = this.lastEvent(agent, "rate_limited");
    return {
      agent,
      policy: {
        window_sec: policy.window_sec,
        max_starts_per_window: policy.max_starts_per_window,
        min_gap_sec: policy.min_gap_sec,
        max_concurrent: policy.max_concurrent,
        default_model: policy.default_model,
        research_model: policy.research_model,
        implement_model: policy.implement_model,
        research_mode: policy.research_mode,
      },
      starts_in_window: starts.length,
      starts_remaining: Math.max(
        0,
        policy.max_starts_per_window - starts.length,
      ),
      last_start_at: starts[0]?.created_at ?? null,
      last_rate_limited_at: lastRate?.created_at ?? null,
      would_allow_now: budget.allowed,
      block_reason: budget.reason,
      retry_after_sec: budget.retry_after_sec,
    };
  }
}

export function resolveModelForTier(
  policy: AgentUsagePolicy,
  tier: string | undefined,
  explicit?: string | null,
): string | null {
  if (explicit) return explicit;
  if (tier === "research" || tier === "triage") {
    return policy.research_model ?? policy.default_model;
  }
  if (tier === "implement" || tier === "bugfix") {
    return policy.implement_model ?? policy.default_model;
  }
  return policy.default_model;
}
