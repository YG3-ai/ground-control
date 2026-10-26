/**
 * Codex relationship constellation layout — duplicated in board.html between
 * __codex_present__ markers. Keep in sync.
 */

import type { BoardDataLike, WorldEntityLike } from "./board-world-present.js";
import {
  partitionWorldByRole,
  partitionWorldMissions,
  worldEntityDisplayTitle,
} from "./board-world-present.js";

export type CodexRelation = {
  kind: string;
  from_entity: string;
  to_entity: string;
};

export type CodexNeighbor = {
  entity_id: string;
  kind: string;
  entity: WorldEntityLike;
};

export function codexOrbitPoints(
  count: number,
  cx: number,
  cy: number,
  radius: number,
): { x: number; y: number }[] {
  const n = Math.max(count, 1);
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < count; i++) {
    const ang = (Math.PI * 2 * i) / n - Math.PI / 2;
    out.push({
      x: cx + Math.cos(ang) * radius,
      y: cy + Math.sin(ang) * radius,
    });
  }
  return out;
}

export function pickDefaultCodexCenterId(
  entities: WorldEntityLike[],
  board: BoardDataLike | null | undefined,
): string | null {
  const roles = partitionWorldByRole(entities);
  const { active } = partitionWorldMissions(roles.missions, board);
  if (active[0]?.entity_id) return active[0].entity_id;
  if (roles.systems[0]?.entity_id) return roles.systems[0].entity_id;
  if (roles.people[0]?.entity_id) return roles.people[0].entity_id;
  return entities[0]?.entity_id ?? null;
}

export function codexNeighborsForCenter(
  centerId: string,
  relations: CodexRelation[],
  entitiesById: Map<string, WorldEntityLike>,
  limit = 10,
): CodexNeighbor[] {
  const out: CodexNeighbor[] = [];
  const seen = new Set<string>([centerId]);
  for (const r of relations) {
    let other: string | null = null;
    if (r.from_entity === centerId) other = r.to_entity;
    else if (r.to_entity === centerId) other = r.from_entity;
    if (!other || seen.has(other)) continue;
    const ent = entitiesById.get(other);
    if (!ent) continue;
    seen.add(other);
    out.push({ entity_id: other, kind: r.kind, entity: ent });
    if (out.length >= limit) break;
  }
  return out;
}

export function codexFilterEntities(
  entities: WorldEntityLike[],
  board: BoardDataLike | null | undefined,
  query: string,
  typeFilter: string | null,
): WorldEntityLike[] {
  const q = String(query || "").trim().toLowerCase();
  return entities.filter((e) => {
    if (typeFilter && typeFilter !== "all" && e.entity_type !== typeFilter) {
      return false;
    }
    if (!q) return true;
    const title = worldEntityDisplayTitle(e, undefined, board).toLowerCase();
    const label = String(e.label || "").toLowerCase();
    return title.includes(q) || label.includes(q);
  });
}

export function codexCenterLabel(
  center: WorldEntityLike | null | undefined,
  board: BoardDataLike | null | undefined,
): string {
  if (!center) return "Entity";
  return worldEntityDisplayTitle(center, undefined, board);
}
