import type { MissionQueueEntry, MissionQueueState } from "./queue-store.js";
import type { MissionRecord } from "./store.js";

const TERMINAL_MISSION = new Set(["done", "cancelled"]);
const TERMINAL_QUEUE = new Set<MissionQueueState>(["completed", "cancelled"]);

export type MissionQueueDriftClassification =
  | "provably_stale_queue"
  | "uncertain_mission_active";

export type MissionQueueDriftRecord = {
  mission_id: string;
  mission_title: string | null;
  mission_status: string;
  queue_entry_id: string;
  queue_state: string;
  classification: MissionQueueDriftClassification;
  evidence: string;
};

export function isTerminalMissionStatus(status: string): boolean {
  return TERMINAL_MISSION.has(status);
}

export function isTerminalQueueState(state: string): boolean {
  return TERMINAL_QUEUE.has(state as MissionQueueState);
}

/** When mission lifecycle is terminal, queue row must match without rewriting mission history. */
export function terminalQueuePatchForMission(
  mission: Pick<MissionRecord, "status">,
  entry: Pick<MissionQueueEntry, "queue_state">,
): {
  queue_state: MissionQueueState;
  claim_token: null;
  claimed_at: null;
  lease_until: null;
  blocker_code: null;
  blocker_detail: null;
} | null {
  if (mission.status === "done") {
    if (entry.queue_state === "completed") return null;
    return {
      queue_state: "completed",
      claim_token: null,
      claimed_at: null,
      lease_until: null,
      blocker_code: null,
      blocker_detail: null,
    };
  }
  if (mission.status === "cancelled") {
    if (entry.queue_state === "cancelled") return null;
    return {
      queue_state: "cancelled",
      claim_token: null,
      claimed_at: null,
      lease_until: null,
      blocker_code: null,
      blocker_detail: null,
    };
  }
  return null;
}

export function inventoryMissionQueueDrift(
  entries: MissionQueueEntry[],
  missionFor: (missionId: string) => MissionRecord | null,
): MissionQueueDriftRecord[] {
  const out: MissionQueueDriftRecord[] = [];
  for (const entry of entries) {
    const mission = missionFor(entry.mission_id);
    if (!mission) continue;
    if (
      isTerminalMissionStatus(mission.status) &&
      !isTerminalQueueState(entry.queue_state)
    ) {
      out.push({
        mission_id: mission.id,
        mission_title: mission.title,
        mission_status: mission.status,
        queue_entry_id: entry.id,
        queue_state: entry.queue_state,
        classification: "provably_stale_queue",
        evidence: `mission status ${mission.status} with non-terminal queue_state ${entry.queue_state}`,
      });
      continue;
    }
    if (
      !isTerminalMissionStatus(mission.status) &&
      isTerminalQueueState(entry.queue_state)
    ) {
      out.push({
        mission_id: mission.id,
        mission_title: mission.title,
        mission_status: mission.status,
        queue_entry_id: entry.id,
        queue_state: entry.queue_state,
        classification: "uncertain_mission_active",
        evidence: `mission status ${mission.status} with terminal queue_state ${entry.queue_state}`,
      });
    }
  }
  return out.sort((a, b) => a.mission_title?.localeCompare(b.mission_title ?? "") ?? 0);
}
