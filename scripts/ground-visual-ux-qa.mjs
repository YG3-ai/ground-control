#!/usr/bin/env node
/**
 * Visual + interaction QA for mission 93d73779 (Playwright, no image reads).
 * Usage: BOARD_VIEW_SECRET=... node scripts/ground-visual-ux-qa.mjs
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
const outDir = join(here, "..", ".mission-backups", "93d73779-visual-ux");
mkdirSync(outDir, { recursive: true });

const viewports = [
  { tag: "mobile", width: 390, height: 844 },
  { tag: "desktop", width: 1280, height: 800 },
];

const findings = [];
const checks = [];

function record(vp, name, pass, detail) {
  checks.push({ viewport: vp, name, pass, detail });
  if (!pass) findings.push(`${vp}:${name} — ${detail}`);
}

async function ownerFlow(browser, vp) {
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
  });
  const page = await context.newPage();
  const tag = vp.tag;

  const unlockUrl = `${BASE}/?k=${encodeURIComponent(KEY)}`;
  const res = await page.goto(unlockUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
  const buildMeta = await page
    .locator('meta[name="ground-board-build"]')
    .getAttribute("content")
    .catch(() => null);
  const uiHeader = res?.headers()?.["x-ground-ui-version"] ?? null;
  record(tag, "build_meta", Boolean(buildMeta), `meta=${buildMeta} header=${uiHeader}`);

  await page.waitForSelector("#app.on", { timeout: 45_000 });
  await page.waitForSelector(".sys-pulse", { timeout: 45_000 }).catch(() => null);

  const body0 = await page.locator("body").innerText();
  record(tag, "owner_unlocked", !/Preview/i.test(body0) || /System (ready|active)/i.test(body0), "owner HUD");
  record(tag, "no_subconscious", !/subconscious/i.test(body0), "no Subconscious copy");
  record(tag, "no_worker_offline", !/Worker offline/i.test(body0), body0.slice(0, 120));

  const hasPulse = (await page.locator(".sys-pulse").count()) > 0;
  record(tag, "system_pulse_surface", hasPulse, `sys-pulse=${await page.locator(".sys-pulse").count()}`);

  await page.screenshot({
    path: join(outDir, `${tag}-home-hud.png`),
    fullPage: false,
  });

  const pulseBtn = page.locator(".sys-pulse").first();
  if (await pulseBtn.count()) {
    await pulseBtn.click();
    await page.waitForTimeout(700);
    const ops = page.locator("#home-system-ops");
    const internalsOpen = await page.locator("#home-system-details[open]").count();
    record(
      tag,
      "system_pulse_drilldown",
      internalsOpen > 0 && (await ops.count()) > 0,
      `open=${internalsOpen} ops=${await ops.count()}`,
    );
    await page.screenshot({
      path: join(outDir, `${tag}-home-viewport.png`),
      fullPage: false,
    });
  } else {
    record(tag, "system_pulse_drilldown", false, "missing .sys-pulse");
  }

  await page.locator('[data-tab="now"]').click();
  await page.waitForTimeout(300);

  await page.locator('[data-tab="world"]').click();
  await page.waitForTimeout(900);
  const worldText = await page.locator("body").innerText();
  record(
    tag,
    "world_grid",
    (await page.locator(".world-grid").count()) > 0,
    `grids=${await page.locator(".world-grid").count()}`,
  );
  await page.screenshot({
    path: join(outDir, `${tag}-world-grid.png`),
    fullPage: false,
  });

  await page.locator('[data-tab="evolution"]').click();
  await page.waitForTimeout(1200);
  const evoDot = page.locator("#badge-evolution.nav-review-dot");
  if (await evoDot.count()) {
    const aria = await evoDot.getAttribute("aria-label");
    const txt = await evoDot.innerText();
    record(
      tag,
      "evolution_nav_dot",
      aria === "Evolution has new proposals" && txt.trim() === "",
      `aria=${aria} text=${JSON.stringify(txt)}`,
    );
  } else {
    record(tag, "evolution_nav_dot", true, "no proposed badge (skipped)");
  }

  const multiGroup = page.locator(".evo-group").filter({ has: page.locator(".count") }).first();
  if (await multiGroup.count()) {
    await multiGroup.click();
    await page.waitForTimeout(500);
    const sheetText = await page.locator("#sheet, .sheet").first().innerText().catch(() => "");
    record(
      tag,
      "evo_group_no_accept_dismiss",
      !/Accept/i.test(sheetText) && !/Dismiss/i.test(sheetText),
      "group sheet actions",
    );
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  } else {
    const singleGroup = page.locator(".evo-group").first();
    if (await singleGroup.count()) {
      await singleGroup.click();
      await page.waitForTimeout(700);
      const sheetText = await page.locator("body").innerText();
      record(
        tag,
        "evo_detail_reachable",
        /Evidence|Evolution|Capability/i.test(sheetText),
        "opened evolution detail",
      );
      await page.keyboard.press("Escape");
    }
  }
  await page.screenshot({
    path: join(outDir, `${tag}-evolution.png`),
    fullPage: false,
  });

  await page.locator('[data-tab="missions"]').click();
  await page.waitForTimeout(800);
  await page.screenshot({
    path: join(outDir, `${tag}-missions.png`),
    fullPage: false,
  });

  await page.locator('[data-tab="notes"]').click();
  await page.waitForTimeout(800);
  const brainText = await page.locator("body").innerText();
  record(
    tag,
    "brain_tab",
    /New note|Write a note|Unlock to search/i.test(brainText),
    "brain composer or public placeholder",
  );

  const boardRes = await page.goto(`${BASE}/board`, {
    waitUntil: "domcontentloaded",
    timeout: 90_000,
  });
  await page.waitForSelector("#app.on", { timeout: 45_000 });
  record(tag, "board_route", boardRes?.ok() !== false, "/board loads");

  if (tag === "desktop") {
    await page.screenshot({
      path: join(outDir, `${tag}-owner-home.png`),
      fullPage: true,
    });
  }

  await context.close();
  return { buildMeta, uiHeader };
}

async function publicFlow(browser, vp) {
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
  });
  const page = await context.newPage();
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForSelector("#app.on", { timeout: 45_000 });
  const pubText = await page.locator("body").innerText();
  const leaked =
    /Second Brain Dossier/i.test(pubText) ||
    /owner-local/i.test(pubText) ||
    /\b93d73779\b/.test(pubText);
  record(vp.tag, "public_privacy", !leaked, leaked ? "private leak" : "ok");
  await page.screenshot({
    path: join(outDir, `${vp.tag}-public.png`),
    fullPage: vp.tag === "desktop",
  });
  await context.close();
}

const browser = await chromium.launch({ headless: true });
let buildId = null;
for (const vp of viewports) {
  const meta = await ownerFlow(browser, vp);
  buildId = meta.buildMeta || buildId;
  await publicFlow(browser, vp);
}
await browser.close();

const failed = checks.filter((c) => !c.pass);
const report = {
  at: new Date().toISOString(),
  base: BASE,
  buildId,
  ok: failed.length === 0,
  failed: failed.map((c) => `${c.viewport}:${c.name}`),
  checks,
  findings,
  outDir,
};
writeFileSync(join(outDir, "qa-results.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ok: report.ok, buildId, failed: report.failed, outDir }));
process.exit(report.ok ? 0 : 1);
