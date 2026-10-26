/**
 * World home living-still video — duplicated in board.html between __world_live__ markers.
 */

export const LIFE_MIRROR_ASSET_BASE = "/assets/life-mirror/";
export const WORLD_LIVE_POSTER_FILE = "world.webp";
export const WORLD_LIVE_VIDEO_FILE = "world-live.mp4";

/** Shipped still (1× mobile shell). */
export const WORLD_POSTER_NATIVE = { width: 390, height: 760 };

/** Default mobile/base loop (landscape). */
export const WORLD_LIVE_NATIVE = { width: 1280, height: 720 };

/** Magnific upscale master (fixtures; not served). */
export const WORLD_LIVE_SOURCE_NATIVE = { width: 3840, height: 2160 };

/** Optional tiers — served only when files exist on disk. */
export const WORLD_LIVE_TIER_FILES = {
  "1080": "world-live-1080.mp4",
  "1440": "world-live-1440.mp4",
  "4k": "world-live-4k.mp4",
  default: WORLD_LIVE_VIDEO_FILE,
} as const;

/** MP4 basenames on disk — extend when HD encodes land (no client probes to missing URLs). */
export const WORLD_LIVE_DEPLOYED_FILES: readonly string[] = [
  WORLD_LIVE_TIER_FILES["4k"],
  WORLD_LIVE_TIER_FILES["1440"],
  WORLD_LIVE_TIER_FILES["1080"],
  WORLD_LIVE_VIDEO_FILE,
];

export function worldLiveSourceCandidates(
  cssWidth: number,
  dpr: number,
  deployed: readonly string[] = WORLD_LIVE_DEPLOYED_FILES,
): string[] {
  const px = cssWidth * Math.min(Math.max(dpr, 1), 2);
  const base = WORLD_LIVE_VIDEO_FILE;
  const t1080 = WORLD_LIVE_TIER_FILES["1080"];
  const t1440 = WORLD_LIVE_TIER_FILES["1440"];
  const t4k = WORLD_LIVE_TIER_FILES["4k"];
  let ordered: string[];
  if (cssWidth < 768) {
    ordered = [t1440, t1080, base];
  } else if (px >= 2560) {
    ordered = [t4k, t1440, t1080, base];
  } else if (px >= 1400) {
    ordered = [t1440, t1080, base];
  } else if (px >= 900) {
    ordered = [t1080, base];
  } else {
    ordered = [base];
  }
  const allow = new Set(deployed);
  const picked = ordered.filter((f) => allow.has(f));
  return picked.length ? picked : [base];
}

export function worldLivePosterUrl(base = LIFE_MIRROR_ASSET_BASE): string {
  return base + WORLD_LIVE_POSTER_FILE;
}

export function worldLiveVideoUrl(base = LIFE_MIRROR_ASSET_BASE): string {
  return base + WORLD_LIVE_VIDEO_FILE;
}

export type WorldLiveEnv = {
  reducedMotion?: boolean;
  saveData?: boolean;
};

export function worldLivePreferStill(env: WorldLiveEnv): boolean {
  return !!(env.reducedMotion || env.saveData);
}

export type WorldLivePlaybackInput = {
  spatialView: "world" | "room";
  surfaceOpen: boolean;
  detailOpen: boolean;
  docVisible: boolean;
  preferStill: boolean;
  videoReady: boolean;
};

export function shouldPlayWorldLive(input: WorldLivePlaybackInput): boolean {
  if (input.preferStill || !input.videoReady) return false;
  if (input.spatialView !== "world") return false;
  if (input.surfaceOpen || input.detailOpen) return false;
  if (!input.docVisible) return false;
  return true;
}

export function worldLivePreloadValue(preferStill: boolean): "none" | "metadata" {
  return preferStill ? "none" : "metadata";
}

/** Allowed life-mirror asset filenames served by relay. */
export const LIFE_MIRROR_ASSET_PATTERN =
  /^(world|ground-room)\.webp$|^brain-core-stock(-tight)?-poster\.webp$|^world-live(-1080|-1440|-4k)?\.mp4$|^brain-core-stock(-tight)?\.mp4$/;
