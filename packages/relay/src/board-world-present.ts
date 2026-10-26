/**
 * Owner World tab presentation (canonical mission titles from board data).
 * Duplicated in board.html between __world_present__ markers — keep in sync.
 */

export type BoardMissionLike = {
  id: string;
  title?: string | null;
  col?: string;
  status?: string;
  updated_at?: string;
  created_at?: string;
};

const MISSION_STATUS_LABEL: Record<string, string> = {
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

export type BoardDataLike = {
  missions?: BoardMissionLike[];
  columns?: Record<string, BoardMissionLike[]>;
};

export type WorldEntityLike = {
  entity_id?: string;
  entity_type?: string;
  label?: string;
  state?: string | null;
  last_seen_at?: string;
};

const HISTORY_MISSION_STATES = new Set(["done", "cancelled"]);

export function missionIdPrefixFromWorldLabel(label: string): string | null {
  const m = /^mission\s+([a-f0-9]{8})$/i.exec(String(label || "").trim());
  return m?.[1]?.toLowerCase() ?? null;
}

export function eachBoardMission(
  data: BoardDataLike | null | undefined,
): BoardMissionLike[] {
  if (!data) return [];
  const seen = new Set<string>();
  const out: BoardMissionLike[] = [];
  const push = (m: BoardMissionLike, col?: string) => {
    if (!m?.id || seen.has(m.id)) return;
    seen.add(m.id);
    out.push(col ? { ...m, col } : m);
  };
  for (const m of data.missions || []) push(m);
  const cols = data.columns || {};
  for (const key of Object.keys(cols)) {
    for (const row of cols[key] || []) push(row, key);
  }
  return out;
}

export function findBoardMission(
  data: BoardDataLike | null | undefined,
  missionId: string,
): BoardMissionLike | null {
  if (!missionId) return null;
  const id = missionId.toLowerCase();
  for (const m of eachBoardMission(data)) {
    if (m.id.toLowerCase() === id) return m;
  }
  return null;
}

export function findBoardMissionByPrefix(
  data: BoardDataLike | null | undefined,
  prefix: string,
): BoardMissionLike | null {
  if (!prefix) return null;
  const p = prefix.toLowerCase();
  const matches = eachBoardMission(data).filter((m) =>
    m.id.toLowerCase().startsWith(p),
  );
  if (!matches.length) return null;
  if (matches.length === 1) return matches[0] ?? null;
  const active = matches.filter(
    (m) => !HISTORY_MISSION_STATES.has(String(m.col || m.status || "")),
  );
  return active[0] ?? matches[0] ?? null;
}

export function resolveWorldMissionId(
  entity: WorldEntityLike,
  aliases: string[] | undefined,
  board: BoardDataLike | null | undefined,
): string | null {
  if (entity.entity_type !== "mission") return null;
  if (aliases?.length) {
    for (const a of aliases) {
      if (a.startsWith("mission:")) return a.slice("mission:".length);
    }
  }
  const prefix = missionIdPrefixFromWorldLabel(entity.label || "");
  if (!prefix) return null;
  const m = findBoardMissionByPrefix(board, prefix);
  return m?.id ?? null;
}

export function humanizeWorldLabel(label: string): string {
  const s = String(label || "").trim();
  if (!s) return "System";
  if (/^mission\s+[a-f0-9]{8}$/i.test(s)) return "Project";
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");
}

export function worldEntityDisplayTitle(
  entity: WorldEntityLike,
  aliases: string[] | undefined,
  board: BoardDataLike | null | undefined,
): string {
  if (entity.entity_type === "mission") {
    const mid = resolveWorldMissionId(entity, aliases, board);
    if (mid) {
      const m = findBoardMission(board, mid);
      if (m?.title) return m.title;
    }
    return "Project";
  }
  if (entity.entity_type === "person" && entity.label === "owner") return "You";
  return humanizeWorldLabel(entity.label || entity.entity_type || "Entity");
}

export function worldMissionIsHistory(
  entity: WorldEntityLike,
  boardMission: BoardMissionLike | null,
): boolean {
  const st =
    boardMission?.col ||
    boardMission?.status ||
    entity.state ||
    "";
  return HISTORY_MISSION_STATES.has(String(st));
}

const ACTIVE_COL_RANK: Record<string, number> = {
  blocked: 0,
  verifying: 1,
  implementing: 1,
  in_progress: 1,
  approved: 2,
  plan_ready: 2,
  researching: 2,
  intake: 3,
};

export function worldMissionRank(
  entity: WorldEntityLike,
  board: BoardDataLike | null | undefined,
): number {
  const mid = resolveWorldMissionId(entity, undefined, board);
  const m = mid ? findBoardMission(board, mid) : null;
  if (worldMissionIsHistory(entity, m)) return 100;
  const col = String(m?.col || m?.status || entity.state || "");
  return ACTIVE_COL_RANK[col] ?? 50;
}

export function partitionWorldMissions<T extends WorldEntityLike>(
  entities: T[],
  board: BoardDataLike | null | undefined,
): { active: T[]; history: T[] } {
  const missions = entities.filter((e) => e.entity_type === "mission");
  const sorted = missions.slice().sort((a, b) => {
    const d = worldMissionRank(a, board) - worldMissionRank(b, board);
    if (d) return d;
    return String(b.last_seen_at || "").localeCompare(
      String(a.last_seen_at || ""),
    );
  });
  const active: T[] = [];
  const history: T[] = [];
  for (const e of sorted) {
    const mid = resolveWorldMissionId(e, undefined, board);
    const m = mid ? findBoardMission(board, mid) : null;
    if (worldMissionIsHistory(e, m)) history.push(e);
    else active.push(e);
  }
  return { active, history };
}

export function missionBoardStatusLabel(m: BoardMissionLike): string {
  const key = String(m.col || m.status || "");
  return MISSION_STATUS_LABEL[key] || "Active";
}

export function worldEntityStateLabel(entity: WorldEntityLike): string {
  if (entity.state) return String(entity.state).replace(/_/g, " ");
  return "active";
}

/** Prefer board mission timestamps; label world-index age when that is all we have. */
export function worldEntityRowMeta(
  entity: WorldEntityLike,
  board: BoardDataLike | null | undefined,
  relTime: (iso: string | undefined | null) => string,
): string {
  const mid = resolveWorldMissionId(entity, undefined, board);
  const m = mid ? findBoardMission(board, mid) : null;
  const st = m ? missionBoardStatusLabel(m) : worldEntityStateLabel(entity);
  const boardAt = m?.updated_at || m?.created_at;
  if (entity.entity_type === "mission" && m && boardAt) {
    return `${st} · updated ${relTime(boardAt)}`;
  }
  if (entity.last_seen_at) {
    const age = relTime(entity.last_seen_at);
    if (entity.entity_type === "mission") return `${st} · world index ${age}`;
    return `${st} · ${age}`;
  }
  return st;
}

export function worldEntityFreshnessCaption(
  entity: WorldEntityLike,
  aliases: string[] | undefined,
  board: BoardDataLike | null | undefined,
  relTime: (iso: string | undefined | null) => string,
): string {
  const mid = resolveWorldMissionId(entity, aliases, board);
  const m = mid ? findBoardMission(board, mid) : null;
  const boardAt = m?.updated_at || m?.created_at;
  if (m && boardAt) {
    return `Project updated ${relTime(boardAt)}`;
  }
  if (entity.last_seen_at) {
    return `World index last event ${relTime(entity.last_seen_at)}`;
  }
  return "";
}

const WORLD_INFRA_ENTITY_TYPES = new Set(["service", "agent"]);

export function worldEntityIsInfrastructure(entity: WorldEntityLike): boolean {
  return WORLD_INFRA_ENTITY_TYPES.has(String(entity.entity_type || ""));
}

export function partitionWorldByRole<T extends WorldEntityLike>(
  entities: T[],
): { missions: T[]; people: T[]; organizations: T[]; systems: T[] } {
  const missions: T[] = [];
  const people: T[] = [];
  const organizations: T[] = [];
  const systems: T[] = [];
  for (const e of entities) {
    const t = e.entity_type;
    if (t === "mission") missions.push(e);
    else if (t === "person") people.push(e);
    else if (t === "organization") organizations.push(e);
    else if (WORLD_INFRA_ENTITY_TYPES.has(String(t || ""))) systems.push(e);
  }
  return { missions, people, organizations, systems };
}

export type WorldConstellationSlice = {
  key: string;
  label: string;
  count: number;
};

/** Real entity counts for World map header — no invented relationships. */
export function worldConstellationSlices(
  entities: WorldEntityLike[],
  board: BoardDataLike | null | undefined,
): WorldConstellationSlice[] {
  const roles = partitionWorldByRole(entities);
  const { active, history } = partitionWorldMissions(roles.missions, board);
  const out: WorldConstellationSlice[] = [];
  if (active.length) {
    out.push({ key: "missions", label: "Projects", count: active.length });
  } else if (history.length) {
    out.push({ key: "history", label: "Archive", count: history.length });
  }
  if (roles.people.length) {
    out.push({ key: "people", label: "People", count: roles.people.length });
  }
  if (roles.organizations.length) {
    out.push({
      key: "orgs",
      label: "Orgs",
      count: roles.organizations.length,
    });
  }
  if (roles.systems.length) {
    out.push({
      key: "systems",
      label: "Systems",
      count: roles.systems.length,
    });
  }
  return out;
}

export function codexSliceEntities<T extends WorldEntityLike>(
  key: string,
  roles: { missions: T[]; people: T[]; organizations: T[]; systems: T[] },
  board: BoardDataLike | null | undefined,
): T[] {
  const parts = partitionWorldMissions(roles.missions, board);
  if (key === "missions") return parts.active;
  if (key === "history") return parts.history;
  if (key === "people") return roles.people;
  if (key === "orgs") return roles.organizations;
  if (key === "systems") {
    return roles.systems.slice().sort((a, b) =>
      String(b.last_seen_at || "").localeCompare(String(a.last_seen_at || "")),
    );
  }
  return [];
}

export function worldHomePulseLine(
  entities: WorldEntityLike[],
  board: BoardDataLike | null | undefined,
): string | null {
  const { active, history } = partitionWorldMissions(entities, board);
  const names: string[] = [];
  for (const e of active.slice(0, 3)) {
    const t = worldEntityDisplayTitle(e, undefined, board);
    if (t && !names.includes(t)) names.push(t);
  }
  if (names.length) return names.join(" · ");
  if (history.length && !active.length) return "No active projects — open World for history";
  return null;
}
