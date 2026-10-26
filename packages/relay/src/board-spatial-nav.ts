/**
 * Life Mirror spatial IA — duplicated in board.html between __spatial_nav__ markers.
 */

export const SPATIAL_DESTINATIONS = ["home", "yg3", "ground", "archive"] as const;
export type SpatialDestination = (typeof SPATIAL_DESTINATIONS)[number];

export type SpatialView = "world" | "room";

export const LIFE_MIRROR_ASSET_BASE = "/assets/life-mirror/";

export const MENU_SURFACE_TABS: Record<string, string> = {
  missions: "missions",
  capabilities: "skills",
  codex: "world",
  evolution: "evolution",
  system: "now",
};

/** Cinematic interior bay — duplicated in board.html spatial block. */
export const INTERIOR_FOR_TAB: Record<string, string> = {
  missions: "workbench",
  skills: "armory",
  world: "codex",
  evolution: "archive",
  now: "control",
  notes: "home",
  growth: "growth",
};

export const INTERIOR_BAY_TITLES: Record<string, string> = {
  workbench: "Workbench",
  armory: "Armory",
  codex: "Codex",
  archive: "Archive",
  control: "Control",
  home: "Home",
  growth: "Growth",
};

export function interiorKindForTab(tab: string): string {
  return INTERIOR_FOR_TAB[tab] ?? "control";
}

export function interiorBayTitle(kind: string): string {
  return INTERIOR_BAY_TITLES[kind] ?? kind;
}

/** HOME is suit HUD observation — not an enterable room. */
export function destinationEnterable(dest: SpatialDestination | string): boolean {
  return dest !== "home";
}

export function destinationLabel(dest: SpatialDestination): string {
  return (
    { home: "HOME", yg3: "YG3", ground: "GROUND", archive: "ARCHIVE" } as Record<
      string,
      string
    >
  )[dest] ?? String(dest).toUpperCase();
}

export function roomImageAsset(dest: SpatialDestination): string | null {
  if (dest === "ground") return `${LIFE_MIRROR_ASSET_BASE}ground-room.webp`;
  return null;
}

/** Shell rooms route to existing real surfaces (no invented imagery). */
export function shellSurfaceTab(dest: SpatialDestination): string {
  if (dest === "home") return "notes";
  if (dest === "yg3") return "growth";
  if (dest === "archive") return "missions";
  return "now";
}

export function nextDestination(
  dest: SpatialDestination,
): SpatialDestination {
  const i = SPATIAL_DESTINATIONS.indexOf(dest);
  if (i < 0) return SPATIAL_DESTINATIONS[0]!;
  return SPATIAL_DESTINATIONS[(i + 1) % SPATIAL_DESTINATIONS.length]!;
}

export function prevDestination(
  dest: SpatialDestination,
): SpatialDestination {
  const i = SPATIAL_DESTINATIONS.indexOf(dest);
  if (i < 0) return SPATIAL_DESTINATIONS[0]!;
  return SPATIAL_DESTINATIONS[
    (i - 1 + SPATIAL_DESTINATIONS.length) % SPATIAL_DESTINATIONS.length
  ]!;
}

import { WORLD_CALLOUT_ANCHORS_POSTER } from "./board-world-callouts.js";

export type WorldPreviewThumb = { src: string; objectPosition: string };

/** Room portal thumbnail from existing art (world crop or ground interior). */
export function worldPreviewThumb(dest: SpatialDestination): WorldPreviewThumb {
  if (dest === "home") {
    return {
      src: `${LIFE_MIRROR_ASSET_BASE}world.webp`,
      objectPosition: "50% 40%",
    };
  }
  if (dest === "ground") {
    return {
      src: `${LIFE_MIRROR_ASSET_BASE}ground-room.webp`,
      objectPosition: "50% 46%",
    };
  }
  const anchor = WORLD_CALLOUT_ANCHORS_POSTER[dest];
  const x = Math.round(anchor.nx * 100);
  const y = Math.round(anchor.ny * 100);
  return {
    src: `${LIFE_MIRROR_ASSET_BASE}world.webp`,
    objectPosition: `${x}% ${y}%`,
  };
}

/** @deprecated Use WORLD_CALLOUT_ANCHORS_* in board-world-callouts.ts */
export { WORLD_CALLOUT_ANCHORS_POSTER as WORLD_DESTINATION_BEACONS } from "./board-world-callouts.js";

export function exceptionalAlertCount(
  approvals: unknown[] | null | undefined,
  decisions: unknown[] | null | undefined,
): number {
  return (approvals?.length ?? 0) + (decisions?.length ?? 0);
}
