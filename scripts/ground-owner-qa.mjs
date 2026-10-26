#!/usr/bin/env node
/**
 * Owner QA against live Ground / Life Mirror (Playwright).
 * Usage: BOARD_VIEW_SECRET=... node scripts/ground-owner-qa.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const BASE = process.env.GROUND_QA_URL || "https://my.parthaunnava.com";
const KEY = process.env.BOARD_VIEW_SECRET?.trim();
if (!KEY) {
  console.error("BOARD_VIEW_SECRET required");
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", ".mission-backups", "93d73779-qa");
mkdirSync(outDir, { recursive: true });

const viewports = [
  { name: "mobile", width: 390, height: 844 },
  { name: "desktop", width: 1280, height: 800 },
];

const results = [];

async function runViewport(vp) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    extraHTTPHeaders: { "x-ground-board-key": KEY },
  });
  const page = await context.newPage();
  const log = [];

  await page.goto(`${BASE}/`, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForSelector("#app.on", { timeout: 30_000 });

  const bodyText = await page.locator("body").innerText();
  const offline = /Worker offline/i.test(bodyText);
  log.push({ check: "no_worker_offline_home", pass: !offline });

  for (const tab of ["world", "evolution", "missions", "notes"]) {
    const el = page.locator(`[data-tab="${tab}"]`);
    if (await el.count()) {
      await el.click();
      await page.waitForTimeout(800);
      const tabText = await page.locator("body").innerText();
      log.push({
        check: `tab_${tab}`,
        pass: !/Worker offline/i.test(tabText) || tab === "notes",
      });
    }
  }

  await page.locator('[data-tab="now"]').click();
  const details = page.locator("#home-system-details");
  if (await details.count()) {
    await details.click();
    log.push({ check: "history_disclosure", pass: true });
  }

  await page.screenshot({
    path: join(outDir, `${vp.name}-owner.png`),
    fullPage: true,
  });

  const pub = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
  });
  const pubPage = await pub.newPage();
  await pubPage.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await pubPage.waitForSelector("#app.on", { timeout: 30_000 });
  const pubText = await pubPage.locator("body").innerText();
  const leaked =
    /Second Brain Dossier/i.test(pubText) ||
    /owner-local/i.test(pubText) ||
    /\b93d73779\b/.test(pubText);
  log.push({ check: "anonymous_no_private_leak", pass: !leaked });
  await pubPage.screenshot({
    path: join(outDir, `${vp.name}-public.png`),
    fullPage: true,
  });
  await pub.close();

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("#app.on", { timeout: 30_000 });
  log.push({
    check: "session_restore",
    pass: (await page.locator("body").innerText()).includes("Unlock") === false,
  });

  const boardRes = await page.request.get(`${BASE}/api/board`, {
    headers: { "x-ground-board-key": KEY },
  });
  const boardJson = await boardRes.json();
  log.push({
    check: "owner_board_api",
    pass: boardRes.ok() && !boardJson.public_preview,
  });

  await browser.close();
  results.push({ viewport: vp.name, log });
}

for (const vp of viewports) {
  await runViewport(vp);
}

writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));
const failed = results.flatMap((r) =>
  r.log.filter((x) => !x.pass).map((x) => `${r.viewport}:${x.check}`),
);
console.log(JSON.stringify({ ok: failed.length === 0, failed, outDir }));
process.exit(failed.length ? 1 : 0);
