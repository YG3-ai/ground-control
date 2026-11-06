import { describe, expect, it } from "vitest";
import {
  applyBoardIconLinks,
  buildWebManifest,
  resolveIconSet,
} from "./icon-set.js";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const RELAY_SRC = dirname(fileURLToPath(import.meta.url));

describe("icon-set", () => {
  it("resolves generated icon set from src", () => {
    const set = resolveIconSet(RELAY_SRC);
    expect(set).not.toBeNull();
    expect(set!.version).toMatch(/^[a-f0-9]{12}$/);
  });

  it("injects version into board placeholders", () => {
    const html =
      '<link rel="icon" href="/icons/__GROUND_ICON_SET__/favicon.ico" />';
    const out = applyBoardIconLinks(html, "abc123def456");
    expect(out).toContain("/icons/abc123def456/favicon.ico");
    expect(out).not.toContain("__GROUND_ICON_SET__");
  });

  it("builds manifest with versioned icon paths", () => {
    const raw = buildWebManifest("deadbeefcafe");
    const m = JSON.parse(raw) as { icons: { src: string; purpose: string }[] };
    expect(m.icons.some((i) => i.src.includes("deadbeefcafe/icon-192.png"))).toBe(
      true,
    );
    expect(m.icons.some((i) => i.purpose === "maskable")).toBe(true);
  });
});
