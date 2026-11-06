/**
 * Canonical Ground WORK cards — one row per mission in PROJECT QUEUE, Needs You only for off-queue items.
 */

import type { NeedsYouRailEntry } from "@agent-control/shared";
import type { MissionQueueBoardEntry } from "./board-mission-queue.js";
import type { GroundMissionRow } from "./board-ground-present.js";

export type NeedsYouBoardEntry = NeedsYouRailEntry;

export function indexNeedsYouByMission(
  entries: NeedsYouBoardEntry[],
): Map<string, NeedsYouBoardEntry> {
  const map = new Map<string, NeedsYouBoardEntry>();
  for (const e of entries) {
    map.set(e.mission_id, e);
  }
  return map;
}

/** Missions already represented in PROJECT QUEUE should not duplicate in NEEDS YOU. */
export function filterNeedsYouExclusiveOfQueue(
  needsYou: NeedsYouBoardEntry[],
  queue: MissionQueueBoardEntry[],
): NeedsYouBoardEntry[] {
  const inQueue = new Set(queue.map((e) => e.mission_id));
  return needsYou.filter((e) => !inQueue.has(e.mission_id));
}
