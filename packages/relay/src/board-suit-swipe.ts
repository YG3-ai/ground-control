/**
 * Suit HUD horizontal swipe + world readability veil — duplicated in board.html
 * between __suit_swipe_start__ / __suit_swipe_end__ markers.
 */

import { SPATIAL_DESTINATIONS, type SpatialDestination } from "./board-spatial-nav.js";

export const SUIT_MODE_COUNT = SPATIAL_DESTINATIONS.length;

export const SUIT_SWIPE_AXIS_THRESHOLD_PX = 10;
export const SUIT_SWIPE_AXIS_THRESHOLD_SCROLL_PX = 14;
export const SUIT_SWIPE_HORIZONTAL_RATIO = 1.18;
export const SUIT_SWIPE_HORIZONTAL_RATIO_SCROLL = 1.55;

export const SUIT_SWIPE_DISTANCE_RATIO = 0.22;
export const SUIT_SWIPE_DISTANCE_RATIO_REDUCED = 0.34;
export const SUIT_SWIPE_FLICK_VELOCITY_PX_MS = 0.55;
export const SUIT_SWIPE_EDGE_RUBBER = 0.26;

const MODE_VEIL: Record<SpatialDestination, number> = {
  home: 0,
  yg3: 1,
  ground: 1,
  archive: 1,
};

export type SwipeAxis = "x" | "y" | null;

export function resolveSwipeAxis(
  dx: number,
  dy: number,
  current: SwipeAxis,
  opts?: { inScrollSurface?: boolean },
): SwipeAxis {
  if (current) return current;
  const threshold = opts?.inScrollSurface
    ? SUIT_SWIPE_AXIS_THRESHOLD_SCROLL_PX
    : SUIT_SWIPE_AXIS_THRESHOLD_PX;
  const ratio = opts?.inScrollSurface
    ? SUIT_SWIPE_HORIZONTAL_RATIO_SCROLL
    : SUIT_SWIPE_HORIZONTAL_RATIO;
  if (Math.abs(dx) < threshold && Math.abs(dy) < threshold) return null;
  return Math.abs(dx) > Math.abs(dy) * ratio ? "x" : "y";
}

export function applyEdgeRubberBand(
  dx: number,
  idx: number,
  maxIdx: number,
): number {
  if (idx <= 0 && dx > 0) return dx * SUIT_SWIPE_EDGE_RUBBER;
  if (idx >= maxIdx && dx < 0) return dx * SUIT_SWIPE_EDGE_RUBBER;
  return dx;
}

export function suitHudTrackTranslateX(
  idx: number,
  width: number,
  dragDx: number,
): number {
  const w = Math.max(1, width);
  return -idx * w + dragDx;
}

export function modeVeilStrength(dest: SpatialDestination | string): number {
  return MODE_VEIL[dest as SpatialDestination] ?? 0;
}

/** Interpolate veil strength while dragging between modes (0 = home, no veil). */
export function interpolateModeVeilOpacity(
  idx: number,
  dragDx: number,
  width: number,
): number {
  const w = Math.max(1, width);
  const progress = idx - dragDx / w;
  const clamped = Math.max(0, Math.min(SUIT_MODE_COUNT - 1, progress));
  const i0 = Math.floor(clamped);
  const i1 = Math.min(SUIT_MODE_COUNT - 1, i0 + 1);
  const t = clamped - i0;
  const dest0 = SPATIAL_DESTINATIONS[i0]!;
  const dest1 = SPATIAL_DESTINATIONS[i1]!;
  const v0 = modeVeilStrength(dest0);
  const v1 = modeVeilStrength(dest1);
  return v0 + (v1 - v0) * t;
}

export type SwipeSnapInput = {
  dx: number;
  vx: number;
  width: number;
  idx: number;
  reducedMotion: boolean;
};

export type SwipeSnapResult = "stay" | "next" | "prev";

export function resolveSuitSwipeSnap(input: SwipeSnapInput): SwipeSnapResult {
  const w = Math.max(1, input.width);
  const maxIdx = SUIT_MODE_COUNT - 1;
  const distRatio = input.reducedMotion
    ? SUIT_SWIPE_DISTANCE_RATIO_REDUCED
    : SUIT_SWIPE_DISTANCE_RATIO;
  const flick = input.reducedMotion ? 999 : SUIT_SWIPE_FLICK_VELOCITY_PX_MS;

  if (input.vx < -flick && input.idx < maxIdx) return "next";
  if (input.vx > flick && input.idx > 0) return "prev";
  if (input.dx < -w * distRatio && input.idx < maxIdx) return "next";
  if (input.dx > w * distRatio && input.idx > 0) return "prev";
  return "stay";
}

/** Max veil opacity applied to the cinematic layer (not home). */
export const WORLD_READABILITY_VEIL_MAX = 0.44;

export function worldReadabilityVeilOpacity(strength: number): number {
  if (strength <= 0) return 0;
  return Math.min(WORLD_READABILITY_VEIL_MAX, strength * WORLD_READABILITY_VEIL_MAX);
}
