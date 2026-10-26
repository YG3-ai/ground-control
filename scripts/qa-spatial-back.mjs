#!/usr/bin/env node
/**
 * Local rendered QA for top-left persist back (390×844 + desktop).
 * Usage: BOARD_BASE_URL=http://127.0.0.1:8787 node scripts/qa-spatial-back.mjs
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const base = process.env.BOARD_BASE_URL || "http://127.0.0.1:8787";
const outDir =
  process.env.BOARD_SHOT_DIR ||
  join(process.cwd(), "logs", "board-screenshots");

function layerState(page) {
  return page.evaluate(() => ({
    world: !document.getElementById("lm-world-view")?.hidden,
    room: !document.getElementById("lm-room-view")?.hidden,
    surface: !document.getElementById("lm-surface")?.hidden,
    detail: !document.getElementById("lm-detail")?.hidden,
    backHidden: document.getElementById("lm-persist-back")?.hidden,
    backLabel: document.querySelector("#lm-persist-back .lm-back-label")?.textContent,
    markVis: document.getElementById("lm-mark")
      ? getComputedStyle(document.getElementById("lm-mark")).visibility
      : null,
  }));
}

async function backMetrics(page) {
  const box = await page.locator("#lm-persist-back").boundingBox();
  return {
    top: box?.y ?? null,
    height: box?.height ?? null,
    width: box?.width ?? null,
  };
}

async function runMobile(browser) {
  const { devices } = await import("playwright");
  const ctx = await browser.newContext({ ...devices["iPhone 13"] });
  const page = await ctx.newPage();
  const log = [];

  await page.goto(`${base}/board`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector("#lm-stage", { timeout: 15_000 });

  await page.click('[data-dest="ground"]');
  await page.waitForSelector("#lm-persist-back:not([hidden])");
  const roomMetrics = await backMetrics(page);
  log.push({ step: "ground-room", metrics: roomMetrics, state: await layerState(page) });

  await page.locator("#lm-persist-back").click();
  await page.waitForFunction(
    () => !document.getElementById("lm-world-view")?.hidden,
    { timeout: 5_000 },
  );
  const afterRoomBack = await layerState(page);
  log.push({
    step: "one-tap room→world",
    ok: afterRoomBack.world && !afterRoomBack.room && afterRoomBack.backHidden,
    state: afterRoomBack,
  });

  await page.click('[data-dest="ground"]');
  await page.evaluate(() => {
    const btn = document.querySelector('[data-action="mission"]');
    if (btn) btn.click();
  });
  await page.waitForSelector("#lm-surface:not([hidden])");
  log.push({ step: "ground-surface", state: await layerState(page) });

  await page.locator("#lm-persist-back").click();
  await page.waitForFunction(
    () =>
      document.getElementById("lm-surface")?.hidden &&
      !document.getElementById("lm-room-view")?.hidden,
    { timeout: 5_000 },
  );
  const afterSurfaceBack = await layerState(page);
  log.push({
    step: "one-tap surface→room",
    ok: afterSurfaceBack.room && afterSurfaceBack.surface === false,
    state: afterSurfaceBack,
  });

  await page.locator("#lm-persist-back").click();
  await page.waitForFunction(
    () => !document.getElementById("lm-world-view")?.hidden,
    { timeout: 5_000 },
  );
  const afterWorldBack = await layerState(page);
  log.push({
    step: "one-tap room→world (2)",
    ok: afterWorldBack.world && afterWorldBack.backHidden,
    state: afterWorldBack,
  });

  mkdirSync(outDir, { recursive: true });
  await page.screenshot({ path: join(outDir, "qa-back-mobile-world.png") });
  await ctx.close();
  return log;
}

async function runDesktop(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const log = [];

  await page.goto(`${base}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector("#lm-stage");
  await page.click('[data-dest="home"]');
  await page.waitForSelector("#lm-persist-back:not([hidden])");
  const metrics = await backMetrics(page);
  log.push({ step: "home-surface", metrics, state: await layerState(page) });

  await page.locator("#lm-persist-back").click();
  await page.waitForFunction(
    () => !document.getElementById("lm-world-view")?.hidden,
    { timeout: 5_000 },
  );
  const after = await layerState(page);
  log.push({
    step: "one-tap surface→world",
    ok: after.world && after.backHidden,
    state: after,
  });

  mkdirSync(outDir, { recursive: true });
  await page.screenshot({ path: join(outDir, "qa-back-desktop-world.png") });
  await page.close();
  return log;
}

async function main() {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const mobile = await runMobile(browser);
  const desktop = await runDesktop(browser);
  await browser.close();

  console.log(JSON.stringify({ base, mobile, desktop }, null, 2));
  const fails = [...mobile, ...desktop].filter((r) => r.ok === false);
  if (fails.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
