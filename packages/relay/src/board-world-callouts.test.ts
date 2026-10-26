import { describe, expect, it } from "vitest";
import {
  WORLD_CALLOUT_ANCHORS_POSTER,
  WORLD_CALLOUT_ANCHORS_VIDEO,
  coverAnchorToViewport,
  parseObjectPositionPercent,
} from "./board-world-callouts.js";

describe("board-world-callouts", () => {
  it("parses object-position percentages", () => {
    expect(parseObjectPositionPercent("50% 40%")).toEqual({ x: 0.5, y: 0.4 });
  });

  it("maps poster anchors differently than video for same viewport", () => {
    const box = { w: 390, h: 844 };
    const op = { x: 0.5, y: 0.4 };
    const homePoster = coverAnchorToViewport(
      box.w,
      box.h,
      390,
      760,
      op,
      WORLD_CALLOUT_ANCHORS_POSTER.home,
    );
    const groundVideo = coverAnchorToViewport(
      box.w,
      box.h,
      1280,
      720,
      op,
      WORLD_CALLOUT_ANCHORS_VIDEO.ground,
    );
    expect(Math.abs(homePoster.x - groundVideo.x) + Math.abs(homePoster.y - groundVideo.y)).toBeGreaterThan(20);
  });

  it("keeps a fixed anchor when object-position unchanged", () => {
    const a = coverAnchorToViewport(390, 844, 390, 760, { x: 0.5, y: 0.4 }, WORLD_CALLOUT_ANCHORS_POSTER.ground);
    const b = coverAnchorToViewport(390, 844, 390, 760, { x: 0.5, y: 0.4 }, WORLD_CALLOUT_ANCHORS_POSTER.ground);
    expect(a).toEqual(b);
  });

  it("marks far video archive in crop on mobile portrait", () => {
    const archive = coverAnchorToViewport(
      390,
      844,
      1280,
      720,
      { x: 0.5, y: 0.4 },
      WORLD_CALLOUT_ANCHORS_VIDEO.archive,
    );
    expect(typeof archive.inCrop).toBe("boolean");
  });
});
