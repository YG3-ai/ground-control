/**
 * GROUND suit HUD row copy and disclosure — duplicated in board.html suit block.
 */

import { countExecutingJobs, isExecutingJobStatus } from "./board-home-intelligence.js";
import {
  isCognitivelyActiveTerminal,
  openTerminalSessions,
} from "./board-session-activity.js";

/** Resting Current Project value when no mission is tied to active work. */
export const GROUND_CURRENT_PROJECT_RESTING_LABEL = "READY";

const ACTIVE_JOB = new Set([
  "queued",
  "preparing",
  "running",
  "awaiting_followup",
  "cancelling",
]);

export type GroundHeaderState = "idle" | "active";

export type GroundMissionRow = {
  kind: "mission";
  id: string;
  title: string;
  statusLabel: string;
  dim?: boolean;
};

export type GroundCurrentProjectRow = {
  kind: "current_project";
  id: string;
  title: string;
  statusLabel: string;
};

export type GroundJobRow = {
  kind: "job";
  id: string;
  title: string;
  agent: string;
  project: string;
  stateLabel: string;
  activityLabel: string;
  executing: boolean;
};

export type GroundSessionRow = {
  kind: "session";
  id: string;
  kindLabel: string;
  workspaceLabel: string;
  activityLabel: string;
  stateLabel: string;
  cognitivelyActive: boolean;
};

export type GroundHistoryRow = {
  kind: "history";
  id: string;
  title: string;
  statusLabel: string;
  whenLabel: string;
};

export type GroundRow =
  | GroundMissionRow
  | GroundCurrentProjectRow
  | GroundJobRow
  | GroundSessionRow
  | GroundHistoryRow;

export type GroundSectionId = "current_project" | "jobs" | "terminals" | "history";

export type GroundSection = {
  id: GroundSectionId;
  label: string;
  rows: GroundRow[];
  rowCount: number;
  emptyLabel: string;
  collapsible: boolean;
  activeCount: number;
  defaultOpen: boolean;
  headerState: GroundHeaderState;
};

export function formatGroundElapsed(
  iso: string | null | undefined,
  nowMs = Date.now(),
): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const sec = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (sec < 60) return sec <= 1 ? "just now" : `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

export function groundDisclosureDefaultOpen(activeCount: number): boolean {
  return activeCount > 0;
}

export function groundSessionActivityLabel(
  session: Record<string, unknown>,
  nowMs = Date.now(),
): string {
  if (isCognitivelyActiveTerminal(session as { state?: string; kind?: string; last_activity_at?: string }, nowMs)) {
    return "Working";
  }
  const state = String(session.state || "open");
  if (state === "waiting") return "Waiting";
  if (state === "error") return "Error";
  return "Idle · open";
}

export function buildGroundMissionRow(
  mission: Record<string, unknown>,
  col: string,
  status: string,
  groupLabels: Record<string, string>,
): GroundMissionRow {
  const titleText = String(mission.title || "Project").trim();
  return {
    kind: "mission",
    id: String(mission.id || titleText),
    title: titleText,
    statusLabel: groupLabels[col] || groupLabels[status] || col,
    dim: col === "blocked" || status === "blocked",
  };
}

export function buildGroundJobRow(
  task: Record<string, unknown>,
  missionTitle: (id: string) => string,
  nowMs = Date.now(),
): GroundJobRow | null {
  const status = String(task.status || "");
  if (!ACTIVE_JOB.has(status)) return null;
  const agent = String(task.agent || "Agent");
  const mid = task.mission_id
    ? String(task.mission_id)
    : task.project_id
      ? String(task.project_id)
      : "";
  const project = mid ? missionTitle(mid) : "";
  const summary = task.summary ? String(task.summary).trim() : "";
  const title = summary || (project ? `${agent} on ${project}` : `${agent} task`);
  const stamp = task.started_at || task.updated_at || task.created_at;
  const executing = isExecutingJobStatus(status);
  return {
    kind: "job",
    id: String(task.id || agent),
    title,
    agent,
    project,
    stateLabel: status.replace(/_/g, " "),
    activityLabel: formatGroundElapsed(String(stamp || ""), nowMs) || "—",
    executing,
  };
}

export function buildGroundSessionRow(
  session: Record<string, unknown>,
  nowMs = Date.now(),
): GroundSessionRow | null {
  if (session.state === "exited") return null;
  const ws = session.workspace ? String(session.workspace) : "";
  const base = ws.split("/").filter(Boolean).pop() || "";
  const cognitivelyActive = isCognitivelyActiveTerminal(
    session as { state?: string; kind?: string; last_activity_at?: string },
    nowMs,
  );
  const activityLabel = groundSessionActivityLabel(session, nowMs);
  const lastAt = session.last_activity_at ? String(session.last_activity_at) : "";
  const stateLabel = cognitivelyActive
    ? "active"
    : activityLabel.toLowerCase().includes("idle")
      ? "idle"
      : String(session.state || "open");
  return {
    kind: "session",
    id: String(session.id || base || "session"),
    kindLabel: String(session.kind || "shell"),
    workspaceLabel: base || "—",
    activityLabel: lastAt
      ? `${activityLabel} · ${formatGroundElapsed(lastAt, nowMs)}`
      : activityLabel,
    stateLabel,
    cognitivelyActive,
  };
}

export function countActiveGroundJobs(tasks: Array<Record<string, unknown>>): number {
  return countExecutingJobs(tasks);
}

export function countActiveGroundTerminals(
  sessions: Array<Record<string, unknown>>,
  nowMs = Date.now(),
): number {
  return openTerminalSessions(sessions).filter((s) =>
    isCognitivelyActiveTerminal(s as { state?: string; kind?: string; last_activity_at?: string }, nowMs),
  ).length;
}

export function groundSectionMeta(
  id: GroundSectionId,
  rowCount: number,
  activeCount: number,
): Pick<GroundSection, "collapsible" | "activeCount" | "defaultOpen" | "headerState"> {
  const collapsible = id === "jobs" || id === "terminals";
  return {
    collapsible,
    activeCount,
    defaultOpen: collapsible ? groundDisclosureDefaultOpen(activeCount) : true,
    headerState: activeCount > 0 ? "active" : "idle",
  };
}

export function buildGroundCurrentProjectRow(
  missionId: string,
  title: string,
  statusLabel: string,
): GroundCurrentProjectRow {
  return {
    kind: "current_project",
    id: missionId,
    title,
    statusLabel,
  };
}
