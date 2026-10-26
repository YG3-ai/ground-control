#!/usr/bin/env node
/**
 * Capture all five in-world destination interiors at 390x844 + desktop.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const base = process.env.BOARD_BASE_URL || "http://127.0.0.1:8787";
const boardKey = process.env.BOARD_KEY || "";
const outDir =
  process.env.BOARD_SHOT_DIR ||
  join(process.cwd(), "logs", "board-screenshots");

const DESTINATIONS = [
  { menu: "missions", slug: "workbench" },
  { menu: "capabilities", slug: "armory" },
  { menu: "codex", slug: "codex" },
  { menu: "evolution", slug: "archive" },
  { menu: "system", slug: "control" },
];

async function openOwner(page) {
  if (boardKey) {
    await page.addInitScript((key) => {
      try {
        localStorage.setItem("gc_board_key", key);
      } catch {
        /* ignore */
      }
    }, boardKey);
  }
  await page.goto(`${base}/board`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector("#lm-stage", { timeout: 15_000 });
}

async function shotInterior(page, vpName, menu, slug) {
  await page.click("#lm-menu-btn");
  const item = page.locator(`[data-menu="${menu}"]`);
  if (await item.isHidden()) {
    console.warn(`skip interior-${slug}-${vpName} (${menu} requires owner)`);
    await page.click("#lm-menu-close");
    return;
  }
  await item.click();
  await page.waitForSelector(`#lm-interior[data-interior='${slug}']`, {
    state: "visible",
    timeout: 15_000,
  });
  await page.waitForTimeout(800);
  const path = join(outDir, `interior-${slug}-${vpName}.png`);
  await page.screenshot({ path, fullPage: true });
  console.log(path);
  await page.click("#lm-persist-back");
  await page.waitForSelector("#lm-surface", { state: "hidden", timeout: 10_000 });
}

async function main() {
  const { chromium } = await import("playwright");
  mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });

  for (const vp of [
    { name: "390x844", width: 390, height: 844 },
    { name: "desktop-1280", width: 1280, height: 900 },
  ]) {
    const page = await browser.newPage({
      viewport: { width: vp.width, height: vp.height },
    });
    await openOwner(page);
    for (const d of DESTINATIONS) {
      await shotInterior(page, vp.name, d.menu, d.slug);
    }
    await page.close();
  }

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
