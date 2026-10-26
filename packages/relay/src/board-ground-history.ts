/**
 * GROUND project history rows and human-readable completion detail — duplicated in board.html.
 */

import { formatGroundElapsed } from "./board-ground-present.js";

export type MissionHistoryLike = {
  id?: string;
  title?: string;
  status?: string;
  summary?: string | null;
  findings?: string | null;
  goal?: string | null;
  completed_at?: string | null;
  updated_at?: string | null;
  markers?: Record<string, string | number | boolean | null>;
};

export type GroundHistoryRow = {
  kind: "history";
  id: string;
  title: string;
  statusLabel: string;
  whenLabel: string;
};

export type MissionHistoryDetail = {
  title: string;
  statusLine: string;
  outcome: string;
  whatChanged: string;
  verification: string;
};

const TERMINAL_STATUS = new Set(["done", "cancelled"]);

const ORCHESTRATION_LINE_RE =
  /^(marker:|linked_job|mission_id|project_origin|cron:|worker:|orchestrat)/i;

function missionHistoryTimestamp(m: MissionHistoryLike): string {
  return String(m.completed_at || m.updated_at || "");
}

export function formatGroundHistoryWhen(
  iso: string | null | undefined,
  nowMs = Date.now(),
): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const rel = formatGroundElapsed(iso, nowMs);
  try {
    const abs = new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(new Date(t));
    return rel ? `${abs} · ${rel} ago` : abs;
  } catch {
    return rel ? `${iso.slice(0, 10)} · ${rel} ago` : iso.slice(0, 10);
  }
}

function boardHistoryMissions(
  board: {
    columns?: Record<string, MissionHistoryLike[]>;
    missions?: MissionHistoryLike[];
  } | null
  | undefined,
): MissionHistoryLike[] {
  if (!board) return [];
  if (Array.isArray(board.missions) && board.missions.length) return board.missions;
  const cols = board.columns;
  if (!cols || typeof cols !== "object") return [];
  const out: MissionHistoryLike[] = [];
  for (const key of Object.keys(cols)) {
    const rows = cols[key];
    if (Array.isArray(rows)) out.push(...rows);
  }
  return out;
}

export function collectGroundProjectHistory(
  board: {
    columns?: Record<string, MissionHistoryLike[]>;
    missions?: MissionHistoryLike[];
  } | null
  | undefined,
  nowMs = Date.now(),
  limit = 40,
): GroundHistoryRow[] {
  const missions = boardHistoryMissions(board)
    .filter((m) => TERMINAL_STATUS.has(String(m.status || "")))
    .sort((a, b) => missionHistoryTimestamp(b).localeCompare(missionHistoryTimestamp(a)));
  const rows: GroundHistoryRow[] = [];
  for (const m of missions) {
    if (rows.length >= limit) break;
    const id = String(m.id || "").trim();
    const title = String(m.title || "Project").trim();
    if (!id) continue;
    const status = String(m.status || "");
    rows.push({
      kind: "history",
      id,
      title,
      statusLabel: status === "cancelled" ? "Cancelled" : "Completed",
      whenLabel: formatGroundHistoryWhen(m.completed_at || m.updated_at, nowMs),
    });
  }
  return rows;
}

function markerText(
  markers: Record<string, string | number | boolean | null> | undefined,
  key: string,
): string | null {
  const v = markers?.[key];
  if (typeof v === "string" && v.trim()) return v.trim();
  return null;
}

function cleanProse(text: string | null | undefined, maxLen = 320): string {
  if (!text) return "";
  const lines = String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !ORCHESTRATION_LINE_RE.test(l));
  const joined = lines.join(" ").replace(/\s+/g, " ").trim();
  if (!joined) return "";
  if (joined.length <= maxLen) return joined;
  return joined.slice(0, maxLen - 1).trimEnd() + "…";
}

export function parseMissionHistoryDetail(
  mission: MissionHistoryLike,
  nowMs = Date.now(),
): MissionHistoryDetail {
  const markers = mission.markers || {};
  const status = String(mission.status || "");
  const statusWord = status === "cancelled" ? "Cancelled" : "Completed";
  const when = formatGroundHistoryWhen(mission.completed_at || mission.updated_at, nowMs);
  const statusLine = when ? `${statusWord} · ${when}` : statusWord;

  const outcome =
    markerText(markers, "outcome") ||
    cleanProse(mission.summary) ||
    (status === "cancelled"
      ? "This project was set aside before completion."
      : "Finished without a written outcome summary.");

  const whatChanged =
    markerText(markers, "what_changed") ||
    cleanProse(mission.findings) ||
    cleanProse(mission.goal) ||
    "No change log was recorded.";

  const verification =
    markerText(markers, "verification") ||
    markerText(markers, "verification_notes") ||
    cleanProse(mission.summary, 160) ||
    "Not recorded.";

  return {
    title: String(mission.title || "Project").trim() || "Project",
    statusLine,
    outcome,
    whatChanged,
    verification,
  };
}

/** Public / preview viewers must not see mission bodies from history detail. */
export function missionHistoryDetailAllowed(owner: boolean, boardPublicPreview: boolean): boolean {
  return owner && !boardPublicPreview;
}
