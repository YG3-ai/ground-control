/**
 * Home system state — explicit project origin on missions (never inferred from titles).
 * Activity states (ON A PROJECT / LEARNING) require authoritative active managed jobs.
 */

import type { MissionRecord } from "./missions/store.js";

export const PROJECT_ORIGIN_USER_LED = "user_led" as const;
export const PROJECT_ORIGIN_AUTONOMOUS_LEARNING = "autonomous_learning" as const;

export type ProjectOrigin =
  | typeof PROJECT_ORIGIN_USER_LED
  | typeof PROJECT_ORIGIN_AUTONOMOUS_LEARNING;

export type SystemStateKey = "cooling" | "learning" | "on_a_project";

export type SystemStateLabel = "COOLING" | "LEARNING" | "ON A PROJECT";

export type BoardSystemFocus = {
  state: SystemStateKey;
  label: SystemStateLabel;
  origin: ProjectOrigin | null;
  mission_id: string | null;
  title: string | null;
};

export type BoardUserLedProject = {
  active: boolean;
  mission_id: string;
  title: string;
  origin: typeof PROJECT_ORIGIN_USER_LED;
};

export type BoardLearningActivity = {
  active: boolean;
  mission_id: string;
  title: string;
  origin: typeof PROJECT_ORIGIN_AUTONOMOUS_LEARNING;
  source?: string;
};

export type BoardSystemFocusPayload = {
  system_state: BoardSystemFocus;
  user_led_project: BoardUserLedProject | null;
  learning_activity: BoardLearningActivity | null;
};

export type ManagedTaskRef = { id: string; status: string };

const TERMINAL = new Set(["done", "cancelled"]);

const ACTIVE_MANAGED_JOB = new Set([
  "queued",
  "preparing",
  "running",
  "awaiting_followup",
  "cancelling",
]);

export function isActiveManagedJobStatus(status: string | undefined): boolean {
  return ACTIVE_MANAGED_JOB.has(String(status || ""));
}

export function missionProjectOrigin(
  markers: Record<string, string | number | boolean | null> | undefined,
): ProjectOrigin {
  const raw = markers?.project_origin;
  if (raw === PROJECT_ORIGIN_AUTONOMOUS_LEARNING) return PROJECT_ORIGIN_AUTONOMOUS_LEARNING;
  return PROJECT_ORIGIN_USER_LED;
}

export function isMissionProjectActive(
  markers: Record<string, string | number | boolean | null> | undefined,
): boolean {
  return markers?.project_active === true;
}

function systemLabel(key: SystemStateKey): SystemStateLabel {
  if (key === "learning") return "LEARNING";
  if (key === "on_a_project") return "ON A PROJECT";
  return "COOLING";
}

function pickNewest(missions: MissionRecord[]): MissionRecord | null {
  if (!missions.length) return null;
  return missions
    .slice()
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0]!;
}

function missionForJob(missions: MissionRecord[], jobId: string): MissionRecord | null {
  for (const m of missions) {
    if (m.linked_job_ids.includes(jobId)) return m;
  }
  return null;
}

function missionsWithActiveJobs(
  missions: MissionRecord[],
  tasks: ManagedTaskRef[],
  origin: ProjectOrigin,
): MissionRecord[] {
  const byId = new Map<string, MissionRecord>();
  for (const t of tasks) {
    if (!isActiveManagedJobStatus(t.status)) continue;
    const m = missionForJob(missions, t.id);
    if (!m || TERMINAL.has(m.status)) continue;
    if (missionProjectOrigin(m.markers) !== origin) continue;
    byId.set(m.id, m);
  }
  return [...byId.values()];
}

export function buildBoardSystemFocus(
  missions: MissionRecord[],
  tasks: ManagedTaskRef[] = [],
): BoardSystemFocusPayload {
  const open = missions.filter((m) => !TERMINAL.has(m.status));
  const userLedFocus = pickNewest(
    open.filter(
      (m) =>
        missionProjectOrigin(m.markers) === PROJECT_ORIGIN_USER_LED &&
        isMissionProjectActive(m.markers),
    ),
  );
  const userLedActive = pickNewest(
    missionsWithActiveJobs(missions, tasks, PROJECT_ORIGIN_USER_LED),
  );
  const learnActive = pickNewest(
    missionsWithActiveJobs(missions, tasks, PROJECT_ORIGIN_AUTONOMOUS_LEARNING),
  );

  const cooling: BoardSystemFocus = {
    state: "cooling",
    label: "COOLING",
    origin: null,
    mission_id: null,
    title: null,
  };

  if (userLedActive) {
    const focus: BoardSystemFocus = {
      state: "on_a_project",
      label: "ON A PROJECT",
      origin: PROJECT_ORIGIN_USER_LED,
      mission_id: userLedActive.id,
      title: userLedActive.title,
    };
    return {
      system_state: focus,
      user_led_project: {
        active: true,
        mission_id: userLedActive.id,
        title: userLedActive.title,
        origin: PROJECT_ORIGIN_USER_LED,
      },
      learning_activity: null,
    };
  }

  if (learnActive) {
    const focus: BoardSystemFocus = {
      state: "learning",
      label: "LEARNING",
      origin: PROJECT_ORIGIN_AUTONOMOUS_LEARNING,
      mission_id: learnActive.id,
      title: learnActive.title,
    };
    return {
      system_state: focus,
      user_led_project: userLedFocus
        ? {
            active: true,
            mission_id: userLedFocus.id,
            title: userLedFocus.title,
            origin: PROJECT_ORIGIN_USER_LED,
          }
        : null,
      learning_activity: {
        active: true,
        mission_id: learnActive.id,
        title: learnActive.title,
        origin: PROJECT_ORIGIN_AUTONOMOUS_LEARNING,
        source:
          typeof learnActive.markers.enrichment_source === "string"
            ? learnActive.markers.enrichment_source
            : undefined,
      },
    };
  }

  return {
    system_state: cooling,
    user_led_project: userLedFocus
      ? {
          active: true,
          mission_id: userLedFocus.id,
          title: userLedFocus.title,
          origin: PROJECT_ORIGIN_USER_LED,
        }
      : null,
    learning_activity: null,
  };
}
