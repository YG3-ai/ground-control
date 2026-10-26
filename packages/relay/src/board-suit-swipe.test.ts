import { describe, expect, it } from "vitest";
import {
  applyEdgeRubberBand,
  interpolateModeVeilOpacity,
  modeVeilStrength,
  resolveSuitSwipeSnap,
  resolveSwipeAxis,
  suitHudTrackTranslateX,
  worldReadabilityVeilOpacity,
} from "./board-suit-swipe.js";

describe("mode readability veil", () => {
  it("is absent on home only", () => {
    expect(modeVeilStrength("home")).toBe(0);
    expect(modeVeilStrength("yg3")).toBe(1);
    expect(modeVeilStrength("ground")).toBe(1);
    expect(modeVeilStrength("archive")).toBe(1);
    expect(worldReadabilityVeilOpacity(0)).toBe(0);
    expect(worldReadabilityVeilOpacity(1)).toBeGreaterThan(0.35);
  });

  it("interpolates veil while dragging toward interior modes", () => {
    const mid = interpolateModeVeilOpacity(0, -200, 400);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(interpolateModeVeilOpacity(0, 0, 390)).toBe(0);
    expect(interpolateModeVeilOpacity(1, 0, 390)).toBe(1);
  });
});

describe("resolveSwipeAxis", () => {
  it("locks vertical for predominantly vertical movement", () => {
    expect(resolveSwipeAxis(4, 40, null)).toBe("y");
    expect(resolveSwipeAxis(12, 30, null)).toBe("y");
  });

  it("locks horizontal when horizontal intent is clear", () => {
    expect(resolveSwipeAxis(48, 8, null)).toBe("x");
  });

  it("requires stronger horizontal intent inside scroll surfaces", () => {
    expect(resolveSwipeAxis(20, 14, null, { inScrollSurface: true })).toBe("y");
    expect(resolveSwipeAxis(40, 10, null, { inScrollSurface: true })).toBe("x");
  });
});

describe("resolveSuitSwipeSnap", () => {
  const base = { width: 390, idx: 1, reducedMotion: false };

  it("snaps next on distance threshold", () => {
    expect(resolveSuitSwipeSnap({ ...base, dx: -90, vx: 0 })).toBe("next");
    expect(resolveSuitSwipeSnap({ ...base, dx: -40, vx: 0 })).toBe("stay");
  });

  it("snaps on flick velocity", () => {
    expect(resolveSuitSwipeSnap({ ...base, dx: -12, vx: -0.8 })).toBe("next");
    expect(resolveSuitSwipeSnap({ ...base, dx: 12, vx: 0.8 })).toBe("prev");
  });

  it("does not snap past ends", () => {
    expect(
      resolveSuitSwipeSnap({ ...base, idx: 0, dx: 120, vx: 1.2 }),
    ).toBe("stay");
    expect(
      resolveSuitSwipeSnap({ ...base, idx: 3, dx: -120, vx: -1.2 }),
    ).toBe("stay");
  });
});

describe("suitHudTrackTranslateX", () => {
  it("returns zero offset when settled on home", () => {
    expect(suitHudTrackTranslateX(0, 390, 0)).toBe(0);
  });

  it("rubber-bands at edges", () => {
    expect(applyEdgeRubberBand(80, 0, 3)).toBeCloseTo(80 * 0.26);
    expect(applyEdgeRubberBand(-80, 3, 3)).toBeCloseTo(-80 * 0.26);
    expect(applyEdgeRubberBand(-80, 1, 3)).toBe(-80);
  });
});
