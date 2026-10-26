import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applySpatialBackOneStep,
  popstateSpatialAction,
  shouldCollapseShellRoomAfterSurface,
  spatialHistoryDepthFromState,
  spatialUiDepth,
  syncSpatialUiToHistoryDepth,
} from "./board-spatial-history.js";

describe("board-spatial-history", () => {
  it("reads gcSpatial depth from history state", () => {
    expect(spatialHistoryDepthFromState({ gcSpatial: 2 })).toBe(2);
    expect(spatialHistoryDepthFromState({ gcSpatial: -1 })).toBeNull();
    expect(spatialHistoryDepthFromState(null)).toBeNull();
    expect(spatialHistoryDepthFromState({})).toBeNull();
  });

  it("collapses shell room when backing out of auto-opened surface", () => {
    expect(shouldCollapseShellRoomAfterSurface("home")).toBe(true);
    expect(shouldCollapseShellRoomAfterSurface("ground")).toBe(false);
    const homeSurface = {
      spatialView: "room" as const,
      dest: "home",
      surfaceOpen: true,
      detailOpen: false,
    };
    expect(spatialUiDepth(homeSurface)).toBe(2);
    const afterOne = applySpatialBackOneStep(homeSurface);
    expect(afterOne.spatialView).toBe("world");
    expect(afterOne.surfaceOpen).toBe(false);
    expect(spatialUiDepth(afterOne)).toBe(0);
  });

  it("fresh load → enter room → one back equals world (shell room)", () => {
    const inHome = {
      spatialView: "room" as const,
      dest: "home",
      surfaceOpen: true,
      detailOpen: false,
    };
    expect(syncSpatialUiToHistoryDepth(inHome, 0).spatialView).toBe("world");
  });

  it("world → room → detail unwinds detail then room", () => {
    const inDetail = {
      spatialView: "room" as const,
      dest: "ground",
      surfaceOpen: true,
      detailOpen: true,
    };
    expect(spatialUiDepth(inDetail)).toBe(3);
    const afterDetail = syncSpatialUiToHistoryDepth(inDetail, 2);
    expect(afterDetail.detailOpen).toBe(false);
    expect(afterDetail.surfaceOpen).toBe(true);
    expect(afterDetail.spatialView).toBe("room");
    const afterSurface = syncSpatialUiToHistoryDepth(afterDetail, 1);
    expect(afterSurface.surfaceOpen).toBe(false);
    expect(afterSurface.spatialView).toBe("room");
    const afterRoom = syncSpatialUiToHistoryDepth(afterSurface, 0);
    expect(afterRoom.spatialView).toBe("world");
  });

  it("ground surface back keeps room layer", () => {
    const inSurface = {
      spatialView: "room" as const,
      dest: "ground",
      surfaceOpen: true,
      detailOpen: false,
    };
    const after = applySpatialBackOneStep(inSurface);
    expect(after.spatialView).toBe("room");
    expect(after.surfaceOpen).toBe(false);
  });

  it("invalid popstate on nested UI resets to world", () => {
    const nested = {
      spatialView: "room" as const,
      dest: "home",
      surfaceOpen: true,
      detailOpen: false,
    };
    expect(popstateSpatialAction(null, nested)).toBe("reset_world");
    expect(popstateSpatialAction(0, nested)).toBe("sync");
  });
});

describe("board.html spatial history markers", () => {
  const html = readFileSync(join(import.meta.dirname, "board.html"), "utf8");

  it("syncs UI depth to gcSpatial history entries", () => {
    expect(html).toContain("syncSpatialToHistoryDepth");
    expect(html).toContain("spatialUiDepth");
    expect(html).toContain("resetSpatialToWorld");
    expect(html).toContain("spatialHistoryDepthFromState");
    expect(html).toContain("shouldCollapseShellRoomAfterSurface");
  });
});
