#!/usr/bin/env node
/**
 * Capture Life Mirror spatial flows at 390x844 + desktop home.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const base = process.env.BOARD_BASE_URL || "http://127.0.0.1:8787";
const boardKey = process.env.BOARD_KEY || "";
const outDir =
  process.env.BOARD_SHOT_DIR ||
  join(process.cwd(), "logs", "board-screenshots");

async function main() {
  const { chromium } = await import("playwright");
  mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  if (boardKey) {
    await mobile.addInitScript((key) => {
      try {
        localStorage.setItem("gc_board_key", key);
      } catch {
        /* ignore */
      }
    }, boardKey);
  }
  await mobile.goto(`${base}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await mobile.waitForSelector("#lm-stage", { timeout: 15_000 });
  const homePath = join(outDir, "spatial-home-390x844.png");
  await mobile.screenshot({ path: homePath });
  console.log(homePath);

  await mobile.click('[data-dest="ground"]');
  await mobile.waitForSelector('img[src*="ground-room"]', { timeout: 10_000 });
  const groundPath = join(outDir, "spatial-ground-room-390x844.png");
  await mobile.screenshot({ path: groundPath });
  console.log(groundPath);

  await mobile.click('[data-action="terminals"]');
  await mobile.waitForSelector("#lm-surface", { state: "visible", timeout: 15_000 });
  try {
    await mobile.waitForSelector("#home-system-ops", { timeout: 20_000 });
  } catch {
    console.warn("home-system-ops not visible (owner session or worker required)");
  }
  const systemPath = join(outDir, "spatial-system-terminal-390x844.png");
  await mobile.screenshot({ path: systemPath, fullPage: true });
  console.log(systemPath);
  await mobile.close();

  const desktop = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await desktop.goto(`${base}/board`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await desktop.waitForSelector("#lm-stage", { timeout: 15_000 });
  const deskPath = join(outDir, "spatial-desktop-1280.png");
  await desktop.screenshot({ path: deskPath });
  console.log(deskPath);
  await desktop.close();

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
