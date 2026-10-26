import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isAllowedLifeMirrorAsset,
  resolveLifeMirrorAssetPath,
} from "./life-mirror-assets.js";

describe("life-mirror-assets", () => {
  it("allows webp and world-live mp4 only", () => {
    expect(isAllowedLifeMirrorAsset("world.webp")).toBe(true);
    expect(isAllowedLifeMirrorAsset("world-live.mp4")).toBe(true);
    expect(isAllowedLifeMirrorAsset("world-live-1080.mp4")).toBe(true);
    expect(isAllowedLifeMirrorAsset("world-live-4k.mp4")).toBe(true);
    expect(isAllowedLifeMirrorAsset("../world-live.mp4")).toBe(false);
    expect(isAllowedLifeMirrorAsset("evil.mp4")).toBe(false);
  });

  it("resolves world-live.mp4 from relay src layout", () => {
    const relayDir = join(import.meta.dirname);
    const path = resolveLifeMirrorAssetPath(relayDir, "world-live.mp4");
    expect(path).toBeTruthy();
    expect(path!).toContain("world-live.mp4");
  });
});
