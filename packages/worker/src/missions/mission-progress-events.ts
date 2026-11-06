import type { EventSink } from "../events/types.js";
import type { MissionRecord } from "./store.js";
import { stepMarkerDone } from "./contract.js";
import {
  DEPLOYMENT_RECORD_AT,
  DEPLOYMENT_RECORD_KIND,
} from "./deployment-record.js";

const SUPERVISION_MARKER = "supervision_state";
const CURRENT_STEP_MARKER = "current_step_id";
const HEARTBEAT_MARKER = "supervision_heartbeat_at";
const BLOCK_REASON_MARKER = "block_reason";

function evidenceRefs(m: MissionRecord): string[] {
  return [
    `mission:${m.id}`,
    ...m.linked_job_ids.map((j) => `job:${j}`),
  ];
}

function emit(
  sink: EventSink | undefined,
  m: MissionRecord,
  input: {
    verb: string;
    dedupeKey: string;
    objectId?: string | null;
    fromState?: string | null;
    toState?: string | null;
    occurredAt?: string;
    actor?: "owner" | "system";
  },
): void {
  sink?.({
    source: "missions",
    sourceRef: m.id,
    actor: input.actor ?? "system",
    verb: input.verb,
    objectType: "mission_step",
    objectId: input.objectId ?? null,
    fromState: input.fromState ?? null,
    toState: input.toState ?? null,
    occurredAt: input.occurredAt ?? m.updated_at,
    evidenceRefs: evidenceRefs(m),
    sensitivity: "internal",
    dedupeKey: input.dedupeKey,
  });
}

/** Compare mission rows after update; emit metadata-only progress events. */
export function emitMissionProgressDelta(
  prev: MissionRecord,
  cur: MissionRecord,
  sink: EventSink | undefined,
): void {
  if (!sink) return;

  if (prev.markers[SUPERVISION_MARKER] !== cur.markers[SUPERVISION_MARKER]) {
    emit(sink, cur, {
      verb: "mission.supervision_changed",
      dedupeKey: `supervision:${String(cur.markers[SUPERVISION_MARKER])}:${cur.updated_at}`,
      fromState:
        typeof prev.markers[SUPERVISION_MARKER] === "string"
          ? String(prev.markers[SUPERVISION_MARKER])
          : null,
      toState:
        typeof cur.markers[SUPERVISION_MARKER] === "string"
          ? String(cur.markers[SUPERVISION_MARKER])
          : null,
    });
  }

  const prevStep = prev.markers[CURRENT_STEP_MARKER];
  const curStep = cur.markers[CURRENT_STEP_MARKER];
  if (prevStep !== curStep && typeof curStep === "string") {
    emit(sink, cur, {
      verb: "mission.step_started",
      dedupeKey: `step_started:${curStep}:${cur.updated_at}`,
      objectId: curStep,
      fromState: typeof prevStep === "string" ? prevStep : null,
      toState: curStep,
    });
  }

  if (prev.markers[HEARTBEAT_MARKER] !== cur.markers[HEARTBEAT_MARKER]) {
    emit(sink, cur, {
      verb: "mission.progress_heartbeat",
      dedupeKey: `heartbeat:${String(cur.markers[HEARTBEAT_MARKER])}`,
      toState:
        typeof cur.markers[SUPERVISION_MARKER] === "string"
          ? String(cur.markers[SUPERVISION_MARKER])
          : "active",
    });
  }

  if (
    prev.markers[BLOCK_REASON_MARKER] !== cur.markers[BLOCK_REASON_MARKER] &&
    typeof cur.markers[BLOCK_REASON_MARKER] === "string"
  ) {
    emit(sink, cur, {
      verb: "mission.execution_blocked",
      dedupeKey: `blocked:${String(cur.markers[BLOCK_REASON_MARKER])}:${cur.updated_at}`,
      toState: String(cur.markers[BLOCK_REASON_MARKER]).split(":", 1)[0] ?? "blocked",
    });
  }

  for (const key of Object.keys(cur.markers)) {
    if (!key.startsWith("step_done:")) continue;
    if (prev.markers[key] === true || cur.markers[key] !== true) continue;
    const stepId = key.slice("step_done:".length);
    emit(sink, cur, {
      verb: "mission.step_completed",
      dedupeKey: `step_completed:${stepId}`,
      objectId: stepId,
      toState: "completed",
    });
  }

  for (const key of Object.keys(cur.markers)) {
    if (!key.startsWith("acceptance_evidence:")) continue;
    if (prev.markers[key] === cur.markers[key]) continue;
    const testId = key.slice("acceptance_evidence:".length);
    const outcome = String(cur.markers[key]);
    emit(sink, cur, {
      verb: "mission.acceptance_evidence",
      dedupeKey: `acceptance:${testId}:${outcome}`,
      objectId: testId,
      toState: outcome,
    });
  }

  if (
    prev.markers[DEPLOYMENT_RECORD_AT] !== cur.markers[DEPLOYMENT_RECORD_AT] ||
    prev.markers[DEPLOYMENT_RECORD_KIND] !== cur.markers[DEPLOYMENT_RECORD_KIND]
  ) {
    if (
      typeof cur.markers[DEPLOYMENT_RECORD_AT] === "string" &&
      typeof cur.markers[DEPLOYMENT_RECORD_KIND] === "string"
    ) {
      emit(sink, cur, {
        verb: "mission.deployment_recorded",
        dedupeKey: `deployment:${cur.markers[DEPLOYMENT_RECORD_KIND]}:${cur.markers[DEPLOYMENT_RECORD_AT]}`,
        objectId: String(cur.markers[DEPLOYMENT_RECORD_KIND]),
        toState: String(cur.markers[DEPLOYMENT_RECORD_AT]),
        actor: "owner",
      });
    }
  }
}

/** Derive rebuildable progress events from persisted markers (no prompts). */
export function deriveMissionProgressEvents(m: {
  id: string;
  updated_at: string;
  linked_job_ids: string[];
  markers: MissionRecord["markers"];
}): import("../events/types.js").NewEvent[] {
  const base = {
    source: "missions" as const,
    sourceRef: m.id,
    actor: "system" as const,
    objectType: "mission_step" as const,
    evidenceRefs: [
      `mission:${m.id}`,
      ...m.linked_job_ids.map((j) => `job:${j}`),
    ],
    sensitivity: "internal" as const,
    occurredAt: m.updated_at,
  };
  const out: import("../events/types.js").NewEvent[] = [];
  const supervision = m.markers[SUPERVISION_MARKER];
  if (typeof supervision === "string") {
    out.push({
      ...base,
      verb: "mission.supervision_changed",
      toState: supervision,
      dedupeKey: `supervision:${supervision}`,
    });
  }
  for (const [key, val] of Object.entries(m.markers)) {
    if (key.startsWith("step_done:") && val === true) {
      const stepId = key.slice("step_done:".length);
      out.push({
        ...base,
        verb: "mission.step_completed",
        objectId: stepId,
        toState: "completed",
        dedupeKey: `step_completed:${stepId}`,
      });
    }
    if (key.startsWith("acceptance_evidence:") && val != null) {
      const testId = key.slice("acceptance_evidence:".length);
      out.push({
        ...base,
        verb: "mission.acceptance_evidence",
        objectId: testId,
        toState: String(val),
        dedupeKey: `acceptance:${testId}:${String(val)}`,
      });
    }
  }
  const hb = m.markers[HEARTBEAT_MARKER];
  if (typeof hb === "string") {
    out.push({
      ...base,
      verb: "mission.progress_heartbeat",
      toState: typeof supervision === "string" ? supervision : "active",
      occurredAt: hb,
      dedupeKey: `heartbeat:${hb}`,
    });
  }
  const blocker = m.markers[BLOCK_REASON_MARKER];
  if (typeof blocker === "string" && blocker) {
    out.push({
      ...base,
      verb: "mission.execution_blocked",
      toState: blocker.split(":", 1)[0] ?? "blocked",
      dedupeKey: `blocked:${blocker}`,
    });
  }
  const depAt = m.markers[DEPLOYMENT_RECORD_AT];
  const depKind = m.markers[DEPLOYMENT_RECORD_KIND];
  if (typeof depAt === "string" && typeof depKind === "string") {
    out.push({
      ...base,
      verb: "mission.deployment_recorded",
      objectId: depKind,
      toState: depAt,
      actor: "owner",
      dedupeKey: `deployment:${depKind}:${depAt}`,
    });
  }
  return out;
}

export function supervisionHeartbeatMarkers(now = new Date()): Record<string, string> {
  const iso = now.toISOString();
  const bucket = Math.floor(now.getTime() / 60_000);
  return {
    [HEARTBEAT_MARKER]: iso,
    supervision_heartbeat_bucket: String(bucket),
  };
}
