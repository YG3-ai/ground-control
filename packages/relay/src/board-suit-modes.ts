/**
 * YG3 / GROUND / ARCHIVE suit HUD models (duplicated in board.html).
 */

import { collectGroundProjectHistory } from "./board-ground-history.js";
import { resolveCurrentProjectFromBoard } from "./board-home-intelligence.js";
import {
  buildGroundCurrentProjectRow,
  GROUND_CURRENT_PROJECT_RESTING_LABEL,
  buildGroundJobRow,
  buildGroundSessionRow,
  countActiveGroundJobs,
  countActiveGroundTerminals,
  groundSectionMeta,
  type GroundHeaderState,
  type GroundRow,
  type GroundSection,
} from "./board-ground-present.js";
import { openTerminalSessions } from "./board-session-activity.js";

const GENERIC_SESSION_NOTE_RE = /^Session cwd is/i;

export type SuitSignal = { label: string; value: string; unit: string };

export type Yg3SuitHud = {
  kicker: string;
  title: string;
  windowTag: string | null;
  pending: boolean;
  signals: SuitSignal[];
};

export type { GroundRow, GroundSection, GroundHeaderState };

export type GroundSuitHud = {
  kicker: string;
  title: string;
  hydrated: boolean;
  sections: GroundSection[];
};

export type ArchiveNoteRow = { slug: string; title: string; excerpt?: string };

export function canonicalArchiveKey(item: { slug?: string; id?: string }): string {
  const slug = item.slug ? String(item.slug).trim() : "";
  if (slug) return slug;
  return item.id ? String(item.id).trim() : "";
}

export function normalizeArchiveSearchItem(
  raw: Record<string, unknown>,
  searchMode = false,
): ArchiveNoteRow | null {
  const slug = raw.slug ? String(raw.slug).trim() : "";
  const title = raw.title ? String(raw.title).trim() : "";
  if (!slug || !title) return null;
  if (searchMode && !slug.includes("/")) return null;
  let excerpt = raw.excerpt ? String(raw.excerpt).trim() : "";
  if (excerpt === title) excerpt = "";
  return { slug, title, excerpt: excerpt || undefined };
}

export function dedupeArchiveItems(items: ArchiveNoteRow[]): ArchiveNoteRow[] {
  const seen = new Set<string>();
  const out: ArchiveNoteRow[] = [];
  for (const it of items) {
    const key = canonicalArchiveKey(it);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

export type ArchiveSuitHud = {
  kicker: string;
  title: string;
  searchEnabled: boolean;
  recent: ArchiveNoteRow[];
};

export type GrowthLike = {
  ok?: boolean;
  health?: string;
  window?: string | null;
  summary?: {
    visits?: number | null;
    signups?: number | null;
    trials?: number | null;
    activation?: number | null;
    demandSignups?: number | null;
  };
  outbound?: { sent?: number | null; replies?: number | null };
};

function metricSignal(label: string, n: number | null | undefined, unit: string): SuitSignal | null {
  if (n == null || !Number.isFinite(n) || n <= 0) return null;
  return { label, value: String(n), unit };
}

function workspaceBasename(ws: string): string {
  return ws.split("/").filter(Boolean).pop() || "";
}

export function formatTerminalSessionLabel(s: Record<string, unknown>): {
  primary: string;
  secondary: string;
} {
  const kind = String(s.kind || "shell");
  const ws = s.workspace ? String(s.workspace) : s.cwd ? String(s.cwd) : "";
  const base = workspaceBasename(ws);
  const note = s.note ? String(s.note).trim() : "";
  const usefulNote =
    note && !GENERIC_SESSION_NOTE_RE.test(note) && !/not an OS sandbox/i.test(note);
  let primary: string;
  if (usefulNote) {
    const snippet = note.length > 34 ? note.slice(0, 33) + "…" : note;
    primary = kind + " · " + snippet;
  } else if (base) {
    primary = kind + " · " + base;
  } else {
    const id = String(s.id || "");
    primary = id ? kind + " · " + id.slice(-6) : kind;
  }
  return {
    primary: primary.length > 48 ? primary.slice(0, 47) + "…" : primary,
    secondary: String(s.state || "open"),
  };
}

export function buildYg3SuitHud(
  growth: GrowthLike | null | undefined,
  owner: boolean,
  growthLoaded: boolean,
): Yg3SuitHud {
  const kicker = owner ? "YG3" : "OUTPUT";
  const title = owner ? "BUSINESS" : "PREVIEW";
  const pending = !growthLoaded;
  if (!growthLoaded || !growth || !growth.ok) {
    return { kicker, title, windowTag: null, pending, signals: [] };
  }
  const s = growth.summary || {};
  const ob = growth.outbound || {};
  const signals: SuitSignal[] = [];
  const push = (sig: SuitSignal | null) => {
    if (sig) signals.push(sig);
  };
  push(metricSignal("VISITS", s.visits, "VISITS"));
  if (owner) {
    push(metricSignal("SIGNUPS", s.signups, "SIGNUPS"));
    push(metricSignal("TRIALS", s.trials, "TRIALS"));
    push(metricSignal("DEMAND", s.demandSignups, "SIGNUPS"));
    push(metricSignal("ACTIVATION", s.activation, "USERS"));
    push(metricSignal("OUTBOUND", ob.sent, "SENT"));
    push(metricSignal("REPLIES", ob.replies, "REPLIES"));
  }
  const windowTag =
    growth.window && /^\d+$/.test(String(growth.window))
      ? String(growth.window) + "D"
      : growth.window
        ? String(growth.window).toUpperCase()
        : null;
  return { kicker, title, windowTag, pending: false, signals };
}

type BoardLike = {
  public_preview?: boolean;
  columns?: Record<string, Array<Record<string, unknown>>>;
  tasks?: Array<Record<string, unknown>>;
  active_tasks?: Array<Record<string, unknown>>;
  terminal_sessions?: Array<Record<string, unknown>>;
};

export function boardOwnerHydratedForGround(
  board: BoardLike | null | undefined,
  owner: boolean,
): boolean {
  if (!owner) return false;
  if (!board) return false;
  return !board.public_preview;
}

function groundSection(
  id: GroundSection["id"],
  label: string,
  rows: GroundRow[],
  activeCount: number,
  emptyLabel: string,
): GroundSection {
  return {
    id,
    label,
    rows,
    rowCount: rows.length,
    emptyLabel,
    ...groundSectionMeta(id, rows.length, activeCount),
  };
}

export function buildGroundSuitHud(
  board: BoardLike | null | undefined,
  owner: boolean,
  missionTitle: (id: string) => string,
  nowMs = Date.now(),
): GroundSuitHud {
  const hydrated = boardOwnerHydratedForGround(board, owner);
  const kicker = owner ? "GROUND" : "ENGINE";
  const title = owner ? "WORK" : "PREVIEW";
  const emptySections: GroundSection[] = [];
  if (!hydrated || !board) {
    return { kicker, title, hydrated, sections: emptySections };
  }
  const current = resolveCurrentProjectFromBoard(board as Record<string, unknown>);
  const currentRows: GroundRow[] = current
    ? [
        buildGroundCurrentProjectRow(
          current.missionId,
          current.title,
          current.statusLabel,
        ),
      ]
    : [];
  const tasks = (board.tasks || board.active_tasks || []) as Array<Record<string, unknown>>;
  const jobRows: GroundRow[] = [];
  for (const t of tasks) {
    const row = buildGroundJobRow(t, missionTitle, nowMs);
    if (row) jobRows.push(row);
  }
  const sessions = (board.terminal_sessions || []) as Array<Record<string, unknown>>;
  const sorted = openTerminalSessions(sessions).sort((a, b) => {
    const rank = (st: string) => (st === "running" ? 0 : st === "waiting" ? 1 : 2);
    return rank(String(a.state || "")) - rank(String(b.state || ""));
  });
  const sessionRows: GroundRow[] = [];
  for (const s of sorted) {
    const row = buildGroundSessionRow(s, nowMs);
    if (row) sessionRows.push(row);
  }
  const jobActive = countActiveGroundJobs(tasks);
  const termActive = countActiveGroundTerminals(sessions, nowMs);
  const historyRows: GroundRow[] = collectGroundProjectHistory(board, nowMs);
  const sections: GroundSection[] = [
    groundSection(
      "current_project",
      "CURRENT PROJECT",
      currentRows,
      currentRows.length,
      GROUND_CURRENT_PROJECT_RESTING_LABEL,
    ),
    groundSection("jobs", "JOBS", jobRows, jobActive, "No active jobs"),
    groundSection("terminals", "TERMINALS", sessionRows, termActive, "No open terminals"),
    groundSection(
      "history",
      "RECENT PROJECTS",
      historyRows,
      0,
      "No completed projects yet",
    ),
  ];
  return { kicker, title, hydrated, sections };
}

export function buildArchiveSuitHud(
  owner: boolean,
  feed: { ok?: boolean; items?: Array<{ slug?: string; title?: string }> } | null,
): ArchiveSuitHud {
  return {
    kicker: owner ? "ARCHIVE" : "MEMORY",
    title: owner ? "RETRIEVAL" : "LOCKED",
    searchEnabled: owner,
    recent:
      owner && feed?.ok && feed.items
        ? feed.items
            .filter((i) => i.slug && i.title)
            .slice(0, 8)
            .map((i) => ({ slug: String(i.slug), title: String(i.title) }))
        : [],
  };
}

export function suitHudHasNoPlaceholderZeros(signals: SuitSignal[]): boolean {
  return !signals.some((s) => s.value === "0" || s.value === "—");
}
