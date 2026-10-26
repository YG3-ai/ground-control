import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  LIFE_MIRROR_ASSET_BASE,
  INTERIOR_FOR_TAB,
  MENU_SURFACE_TABS,
  SPATIAL_DESTINATIONS,
  destinationEnterable,
  destinationLabel,
  exceptionalAlertCount,
  interiorBayTitle,
  interiorKindForTab,
  nextDestination,
  prevDestination,
  roomImageAsset,
  shellSurfaceTab,
  worldPreviewThumb,
  WORLD_DESTINATION_BEACONS,
} from "./board-spatial-nav.js";

describe("board-spatial-nav", () => {
  it("cycles destinations in fixed order", () => {
    expect(nextDestination("home")).toBe("yg3");
    expect(nextDestination("archive")).toBe("home");
    expect(prevDestination("home")).toBe("archive");
  });

  it("maps shell rooms to real surfaces", () => {
    expect(shellSurfaceTab("yg3")).toBe("growth");
    expect(shellSurfaceTab("archive")).toBe("missions");
    expect(roomImageAsset("ground")).toBe(
      `${LIFE_MIRROR_ASSET_BASE}ground-room.webp`,
    );
    expect(roomImageAsset("home")).toBeNull();
  });

  it("derives portal thumbs from existing world art", () => {
    expect(worldPreviewThumb("ground").src).toContain("ground-room.webp");
    expect(worldPreviewThumb("yg3").objectPosition).toBe("80% 28%");
  });

  it("treats HOME as non-enterable HUD mode", () => {
    expect(destinationEnterable("home")).toBe(false);
    expect(destinationEnterable("ground")).toBe(true);
  });

  it("maps menu entries to existing tabs", () => {
    expect(MENU_SURFACE_TABS.codex).toBe("world");
    expect(MENU_SURFACE_TABS.system).toBe("now");
    expect(MENU_SURFACE_TABS.capabilities).toBe("skills");
  });

  it("maps tabs to cinematic interior bays", () => {
    expect(interiorKindForTab("missions")).toBe("workbench");
    expect(interiorKindForTab("skills")).toBe("armory");
    expect(interiorKindForTab("world")).toBe("codex");
    expect(interiorKindForTab("now")).toBe("control");
    expect(interiorBayTitle("workbench")).toBe("Workbench");
    expect(INTERIOR_FOR_TAB.evolution).toBe("archive");
  });

  it("counts only real approval/decision queues for alerts", () => {
    expect(exceptionalAlertCount([], [])).toBe(0);
    expect(exceptionalAlertCount([{}], [{}])).toBe(2);
  });

  it("anchors world beacons for each destination", () => {
    expect(WORLD_DESTINATION_BEACONS.home.nx).toBeGreaterThan(0);
    expect(WORLD_DESTINATION_BEACONS.ground.ny).toBeGreaterThan(0);
  });

  it("labels destinations for hotspot chrome", () => {
    for (const d of SPATIAL_DESTINATIONS) {
      expect(destinationLabel(d)).toMatch(/^[A-Z0-9]+$/);
    }
  });
});

describe("life-mirror production assets", () => {
  const base = join(import.meta.dirname, "assets", "life-mirror");

  it("ships verified portrait renders", () => {
    const world = readFileSync(join(base, "world.webp"));
    const ground = readFileSync(join(base, "ground-room.webp"));
    expect(world.length).toBe(58534);
    expect(ground.length).toBe(67122);
    expect(createHash("sha256").update(world).digest("hex")).toBe(
      "ce87712eba8139536caa30605ed9b1a495497a64469ebcdde0efa5d7abd16270",
    );
    expect(createHash("sha256").update(ground).digest("hex")).toBe(
      "0d93776bdd58fc7dfa108e261e7610fd9013ff25af222142556dd251c1e61ad7",
    );
  });
});

describe("board.html spatial shell markers", () => {
  const html = readFileSync(join(import.meta.dirname, "board.html"), "utf8");

  it("uses cinematic spatial navigation without bottom tab bar", () => {
    expect(html).toContain("/* __spatial_nav_start__ */");
    expect(html).toContain("lm-stage");
    expect(html).not.toContain('id="lm-menu-btn"');
    expect(html).not.toContain('data-ground-surface="skills"');
    expect(html).toContain("lm-ground-history-feed");
    expect(html).toContain(LIFE_MIRROR_ASSET_BASE + "world.webp");
    expect(html).toContain('id="lm-world-menu"');
    expect(html).toContain("lm-world-item");
    expect(html).toContain("lm-mode-rail");
    expect(html).not.toContain('class="lm-hotspot" data-dest');
    expect(html).toContain("world-live.mp4");
    expect(html).not.toContain('id="conn-label"');
    expect(html).not.toMatch(/<nav class="tabs"[^>]*>/);
    expect(html).not.toContain("cockpit-core-wrap");
    expect(html).not.toContain("nav class=\"tabs\"");
  });

  it("preserves jobs/terminal system surface and polling", () => {
    expect(html).toContain("home-system-ops");
    expect(html).toContain("openJobBrief");
    expect(html).toContain("openTerminalBrief");
    expect(html).toContain("runPollCycle");
    expect(html).toContain("renderSystemSurface");
  });

  it("uses reusable cinematic interior shell markers", () => {
    expect(html).toContain('id="lm-interior"');
    expect(html).toContain("lm-interior-focal");
    expect(html).toContain("lm-locked-console");
    expect(html).toContain("applyInteriorTheme");
    expect(html).toContain("showInteriorLocked");
  });

  it("uses in-world detail navigation shell", () => {
    expect(html).toContain('id="lm-persist-back"');
    expect(html).toContain('id="lm-detail"');
    expect(html).toContain("spatialBackOne");
    expect(html).not.toContain('id="lm-surface-back"');
    expect(html).not.toContain("ctrl-mod-h\">Navigate");
  });
});
