#!/usr/bin/env node
/** Public preview unlock QA — set BOARD_TEST_UNLOCK_PASSWORD in env (never commit). */
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const base = process.env.BOARD_BASE_URL || "https://my.parthaunnava.com";
const password = process.env.BOARD_TEST_UNLOCK_PASSWORD?.trim();
if (!password) {
  console.error("BOARD_TEST_UNLOCK_PASSWORD required for unlock QA");
  process.exit(1);
}

const outDir =
  process.env.BOARD_SHOT_DIR || join(dirname(fileURLToPath(import.meta.url)), "..", "logs", "board-screenshots");
mkdirSync(outDir, { recursive: true });

async function boardSnapshot(page) {
  return page.evaluate(async () => {
    const res = await fetch("/api/board", { credentials: "include" });
    const j = await res.json().catch(() => ({}));
    return {
      status: res.status,
      public_preview: j.public_preview === true,
      owner: j.public_preview !== true && res.ok,
      taskCount: Array.isArray(j.tasks) ? j.tasks.length : null,
    };
  });
}

async function probe(name, viewport) {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport });
  await ctx.clearCookies();
  const page = await ctx.newPage();
  await page.goto(`${base}/board`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#app.on", { timeout: 25_000 });
  await page.waitForTimeout(800);

  const locked = await boardSnapshot(page);
  await page.screenshot({ path: join(outDir, `qa-unlock-locked-${name}.png`) });

  await page.waitForSelector("#lm-unlock-btn", { state: "visible", timeout: 10_000 });
  await page.click("#lm-unlock-btn");
  await page.waitForSelector("#gate", { state: "visible" });

  await page.fill("#key", "definitely-wrong-password");
  await page.click("#go");
  await page.waitForTimeout(700);
  const wrongMsg = await page.locator("#gate-err").textContent();
  await page.screenshot({ path: join(outDir, `qa-unlock-wrong-${name}.png`) });

  await page.fill("#key", password);
  await page.click("#go");
  await page.waitForFunction(
    async () => {
      const res = await fetch("/api/board", { credentials: "include" });
      if (!res.ok) return false;
      const j = await res.json();
      return j.public_preview !== true;
    },
    { timeout: 20_000 },
  );
  await page.waitForSelector("#app.on", { timeout: 10_000 });
  await page.waitForTimeout(800);

  const unlocked = await boardSnapshot(page);
  await page.screenshot({ path: join(outDir, `qa-unlock-ok-${name}.png`) });

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#app.on", { timeout: 25_000 });
  await page.waitForTimeout(1000);
  const afterReload = await boardSnapshot(page);
  await page.screenshot({ path: join(outDir, `qa-unlock-reload-${name}.png`) });

  const anonRes = await fetch(`${base}/api/board`);
  const anonBody = await anonRes.json();
  const anon = { public_preview: anonBody.public_preview === true };

  const ownerRoute = await page.evaluate(async () => {
    const res = await fetch("/api/board/evolution/summary", { credentials: "include" });
    return res.status;
  });

  const build = await page.evaluate(() =>
    document.querySelector('meta[name="ground-board-build"]')?.getAttribute("content"),
  );
  await browser.close();

  const reloadOwner =
    afterReload.owner || (afterReload.status === 503 && ownerRoute !== 401);
  const ok =
    locked.public_preview &&
    !locked.owner &&
    /incorrect|password/i.test(wrongMsg || "") &&
    unlocked.owner &&
    reloadOwner &&
    anon.public_preview &&
    ownerRoute !== 401;
  return {
    name,
    build,
    locked,
    wrongMsg: (wrongMsg || "").trim(),
    unlocked,
    afterReload,
    anon,
    ownerRoute,
    ok,
  };
}

const mobile = await probe("390x844", { width: 390, height: 844 });
const desktop = await probe("1280", { width: 1280, height: 900 });
console.log(JSON.stringify({ mobile, desktop }, null, 2));
process.exit(mobile.ok && desktop.ok ? 0 : 1);
