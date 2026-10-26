/**
 * Workbench mission blueprint model — duplicated in board.html between
 * __workbench_present__ markers. Keep in sync.
 */

import {
  missionHomeSubline,
  type MissionHomeFields,
} from "./board-home-mission.js";

export type WorkbenchMission = MissionHomeFields & {
  id: string;
  title?: string | null;
  col?: string | null;
  status?: string | null;
  workspace?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
};

const STATUS_LABEL: Record<string, string> = {
  intake: "New",
  researching: "Researching",
  plan_ready: "Plan ready",
  approved: "Approved",
  implementing: "Building",
  in_progress: "Working",
  verifying: "Checking",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Cancelled",
};

export function missionBoardStatusLabel(m: WorkbenchMission): string {
  const key = String(m.col || m.status || "");
  return STATUS_LABEL[key] || "Active";
}

export function missionLampClass(m: WorkbenchMission): string {
  const col = String(m.col || m.status || "");
  if (col === "blocked") return "warn";
  if (["implementing", "in_progress", "verifying"].includes(col)) return "run";
  if (col === "done") return "good";
  if (col === "cancelled") return "idle";
  return "run";
}

/** Active missions first, then blocked — same order as the bench rack. */
export function workbenchMissionQueue(
  active: WorkbenchMission[],
  blocked: WorkbenchMission[],
): WorkbenchMission[] {
  return active.concat(blocked);
}

export function pickWorkbenchMissionId(
  queue: WorkbenchMission[],
  selectedId: string | null | undefined,
): string | null {
  if (!queue.length) return null;
  if (selectedId && queue.some((m) => m.id === selectedId)) return selectedId;
  return queue[0]!.id;
}

export type WorkbenchBlueprint = {
  status: string;
  workLine: string | null;
  evidenceLine: string | null;
};

function firstLine(text: string, max = 140): string | null {
  const line = String(text || "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

/** One focal mission: real status, current work line, optional evidence — no fake phases. */
export function workbenchBlueprint(m: WorkbenchMission): WorkbenchBlueprint {
  const status = missionBoardStatusLabel(m);
  const workLine = missionHomeSubline(m);
  const evidenceLine = m.summary ? firstLine(m.summary, 120) : null;
  return { status, workLine, evidenceLine };
}

export function workbenchRailTitle(m: WorkbenchMission, max = 28): string {
  const t = String(m.title || "Mission").trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + "…";
}
