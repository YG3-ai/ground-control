import type { BrainFeedPayload, BrainReadPayload } from "./brain.js";
import {
  publicBoardFictionSnapshot,
  publicNoteFictionRead,
  publicNotesFictionFeed,
} from "./public-fiction.js";
import type { GrowthFeedPayload } from "./growth.js";
import type { LifecycleFeedPayload } from "./lifecycle.js";

/** Email-like tokens in extension copy (prospect / lead contact). */
const EMAIL_LIKE =
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

export function redactEmailLike(text: string): string {
  return text.replace(EMAIL_LIKE, "[contact redacted]");
}

export function extensionJsonHasEmailLike(json: string): boolean {
  EMAIL_LIKE.lastIndex = 0;
  return EMAIL_LIKE.test(json);
}

function redactDetail(detail: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail)) {
    if (k === "email") continue;
    out[k] =
      typeof v === "string" ? redactEmailLike(v) : v;
  }
  return out;
}

function opportunityShort(detail: Record<string, unknown>): string {
  const id = detail.opportunityId;
  return typeof id === "string" && id.length > 0 ? id.slice(0, 8) : "unknown";
}

function redactLifecycleRecommendation(
  r: LifecycleFeedPayload["recommendations"][number],
): LifecycleFeedPayload["recommendations"][number] {
  const detail = redactDetail(r.detail);
  const short = opportunityShort(detail);
  let title = redactEmailLike(r.title);
  let metric = redactEmailLike(r.metric);
  if (r.kind === "decision") {
    metric = short !== "unknown" ? `opportunity · ${short}` : "decision queue";
  } else if (r.kind === "build") {
    if (/^BUILD due:/i.test(r.title)) {
      title = `BUILD due · ${short}`;
    }
  } else if (r.kind === "proof") {
    if (/^Proof without use:/i.test(r.title)) {
      title = `Proof without use · ${short}`;
    }
  }
  return { ...r, title, metric, detail };
}

export function redactLifecycleForPublic(
  payload: LifecycleFeedPayload,
): LifecycleFeedPayload {
  if (!payload.ok) return payload;
  return {
    ...payload,
    recommendations: payload.recommendations.map(redactLifecycleRecommendation),
  };
}

export function redactGrowthForPublic(payload: GrowthFeedPayload): GrowthFeedPayload {
  return {
    ...payload,
    funnelRows: payload.funnelRows.map((row) => ({
      ...row,
      label: redactEmailLike(row.label),
    })),
    insights: payload.insights.map((ins) => ({
      ...ins,
      kicker: redactEmailLike(ins.kicker),
      body: redactEmailLike(ins.body),
    })),
    outbound: {
      ...payload.outbound,
      note: payload.outbound.note
        ? redactEmailLike(payload.outbound.note)
        : null,
    },
  };
}

export function isPublicBoardAudience(audience: string): boolean {
  return audience === "public";
}

type WorldEntityRow = {
  entity_id: string;
  entity_type: string;
  label: string;
  state: string | null;
  sensitivity: string;
  first_seen_at?: string;
  last_seen_at?: string;
};

export type WorldListPayload = {
  ok?: boolean;
  summary?: unknown;
  entities: WorldEntityRow[];
};

export type WorldEntityDetail = {
  entity: WorldEntityRow;
  aliases?: string[];
  facts?: { sensitivity?: string }[];
  relations?: { sensitivity?: string }[];
  history?: unknown[];
};

export function redactWorldListForPublic(payload: WorldListPayload): WorldListPayload {
  return {
    ...payload,
    entities: payload.entities.filter((e) => e.sensitivity !== "private"),
  };
}

export function redactWorldEntityForPublic(
  detail: WorldEntityDetail | null,
): WorldEntityDetail | null {
  if (!detail?.entity) return null;
  if (detail.entity.sensitivity === "private") return null;
  return {
    ...detail,
    facts: (detail.facts ?? []).filter((f) => f.sensitivity !== "private"),
    relations: (detail.relations ?? []).filter((r) => r.sensitivity !== "private"),
  };
}

/** Public preview: no note titles, slugs, or bodies. */
export function redactBrainFeedForPublic(
  payload: BrainFeedPayload,
): BrainFeedPayload {
  const demo = publicNotesFictionFeed();
  return {
    ok: true,
    health: "ok",
    measuredAt: demo.measuredAt ?? payload.measuredAt,
    items: demo.items,
    error: undefined,
  };
}

export function redactBrainReadForPublic(slug?: string): BrainReadPayload {
  const s = (slug ?? "").trim();
  if (s.startsWith("notes/demo/")) {
    return publicNoteFictionRead(s);
  }
  return { ok: false, slug: s, error: "unauthorized" };
}

/** Allowlisted anonymous board projection — no operational fields from the live snapshot. */
export const PUBLIC_BOARD_ALLOWLIST = [
  "at",
  "public_preview",
  "health",
  "owner",
  "missions",
  "columns",
  "approvals",
  "tasks",
  "active_tasks",
  "recent_tasks",
  "terminal_sessions",
  "kpis",
  "usage",
  "system_state",
  "user_led_project",
] as const;

/** Anonymous board reads always return deterministic fiction — never live worker payloads. */
export function redactBoardForPublic(
  _board: Record<string, unknown>,
): Record<string, unknown> {
  const fiction = publicBoardFictionSnapshot();
  const out: Record<string, unknown> = {};
  for (const key of PUBLIC_BOARD_ALLOWLIST) {
    if (fiction[key] !== undefined) out[key] = fiction[key];
  }
  return out;
}
