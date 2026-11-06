import type { EventRecord } from "../events/types.js";
import type { MissionDeliveryPresentation } from "@agent-control/shared";
import type { MissionRecord } from "./store.js";
import { deriveMissionDeliveryPresentation } from "@agent-control/shared";
import type { MissionQueueState } from "./queue-store.js";

export type MissionTimelineEntry = {
  event_id: string;
  occurred_at: string;
  verb: string;
  label: string;
  object_id: string | null;
  from_state: string | null;
  to_state: string | null;
};

export type MissionTimelineSnapshot = {
  mission_id: string;
  presentation: MissionDeliveryPresentation;
  deployment_policy_mode: string | null;
  deployment_record_at: string | null;
  deployment_record_kind: string | null;
  supervision_heartbeat_at: string | null;
  entries: MissionTimelineEntry[];
};

const VERB_LABEL: Record<string, string> = {
  "mission.created": "Mission created",
  "mission.status_changed": "Status changed",
  "mission.status_current": "Status",
  "mission.step_started": "Step started",
  "mission.step_completed": "Step completed",
  "mission.supervision_changed": "Supervision",
  "mission.progress_heartbeat": "Heartbeat",
  "mission.acceptance_evidence": "Acceptance",
  "mission.execution_blocked": "Execution blocked",
  "mission.deployment_recorded": "Deployment record",
  "job.status_changed": "Job",
  "job.created": "Job created",
};

function timelineLabel(e: EventRecord): string {
  const base = VERB_LABEL[e.verb] ?? e.verb.replace(/\./g, " ");
  if (e.verb === "mission.step_completed" && e.object_id) {
    return `${base}: ${e.object_id}`;
  }
  if (e.verb === "mission.step_started" && e.object_id) {
    return `${base}: ${e.object_id}`;
  }
  if (e.verb === "mission.acceptance_evidence" && e.object_id) {
    return `${base} ${e.object_id} → ${e.to_state ?? "?"}`;
  }
  if (e.verb === "mission.status_changed" && e.to_state) {
    return `${base} → ${e.to_state}`;
  }
  if (e.verb === "mission.supervision_changed" && e.to_state) {
    return `${base} → ${e.to_state}`;
  }
  if (e.verb === "job.status_changed" && e.to_state) {
    return `Job ${e.object_id ?? ""} → ${e.to_state}`.trim();
  }
  return base;
}

export function missionTimelineFromEvents(input: {
  mission: MissionRecord;
  events: EventRecord[];
  queueState?: MissionQueueState | null;
  hasActiveSupervisorJob?: boolean;
}): MissionTimelineSnapshot {
  const missionId = input.mission.id;
  const linked = new Set(input.mission.linked_job_ids);
  const filtered = input.events.filter((e) => {
    if (e.source === "missions" && e.source_ref === missionId) return true;
    if (e.source === "jobs" && e.object_id && linked.has(e.object_id)) {
      return e.sensitivity !== "private" || e.verb === "job.status_changed";
    }
    return e.evidence_refs.includes(`mission:${missionId}`);
  });
  filtered.sort((a, b) => {
    const t = a.occurred_at.localeCompare(b.occurred_at);
    return t !== 0 ? t : a.event_id.localeCompare(b.event_id);
  });
  const entries: MissionTimelineEntry[] = filtered.map((e) => ({
    event_id: e.event_id,
    occurred_at: e.occurred_at,
    verb: e.verb,
    label: timelineLabel(e),
    object_id: e.object_id,
    from_state: e.from_state,
    to_state: e.to_state,
  }));
  const presentation = deriveMissionDeliveryPresentation(
    input.mission,
    input.queueState ? { queue_state: input.queueState } : null,
    input.hasActiveSupervisorJob ?? false,
  );
  return {
    mission_id: missionId,
    presentation,
    deployment_policy_mode:
      typeof input.mission.markers.deployment_policy_mode === "string"
        ? input.mission.markers.deployment_policy_mode
        : null,
    deployment_record_at:
      typeof input.mission.markers.deployment_record_at === "string"
        ? input.mission.markers.deployment_record_at
        : null,
    deployment_record_kind:
      typeof input.mission.markers.deployment_record_kind === "string"
        ? input.mission.markers.deployment_record_kind
        : null,
    supervision_heartbeat_at:
      typeof input.mission.markers.supervision_heartbeat_at === "string"
        ? input.mission.markers.supervision_heartbeat_at
        : null,
    entries,
  };
}
