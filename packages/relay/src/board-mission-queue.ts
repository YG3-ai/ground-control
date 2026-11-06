/**
 * Ground PROJECT QUEUE presentation — keep in sync with board.html suit block.
 */

import { presentBlockReason, type NeedsYouRailEntry } from "@agent-control/shared";
import type { GroundMissionRow } from "./board-ground-present.js";
import { groundMissionUpdatedLabel } from "./board-ground-present.js";

export type MissionQueueBoardEntry = {
  id: string;
  mission_id: string;
  mission_title?: string | null;
  queue_state: string;
  display_state?: string | null;
  display_state_label?: string | null;
  priority?: number;
  why?: string | null;
  blocker_detail?: string | null;
  next_run_at?: string | null;
  earliest_start_at?: string | null;
  conservation_summary?: string | null;
  updated_at?: string | null;
};

const QUEUE_LABEL: Record<string, string> = {
  queued: "Queued",
  scheduled: "Scheduled",
  running: "Running",
  blocked: "Blocked",
  verifying: "Verifying",
  ready_for_review: "Ready for review",
  completed: "Completed",
  cancelled: "Cancelled",
};

export function missionQueueStatusLabel(state: string): string {
  return QUEUE_LABEL[state] || state.replace(/_/g, " ");
}

export function missionQueueDetailLine(
  entry: MissionQueueBoardEntry,
  _needsYou?: NeedsYouRailEntry,
  nowMs = Date.now(),
): string | null {
  if (entry.conservation_summary) {
    return entry.conservation_summary.slice(0, 160);
  }
  if (entry.next_run_at) {
    const t = Date.parse(entry.next_run_at);
    if (Number.isFinite(t) && t > nowMs) {
      const sec = Math.ceil((t - nowMs) / 1000);
      return `Scheduled to run in ${sec}s`;
    }
  }
  if (entry.earliest_start_at) {
    const t = Date.parse(entry.earliest_start_at);
    if (Number.isFinite(t) && t > nowMs) {
      return `Starts ${entry.earliest_start_at.slice(0, 19).replace("T", " ")} UTC`;
    }
  }
  if (entry.priority != null && entry.priority !== 0) {
    return `Priority ${entry.priority}`;
  }
  return null;
}

export function missionQueueTechnicalDetail(
  entry: MissionQueueBoardEntry,
  needsYou?: NeedsYouRailEntry,
): string | null {
  const raw =
    entry.why ??
    entry.blocker_detail ??
    needsYou?.blocker ??
    null;
  return presentBlockReason(raw)?.technical ?? (raw?.trim() ? raw.trim() : null);
}

export function buildMissionQueueRows(
  entries: MissionQueueBoardEntry[],
  needsYouByMission: Map<string, NeedsYouRailEntry> = new Map(),
  nowMs = Date.now(),
): GroundMissionRow[] {
  const order = [
    "running",
    "verifying",
    "ready_for_review",
    "blocked",
    "scheduled",
    "queued",
  ];
  const rank = (s: string) => {
    const i = order.indexOf(s);
    return i >= 0 ? i : 99;
  };
  const sorted = entries.slice().sort((a, b) => {
    const dr = rank(a.queue_state) - rank(b.queue_state);
    if (dr !== 0) return dr;
    return (b.priority ?? 0) - (a.priority ?? 0);
  });
  return sorted.map((e) => {
    const needsYou = needsYouByMission.get(e.mission_id);
    const baseLabel =
      e.display_state_label ??
      missionQueueStatusLabel(e.display_state ?? e.queue_state);
    const updatedLabel = groundMissionUpdatedLabel(e.updated_at, nowMs);
    const statusLabel = updatedLabel ? `${baseLabel} · ${updatedLabel}` : baseLabel;
    const raw =
      e.why ?? e.blocker_detail ?? needsYou?.blocker ?? null;
    const blockedCopy = presentBlockReason(raw);
    const schedulingLine = missionQueueDetailLine(e, undefined, nowMs);
    const detailLabel =
      blockedCopy && (e.queue_state === "blocked" || e.display_state === "blocked")
        ? blockedCopy.summary
        : schedulingLine;
    const ownerActionLabel =
      needsYou?.next_owner_action ??
      blockedCopy?.owner_step ??
      (e.queue_state === "ready_for_review" || e.display_state === "ready_for_review"
        ? "Review the implementation and authorize release when satisfied."
        : null);
    return {
      kind: "mission",
      id: e.mission_id,
      title: String(e.mission_title || "Project").trim(),
      statusLabel,
      detailLabel,
      technicalDetail: missionQueueTechnicalDetail(e, needsYou),
      updatedLabel,
      ownerActionLabel,
      dim: e.queue_state === "blocked" || e.queue_state === "cancelled",
    };
  });
}

/** Active queue rows shown in the HUD (hide terminal states). */
export function filterMissionQueueForHud(
  entries: MissionQueueBoardEntry[],
): MissionQueueBoardEntry[] {
  return entries.filter(
    (e) => e.queue_state !== "completed" && e.queue_state !== "cancelled",
  );
}
