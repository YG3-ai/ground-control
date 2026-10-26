/**
 * Life Mirror browser history ↔ UI depth — mirrored in board.html spatial block.
 */

import { currentSpatialLayer, type SpatialNavState } from "./board-spatial-detail.js";

export type SpatialUiState = SpatialNavState & {
  dest: string | null;
};

export const SPATIAL_HISTORY_KEY = "gcSpatial";

export function spatialHistoryDepthFromState(state: unknown): number | null {
  if (!state || typeof state !== "object") return null;
  const raw = (state as Record<string, unknown>)[SPATIAL_HISTORY_KEY];
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return null;
  return Math.floor(raw);
}

/** Shell rooms open a surface without an extra history entry — collapse on surface back. */
export function shouldCollapseShellRoomAfterSurface(dest: string | null): boolean {
  return dest != null && dest !== "ground";
}

export function spatialUiDepth(state: SpatialUiState): number {
  let depth = 0;
  if (state.spatialView === "room") depth += 1;
  if (state.surfaceOpen) depth += 1;
  if (state.detailOpen) depth += 1;
  return depth;
}

export function applySpatialBackOneStep(state: SpatialUiState): SpatialUiState {
  if (state.detailOpen) {
    return { ...state, detailOpen: false };
  }
  if (state.surfaceOpen) {
    const afterSurface = { ...state, surfaceOpen: false };
    if (
      state.spatialView === "room" &&
      shouldCollapseShellRoomAfterSurface(state.dest)
    ) {
      return {
        spatialView: "world",
        dest: null,
        surfaceOpen: false,
        detailOpen: false,
      };
    }
    return afterSurface;
  }
  if (state.spatialView === "room") {
    return {
      spatialView: "world",
      dest: null,
      surfaceOpen: false,
      detailOpen: false,
    };
  }
  return state;
}

export function syncSpatialUiToHistoryDepth(
  state: SpatialUiState,
  targetDepth: number,
): SpatialUiState {
  let next = state;
  let guard = 0;
  while (spatialUiDepth(next) > targetDepth && guard < 8) {
    next = applySpatialBackOneStep(next);
    guard += 1;
  }
  return next;
}

export function popstateSpatialAction(
  historyDepth: number | null,
  ui: SpatialUiState,
): "reset_world" | "sync" {
  if (historyDepth === null) {
    return currentSpatialLayer(ui) === "world" ? "sync" : "reset_world";
  }
  return "sync";
}
