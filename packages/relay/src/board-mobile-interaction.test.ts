import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WORLD_READABILITY_VEIL_MAX } from "./board-suit-swipe.js";

const html = readFileSync(join(import.meta.dirname, "board.html"), "utf8");

describe("board.html mobile interaction markers", () => {
  it("ships world readability veil without blur on home", () => {
    expect(html).toContain('id="lm-world-readability-veil"');
    expect(html).toContain(".lm-world-readability-veil");
    expect(html).toContain("syncWorldReadabilityVeil");
    expect(html).toContain("/* __suit_swipe_start__ */");
    expect(html).toContain("worldReadabilityVeilOpacity");
    const veilCss = html.match(/\.lm-world-readability-veil\s*\{[^}]+\}/)?.[0] ?? "";
    expect(veilCss).not.toContain("backdrop-filter");
    expect(WORLD_READABILITY_VEIL_MAX).toBeGreaterThan(0.3);
  });

  it("keeps mode rail fixed (no track translate on rail)", () => {
    expect(html).toContain('id="lm-mode-rail"');
    expect(html).not.toContain("lm-mode-rail-track");
    expect(html).not.toMatch(/#lm-mode-rail[^}]*transform:\s*translate/);
  });

  it("uses rAF batched suit swipe and axis lock", () => {
    expect(html).toContain('id="lm-suit-swipe-catcher"');
    expect(html).toContain("scheduleSuitHudDragPaint");
    expect(html).toContain("resolveSwipeAxis");
    expect(html).toContain("resolveSuitSwipeSnap");
    expect(html).toContain("touch-action: pan-y");
    expect(html).toContain("overscroll-behavior: contain");
    expect(html).toContain("lm-hud-swipe-x");
  });

  it("preserves tap navigation on mode chips", () => {
    expect(html).toContain("setWorldFocusDest(dest, true)");
    expect(html).toContain("worldSelectorSuppressClick");
  });
});
