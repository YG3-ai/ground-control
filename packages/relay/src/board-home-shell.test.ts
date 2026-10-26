import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateBoardShellHtml } from "./board-html-loader.js";

describe("board life mirror spatial shell", () => {
  const html = readFileSync(join(import.meta.dirname, "board.html"), "utf8");

  it("serves cinematic world home without bottom tab bar", () => {
    expect(html).toContain('id="lm-stage"');
    expect(html).toContain('id="lm-interior"');
    expect(html).toContain("/assets/life-mirror/world.webp");
    expect(html).toContain("lm-world-poster");
    expect(html).toContain("world-live.mp4");
    expect(html).not.toContain('id="conn-label"');
    expect(html).toContain('data-dest="ground"');
    expect(html).toContain('id="lm-world-menu"');
    expect(html).not.toMatch(/<nav class="tabs"/);
    expect(html).not.toContain("cockpit-core-wrap");
  });

  it("keeps owner data paths and public preview flow", () => {
    expect(html).toContain("renderPublicNow");
    expect(html).toContain("homeFeedsReady");
    expect(html).toContain("openOwnerGate");
    expect(html).toContain("btn-unlock");
    expect(html).toContain("tryRestoreOwnerSession");
    expect(html).toContain("public_preview");
  });

  it("preserves system operations, polling, and ground interior routes", () => {
    expect(html).toContain("renderSystemSurface");
    expect(html).toContain("home-system-ops");
    expect(html).toContain("openJobBrief");
    expect(html).toContain("openTerminalBrief");
    expect(html).toContain("runPollCycle");
    expect(html).not.toContain('data-ground-surface="skills"');
    expect(html).not.toContain('data-ground-surface="now"');
    expect(html).not.toContain('id="lm-menu-btn"');
  });

  it("inline script passes validateBoardShellHtml", () => {
    expect(validateBoardShellHtml(html)).toEqual({ ok: true });
  });

  it("uses world-aware worker offline guard", () => {
    expect(html).toContain("boardShowsWorkerOffline");
    expect(html).toContain("__board_worker_offline_start__");
  });
});
