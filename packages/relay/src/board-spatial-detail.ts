/**
 * Life Mirror navigation depth — duplicated in board.html between __spatial_detail__ markers.
 */

export type SpatialView = "world" | "room";

export type SpatialNavState = {
  spatialView: SpatialView;
  surfaceOpen: boolean;
  detailOpen: boolean;
};

export type SpatialLayer = "world" | "room" | "surface" | "detail";

export function currentSpatialLayer(state: SpatialNavState): SpatialLayer {
  if (state.detailOpen) return "detail";
  if (state.surfaceOpen) return "surface";
  if (state.spatialView === "room") return "room";
  return "world";
}

export function persistBackVisible(state: SpatialNavState): boolean {
  return currentSpatialLayer(state) !== "world";
}

export function persistBackLabel(_state: SpatialNavState): string {
  return "Back";
}

export function spatialBackTarget(state: SpatialNavState): SpatialLayer | null {
  const layer = currentSpatialLayer(state);
  if (layer === "detail") return "surface";
  if (layer === "surface") {
    return state.spatialView === "room" ? "room" : "world";
  }
  if (layer === "room") return "world";
  return null;
}

export type WorldFeed = {
  ok?: boolean;
  error?: string;
  entities?: unknown[];
  summary?: { entities_total?: number };
};

/** Prefer full world index; fall back to home-feed brief when the dedicated fetch lags. */
export function resolveWorldFeed(
  worldData: WorldFeed | null | undefined,
  brief: WorldFeed | null | undefined,
): WorldFeed | null {
  if (worldData && worldData.ok) return worldData;
  if (brief && brief.ok) return brief;
  return worldData ?? brief ?? null;
}

/** Override detail eyebrow + persist-back aria when drilling from a suit HUD (not an interior). */
export type InWorldDetailChrome = {
  kicker: string;
  backAriaTarget: string;
};

export function resolveInWorldDetailKicker(
  chrome: InWorldDetailChrome | null | undefined,
  lmSurfaceOpen: boolean,
  spatialView: SpatialView,
  spatialDestLabel: string | null,
  worldFocusDest: string,
  interiorBayTitle: string | null,
): string {
  if (chrome?.kicker) return chrome.kicker;
  if (lmSurfaceOpen) return interiorBayTitle || "Interior";
  if (spatialView === "room" && spatialDestLabel) return spatialDestLabel;
  if (worldFocusDest === "archive") return "Archive";
  if (worldFocusDest === "ground") return "Ground";
  if (worldFocusDest === "yg3") return "YG3";
  if (worldFocusDest === "home") return "Home";
  return "World";
}

export function resolveDetailBackAriaLabel(
  chrome: InWorldDetailChrome | null | undefined,
  lmSurfaceOpen: boolean,
  interiorKind: string | null,
  interiorBayTitles: Record<string, string>,
  worldFocusDest: string,
): string {
  if (chrome?.backAriaTarget) return `Back to ${chrome.backAriaTarget}`;
  if (!lmSurfaceOpen && worldFocusDest === "archive") return "Back to Archive";
  if (!lmSurfaceOpen && worldFocusDest === "ground") return "Back to Ground";
  if (lmSurfaceOpen && interiorKind) {
    return `Back to ${interiorBayTitles[interiorKind] || "room"}`;
  }
  return "Back";
}
