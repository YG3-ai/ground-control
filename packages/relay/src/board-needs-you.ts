/**
 * Needs You rail rows for Ground Work UX.
 */

import {
  buildNeedsYouRail,
  presentBlockReason,
  type NeedsYouRailEntry,
} from "@agent-control/shared";
import type { GroundMissionRow } from "./board-ground-present.js";

export type NeedsYouBoardEntry = NeedsYouRailEntry;

export function buildNeedsYouGroundRows(
  entries: NeedsYouBoardEntry[],
): GroundMissionRow[] {
  return entries.map((e) => {
    const raw = e.blocker;
    const blockedCopy = raw ? presentBlockReason(raw) : null;
    return {
      kind: "mission",
      id: e.mission_id,
      title: e.title,
      statusLabel: e.display_state_label,
      detailLabel: blockedCopy?.summary ?? e.next_owner_action,
      ownerActionLabel: e.next_owner_action,
      technicalDetail: blockedCopy?.technical ?? raw,
      dim: e.display_state === "blocked",
    };
  });
}

export function needsYouFromBoard(
  board: { needs_you?: NeedsYouBoardEntry[] } | null | undefined,
): NeedsYouBoardEntry[] {
  return board?.needs_you ?? [];
}
