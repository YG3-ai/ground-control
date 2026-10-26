import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LIFE_MIRROR_ASSET_PATTERN,
  WORLD_LIVE_NATIVE,
  WORLD_LIVE_SOURCE_NATIVE,
  WORLD_LIVE_VIDEO_FILE,
  WORLD_POSTER_NATIVE,
  shouldPlayWorldLive,
  worldLivePosterUrl,
  worldLivePreferStill,
  worldLivePreloadValue,
  WORLD_LIVE_DEPLOYED_FILES,
  worldLiveSourceCandidates,
  worldLiveVideoUrl,
} from "./board-world-live.js";

describe("board-world-live", () => {
  it("builds poster and optional video URLs", () => {
    expect(worldLivePosterUrl()).toBe("/assets/life-mirror/world.webp");
    expect(worldLiveVideoUrl()).toBe("/assets/life-mirror/world-live.mp4");
    expect(WORLD_LIVE_VIDEO_FILE).toBe("world-live.mp4");
  });

  it("honors reduced motion and save-data with still poster", () => {
    expect(worldLivePreferStill({ reducedMotion: true })).toBe(true);
    expect(worldLivePreferStill({ saveData: true })).toBe(true);
    expect(worldLivePreferStill({})).toBe(false);
    expect(worldLivePreloadValue(true)).toBe("none");
    expect(worldLivePreloadValue(false)).toBe("metadata");
  });

  it("plays only on visible World without overlays", () => {
    const base = {
      spatialView: "world" as const,
      surfaceOpen: false,
      detailOpen: false,
      docVisible: true,
      preferStill: false,
      videoReady: true,
    };
    expect(shouldPlayWorldLive(base)).toBe(true);
    expect(shouldPlayWorldLive({ ...base, spatialView: "room" })).toBe(false);
    expect(shouldPlayWorldLive({ ...base, surfaceOpen: true })).toBe(false);
    expect(shouldPlayWorldLive({ ...base, detailOpen: true })).toBe(false);
    expect(shouldPlayWorldLive({ ...base, docVisible: false })).toBe(false);
    expect(shouldPlayWorldLive({ ...base, preferStill: true })).toBe(false);
    expect(shouldPlayWorldLive({ ...base, videoReady: false })).toBe(false);
  });

  it("allows optional world-live.mp4 route without requiring the file on disk", () => {
    expect(LIFE_MIRROR_ASSET_PATTERN.test("world-live.mp4")).toBe(true);
    expect(LIFE_MIRROR_ASSET_PATTERN.test("world-live-1080.mp4")).toBe(true);
    expect(LIFE_MIRROR_ASSET_PATTERN.test("world-live-4k.mp4")).toBe(true);
    expect(LIFE_MIRROR_ASSET_PATTERN.test("world.webp")).toBe(true);
    expect(LIFE_MIRROR_ASSET_PATTERN.test("brain-core-stock.mp4")).toBe(true);
    expect(LIFE_MIRROR_ASSET_PATTERN.test("brain-core-stock-tight.mp4")).toBe(true);
    expect(LIFE_MIRROR_ASSET_PATTERN.test("brain-core-stock-poster.webp")).toBe(true);
    expect(LIFE_MIRROR_ASSET_PATTERN.test("brain-core-stock-tight-poster.webp")).toBe(true);
    expect(LIFE_MIRROR_ASSET_PATTERN.test("evil.mp4")).toBe(false);
  });

  it("documents native asset dimensions and responsive tier order", () => {
    expect(WORLD_POSTER_NATIVE).toEqual({ width: 390, height: 760 });
    expect(WORLD_LIVE_NATIVE).toEqual({ width: 1280, height: 720 });
    expect(WORLD_LIVE_SOURCE_NATIVE).toEqual({ width: 3840, height: 2160 });
    expect(WORLD_LIVE_DEPLOYED_FILES).toEqual([
      "world-live-4k.mp4",
      "world-live-1440.mp4",
      "world-live-1080.mp4",
      "world-live.mp4",
    ]);
    expect(worldLiveSourceCandidates(390, 2)).toEqual([
      "world-live-1440.mp4",
      "world-live-1080.mp4",
      "world-live.mp4",
    ]);
    const allTiers = [
      "world-live-4k.mp4",
      "world-live-1440.mp4",
      "world-live-1080.mp4",
      "world-live.mp4",
    ];
    expect(worldLiveSourceCandidates(390, 2, allTiers)).toEqual([
      "world-live-1440.mp4",
      "world-live-1080.mp4",
      "world-live.mp4",
    ]);
    expect(worldLiveSourceCandidates(1280, 2, allTiers)).toEqual(allTiers);
  });

  it("ships loop-optimized world live asset for mobile web", () => {
    const path = join(import.meta.dirname, "assets", "life-mirror", "world-live.mp4");
    const buf = readFileSync(path);
    expect(buf.length).toBeGreaterThan(250_000);
    expect(buf.length).toBeLessThan(900_000);
    expect(createHash("sha256").update(buf).digest("hex")).toBe(
      "bfa1276c841b1f2cbf1625f08f31051df9e5ce437b92a522e7fe532b7ddd1335",
    );
    const st = statSync(path);
    expect(st.size).toBe(buf.length);
  });
});

describe("board.html world live markers", () => {
  const html = readFileSync(join(import.meta.dirname, "board.html"), "utf8");

  it("wires world-only live background and hides spatial link chrome", () => {
    expect(html).toContain("/* __world_live_start__ */");
    expect(html).toContain('id="lm-world-live"');
    expect(html).toContain('id="lm-world-poster"');
    expect(html).toContain("world-live.mp4");
    expect(html).not.toContain('id="conn-label"');
    expect(html).not.toContain('id="lm-conn"');
    expect(html).toContain("WORLD_LIVE_DEPLOYED");
    expect(html).toContain("pickWorldLiveFile");
    expect(html).toContain("syncWorldLivePlayback");
    expect(html).toContain("syncLinkChrome");
  });
});
