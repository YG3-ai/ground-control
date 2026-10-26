#!/usr/bin/env node
/**
 * Capture live Ground board at 390x844 and desktop. Requires playwright:
 *   npx playwright install chromium
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const base = process.env.BOARD_BASE_URL || "http://127.0.0.1:8787";
const outDir = process.env.BOARD_SHOT_DIR || join(repoRoot, "docs", "assets");

async function main() {
  const { chromium } = await import("playwright");
  mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const viewports = [
    { name: "mobile-390x844", width: 390, height: 844 },
    { name: "desktop-1280", width: 1280, height: 900 },
  ];
  for (const vp of viewports) {
    const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
    await page.goto(`${base}/board`, { waitUntil: "networkidle", timeout: 60_000 });
    await page.waitForSelector("#lm-public-hero, #lm-cognitive-hud", { timeout: 30_000 });
    await page.waitForFunction(
      () => document.getElementById("lm-public-hero")?.hidden === false ||
        document.getElementById("lm-cognitive-hud")?.classList.contains("on"),
      { timeout: 30_000 },
    );
    await page.waitForTimeout(800);
    const path = join(outDir, `ground-control-public-${vp.name}.png`);
    await page.screenshot({ path, fullPage: true });
    console.log(path);
    await page.close();
  }
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
