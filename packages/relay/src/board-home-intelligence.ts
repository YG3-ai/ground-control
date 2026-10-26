/**
 * HOME system state — duplicated in board.html home suit block.
 */

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

/** Cron/internal enrichment only — must include mission_id + title when active. */
export type BoardLearningActivity = {
  active: boolean;
  mission_id: string;
  title: string;
  origin: typeof PROJECT_ORIGIN_AUTONOMOUS_LEARNING;
  source?: string;
};

export type SystemStatePresentation = {
  label: SystemStateLabel;
  key: SystemStateKey;
  origin: ProjectOrigin | null;
  missionId: string | null;
  projectTitle: string | null;
};

type MissionLike = {
  id?: string;
  title?: string;
  status?: string;
  updated_at?: string;
  linked_job_ids?: string[];
  markers?: Record<string, string | number | boolean | null>;
};

const ACTIVE_MANAGED_JOB = new Set([
  "queued",
  "preparing",
  "running",
  "awaiting_followup",
  "cancelling",
]);

const TERMINAL_MISSION = new Set(["done", "cancelled"]);

export function isActiveManagedJobStatus(status: string | undefined): boolean {
  return ACTIVE_MANAGED_JOB.has(String(status || ""));
}

export function countActiveManagedJobs(
  tasks: Array<{ status?: string }> | null | undefined,
): number {
  return (tasks || []).filter((t) => isActiveManagedJobStatus(t.status)).length;
}

/** @deprecated use countActiveManagedJobs */
export function isExecutingJobStatus(status: string | undefined): boolean {
  return isActiveManagedJobStatus(status);
}

/** @deprecated use countActiveManagedJobs */
export function countExecutingJobs(
  tasks: Array<{ status?: string }> | null | undefined,
): number {
  return countActiveManagedJobs(tasks);
}

function missionProjectOrigin(
  markers: Record<string, string | number | boolean | null> | undefined,
): ProjectOrigin {
  const raw = markers?.project_origin;
  if (raw === PROJECT_ORIGIN_AUTONOMOUS_LEARNING) return PROJECT_ORIGIN_AUTONOMOUS_LEARNING;
  return PROJECT_ORIGIN_USER_LED;
}

function boardTasks(board: Record<string, unknown> | null | undefined): Array<{
  id: string;
  status?: string;
}> {
  const raw = (board?.tasks || board?.active_tasks || []) as Array<{
    id?: string;
    status?: string;
  }>;
  return raw
    .map((t) => ({ id: String(t.id || ""), status: t.status }))
    .filter((t) => t.id.length > 0);
}

function boardMissions(board: Record<string, unknown> | null | undefined): MissionLike[] {
  if (!board) return [];
  if (Array.isArray(board.missions)) {
    return board.missions as MissionLike[];
  }
  const cols = board.columns;
  if (!cols || typeof cols !== "object" || Array.isArray(cols)) return [];
  const out: MissionLike[] = [];
  for (const key of Object.keys(cols)) {
    const rows = (cols as Record<string, unknown>)[key];
    if (Array.isArray(rows)) out.push(...(rows as MissionLike[]));
  }
  return out;
}

function missionForJob(missions: MissionLike[], jobId: string): MissionLike | null {
  for (const m of missions) {
    const links = m.linked_job_ids || [];
    if (links.includes(jobId)) return m;
  }
  return null;
}

function pickNewest(missions: MissionLike[]): MissionLike | null {
  if (!missions.length) return null;
  return missions
    .slice()
    .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")))[0]!;
}

function missionsWithActiveJobs(
  missions: MissionLike[],
  tasks: Array<{ id: string; status?: string }>,
  origin: ProjectOrigin,
): MissionLike[] {
  const byId = new Map<string, MissionLike>();
  for (const t of tasks) {
    if (!isActiveManagedJobStatus(t.status)) continue;
    const m = missionForJob(missions, t.id);
    if (!m?.id || TERMINAL_MISSION.has(String(m.status || ""))) continue;
    if (missionProjectOrigin(m.markers) !== origin) continue;
    byId.set(m.id, m);
  }
  return [...byId.values()];
}

function coolingPresentation(): SystemStatePresentation {
  return {
    key: "cooling",
    label: "COOLING",
    origin: null,
    missionId: null,
    projectTitle: null,
  };
}

function presentationFromMission(
  key: SystemStateKey,
  m: MissionLike,
  origin: ProjectOrigin,
): SystemStatePresentation {
  return {
    key,
    label: key === "on_a_project" ? "ON A PROJECT" : key === "learning" ? "LEARNING" : "COOLING",
    origin,
    missionId: m.id ? String(m.id) : null,
    projectTitle: m.title ? String(m.title) : null,
  };
}

function computeSystemStateFromJobs(
  board: Record<string, unknown> | null | undefined,
): SystemStatePresentation | null {
  const missions = boardMissions(board);
  if (!missions.length) return null;
  const tasks = boardTasks(board);
  const userLed = pickNewest(
    missionsWithActiveJobs(missions, tasks, PROJECT_ORIGIN_USER_LED),
  );
  if (userLed) return presentationFromMission("on_a_project", userLed, PROJECT_ORIGIN_USER_LED);
  const learning = pickNewest(
    missionsWithActiveJobs(missions, tasks, PROJECT_ORIGIN_AUTONOMOUS_LEARNING),
  );
  if (learning) {
    return presentationFromMission(
      "learning",
      learning,
      PROJECT_ORIGIN_AUTONOMOUS_LEARNING,
    );
  }
  return coolingPresentation();
}

export function parseSystemFocusFromBoard(
  board: Record<string, unknown> | null | undefined,
): BoardSystemFocus | null {
  const raw = board?.system_state;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const state = String((raw as { state?: unknown }).state || "");
  const label = String((raw as { label?: unknown }).label || "");
  const key: SystemStateKey =
    state === "on_a_project" || label === "ON A PROJECT"
      ? "on_a_project"
      : state === "learning" || label === "LEARNING"
        ? "learning"
        : "cooling";
  const originRaw = (raw as { origin?: unknown }).origin;
  const origin =
    originRaw === PROJECT_ORIGIN_AUTONOMOUS_LEARNING
      ? PROJECT_ORIGIN_AUTONOMOUS_LEARNING
      : originRaw === PROJECT_ORIGIN_USER_LED
        ? PROJECT_ORIGIN_USER_LED
        : null;
  const mission_id = (raw as { mission_id?: unknown }).mission_id;
  const title = (raw as { title?: unknown }).title;
  return {
    state: key,
    label:
      key === "on_a_project"
        ? "ON A PROJECT"
        : key === "learning"
          ? "LEARNING"
          : "COOLING",
    origin,
    mission_id: typeof mission_id === "string" && mission_id.trim() ? mission_id.trim() : null,
    title: typeof title === "string" && title.trim() ? title.trim() : null,
  };
}

export function parseUserLedProjectFromBoard(
  board: Record<string, unknown> | null | undefined,
): BoardUserLedProject | null {
  const raw = board?.user_led_project;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if ((raw as { active?: unknown }).active !== true) return null;
  const mission_id = String((raw as { mission_id?: unknown }).mission_id || "").trim();
  const title = String((raw as { title?: unknown }).title || "").trim();
  if (!mission_id || !title) return null;
  if ((raw as { origin?: unknown }).origin !== PROJECT_ORIGIN_USER_LED) return null;
  return {
    active: true,
    mission_id,
    title,
    origin: PROJECT_ORIGIN_USER_LED,
  };
}

export function parseLearningActivityFromBoard(
  board: Record<string, unknown> | null | undefined,
): BoardLearningActivity | null {
  const raw = board?.learning_activity;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if ((raw as { active?: unknown }).active !== true) return null;
  const mission_id = String((raw as { mission_id?: unknown }).mission_id || "").trim();
  const title = String((raw as { title?: unknown }).title || "").trim();
  if (!mission_id || !title) return null;
  if ((raw as { origin?: unknown }).origin !== PROJECT_ORIGIN_AUTONOMOUS_LEARNING) {
    return null;
  }
  const source = (raw as { source?: unknown }).source;
  return {
    active: true,
    mission_id,
    title,
    origin: PROJECT_ORIGIN_AUTONOMOUS_LEARNING,
    source: typeof source === "string" && source.trim() ? source.trim() : undefined,
  };
}

export function resolveSystemStateFromBoard(
  board: Record<string, unknown> | null | undefined,
): SystemStatePresentation {
  const fromJobs = computeSystemStateFromJobs(board);
  if (fromJobs) return fromJobs;

  const tasks = boardTasks(board);
  const activeJobs = countActiveManagedJobs(tasks);
  const focus = parseSystemFocusFromBoard(board);
  if (focus && focus.state !== "cooling" && activeJobs === 0) {
    return coolingPresentation();
  }
  if (focus) {
    return {
      key: focus.state,
      label: focus.label,
      origin: focus.origin,
      missionId: focus.mission_id,
      projectTitle: focus.title,
    };
  }

  const learning = parseLearningActivityFromBoard(board);
  if (learning && activeJobs > 0) {
    return {
      key: "learning",
      label: "LEARNING",
      origin: PROJECT_ORIGIN_AUTONOMOUS_LEARNING,
      missionId: learning.mission_id,
      projectTitle: learning.title,
    };
  }

  return coolingPresentation();
}

/** Home / Ground current project title — only when a managed job is actively linked. */
export function resolveHomeFocusTitleFromBoard(
  board: Record<string, unknown> | null | undefined,
): string | null {
  const state = resolveSystemStateFromBoard(board);
  if (state.projectTitle && (state.key === "on_a_project" || state.key === "learning")) {
    return state.projectTitle;
  }
  return null;
}

export type CurrentProjectPresentation = {
  missionId: string;
  title: string;
  statusLabel: string;
};

export function resolveCurrentProjectFromBoard(
  board: Record<string, unknown> | null | undefined,
): CurrentProjectPresentation | null {
  const state = resolveSystemStateFromBoard(board);
  if (!state.missionId || !state.projectTitle) return null;
  if (state.key !== "on_a_project" && state.key !== "learning") return null;
  return {
    missionId: state.missionId,
    title: state.projectTitle,
    statusLabel: state.key === "learning" ? "Learning" : "In progress",
  };
}

export function systemStateIsConsistent(
  board: Record<string, unknown> | null | undefined,
): boolean {
  const pres = resolveSystemStateFromBoard(board);
  const focus = parseSystemFocusFromBoard(board);
  const userLed = parseUserLedProjectFromBoard(board);
  const learning = parseLearningActivityFromBoard(board);
  const activeJobs = countActiveManagedJobs(boardTasks(board));

  if (pres.key === "on_a_project") {
    if (activeJobs === 0) return false;
    if (!userLed) return false;
    if (pres.missionId !== userLed.mission_id || pres.projectTitle !== userLed.title) {
      return false;
    }
    if (focus && focus.state === "on_a_project") {
      if (focus.mission_id !== userLed.mission_id || focus.title !== userLed.title) return false;
    }
    return true;
  }
  if (pres.key === "learning") {
    if (activeJobs === 0) return false;
    if (!learning) return false;
    if (pres.missionId !== learning.mission_id || pres.projectTitle !== learning.title) {
      return false;
    }
    if (focus && focus.state === "learning") {
      if (focus.mission_id !== learning.mission_id || focus.title !== learning.title) return false;
    }
    return true;
  }
  if (learning) return false;
  if (focus && focus.state !== "cooling" && activeJobs === 0) return false;
  if (focus && focus.state !== "cooling" && pres.key === "cooling") return false;
  return true;
}

export function systemStateTone(
  key: SystemStateKey,
): "live" | "wait" | "idle" | "off" {
  if (key === "on_a_project") return "live";
  if (key === "learning") return "wait";
  return "idle";
}

export function intelligenceStateTone(state: SystemStateLabel): "live" | "wait" | "idle" | "off" {
  return systemStateTone(
    state === "ON A PROJECT" ? "on_a_project" : state === "LEARNING" ? "learning" : "cooling",
  );
}
