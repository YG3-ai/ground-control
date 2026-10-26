/**
 * World map callout anchors in art pixel space — duplicated in board.html.
 */
import type { SpatialDestination } from "./board-spatial-nav.js";
import { SPATIAL_DESTINATIONS } from "./board-spatial-nav.js";

export const WORLD_POSTER_ART = { width: 390, height: 760 };
export const WORLD_VIDEO_ART = { width: 1280, height: 720 };

/** Normalized 0–1 in poster art (390×760 portrait). */
export const WORLD_CALLOUT_ANCHORS_POSTER: Record<
  SpatialDestination,
  { nx: number; ny: number }
> = {
  home: { nx: 0.2, ny: 0.2 },
  yg3: { nx: 0.8, ny: 0.28 },
  ground: { nx: 0.25, ny: 0.44 },
  archive: { nx: 0.85, ny: 0.64 },
};

/** Normalized 0–1 in video art (1280×720 landscape). */
export const WORLD_CALLOUT_ANCHORS_VIDEO: Record<
  SpatialDestination,
  { nx: number; ny: number }
> = {
  home: { nx: 0.14, ny: 0.28 },
  yg3: { nx: 0.5, ny: 0.24 },
  ground: { nx: 0.5, ny: 0.58 },
  archive: { nx: 0.22, ny: 0.52 },
};

export function parseObjectPositionPercent(
  value: string | null | undefined,
): { x: number; y: number } {
  const parts = (value || "50% 50%").trim().split(/\s+/);
  const px = parts[0] || "50%";
  const py = parts[1] || parts[0] || "50%";
  function pct(s: string, fallback: number): number {
    if (s.endsWith("%")) return parseFloat(s) / 100;
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : fallback;
  }
  return { x: pct(px, 0.5), y: pct(py, 0.5) };
}

export type CoverViewportPoint = {
  x: number;
  y: number;
  inCrop: boolean;
};

/** Map art-normalized anchor to container pixels under object-fit: cover. */
export function coverAnchorToViewport(
  containerW: number,
  containerH: number,
  artW: number,
  artH: number,
  objectPosition: { x: number; y: number },
  anchor: { nx: number; ny: number },
): CoverViewportPoint {
  if (containerW <= 0 || containerH <= 0 || artW <= 0 || artH <= 0) {
    return { x: 0, y: 0, inCrop: false };
  }
  const scale = Math.max(containerW / artW, containerH / artH);
  const rw = artW * scale;
  const rh = artH * scale;
  const bx = objectPosition.x * containerW;
  const by = objectPosition.y * containerH;
  const offsetX = bx - objectPosition.x * artW * scale;
  const offsetY = by - objectPosition.y * artH * scale;
  const x = offsetX + anchor.nx * artW * scale;
  const y = offsetY + anchor.ny * artH * scale;
  const cropL = Math.max(0, offsetX);
  const cropT = Math.max(0, offsetY);
  const cropR = Math.min(containerW, offsetX + rw);
  const cropB = Math.min(containerH, offsetY + rh);
  const inCrop =
    x >= cropL - 2 &&
    x <= cropR + 2 &&
    y >= cropT - 2 &&
    y <= cropB + 2;
  return { x, y, inCrop };
}

export function listWorldCalloutDestinations(): SpatialDestination[] {
  return [...SPATIAL_DESTINATIONS];
}
