import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  currentSpatialLayer,
  persistBackLabel,
  persistBackVisible,
  resolveDetailBackAriaLabel,
  resolveInWorldDetailKicker,
  resolveWorldFeed,
  spatialBackTarget,
} from "./board-spatial-detail.js";

describe("board-spatial-detail", () => {
  it("layers depth in order world → room → surface → detail", () => {
    expect(
      currentSpatialLayer({
        spatialView: "world",
        surfaceOpen: false,
        detailOpen: false,
      }),
    ).toBe("world");
    expect(
      currentSpatialLayer({
        spatialView: "room",
        surfaceOpen: false,
        detailOpen: false,
      }),
    ).toBe("room");
    expect(
      currentSpatialLayer({
        spatialView: "room",
        surfaceOpen: true,
        detailOpen: false,
      }),
    ).toBe("surface");
    expect(
      currentSpatialLayer({
        spatialView: "world",
        surfaceOpen: true,
        detailOpen: true,
      }),
    ).toBe("detail");
  });

  it("unwinds one parent per back action", () => {
    const inDetail = {
      spatialView: "room" as const,
      surfaceOpen: true,
      detailOpen: true,
    };
    expect(spatialBackTarget(inDetail)).toBe("surface");
    expect(persistBackLabel(inDetail)).toBe("Back");

    const inSurfaceRoom = {
      spatialView: "room" as const,
      surfaceOpen: true,
      detailOpen: false,
    };
    expect(spatialBackTarget(inSurfaceRoom)).toBe("room");
    expect(persistBackLabel(inSurfaceRoom)).toBe("Back");

    const inSurfaceMenu = {
      spatialView: "world" as const,
      surfaceOpen: true,
      detailOpen: false,
    };
    expect(spatialBackTarget(inSurfaceMenu)).toBe("world");
    expect(persistBackLabel(inSurfaceMenu)).toBe("Back");
  });

  it("shows persist back whenever not on world map", () => {
    expect(
      persistBackVisible({
        spatialView: "world",
        surfaceOpen: false,
        detailOpen: false,
      }),
    ).toBe(false);
    expect(
      persistBackVisible({
        spatialView: "room",
        surfaceOpen: false,
        detailOpen: false,
      }),
    ).toBe(true);
  });

  it("ground project history detail uses PROJECT eyebrow and Back to Ground aria", () => {
    const chrome = { kicker: "PROJECT", backAriaTarget: "Ground" };
    expect(
      resolveInWorldDetailKicker(chrome, false, "world", null, "ground", null),
    ).toBe("PROJECT");
    expect(
      resolveDetailBackAriaLabel(chrome, false, "control", { control: "Control" }, "ground"),
    ).toBe("Back to Ground");
  });

  it("reuses home world brief when dedicated codex fetch is empty", () => {
    expect(
      resolveWorldFeed({ ok: false, error: "unavailable" }, {
        ok: true,
        summary: { entities_total: 35 },
        entities: [{ entity_id: "e1" }],
      }),
    ).toEqual({
      ok: true,
      summary: { entities_total: 35 },
      entities: [{ entity_id: "e1" }],
    });
    expect(resolveWorldFeed({ ok: true, entities: [] }, { ok: true, entities: [1] })).toEqual({
      ok: true,
      entities: [],
    });
  });
});

describe("board.html in-world detail markers", () => {
  const html = readFileSync(join(import.meta.dirname, "board.html"), "utf8");

  it("uses full-screen detail layer instead of centered sheet for drill-downs", () => {
    expect(html).toContain("/* __spatial_detail_start__ */");
    expect(html).toContain('id="lm-detail"');
    expect(html).toContain('id="lm-persist-back"');
    expect(html).toContain("lm-back-label");
    expect(html).toContain("lm-beyond-world");
    expect(html).toMatch(/#lm-persist-back[\s\S]*top:\s*calc/);
    expect(html).toContain("openInWorldDetail");
    expect(html).toContain("spatialBackOne");
    expect(html).toContain('id="lm-surface-orient"');
    expect(html).toContain("resolveInWorldDetailKicker");
    expect(html).toContain("syncSuitHudPlaneVisibility");
    expect(html).toContain("lmDetailChrome");
  });
});
