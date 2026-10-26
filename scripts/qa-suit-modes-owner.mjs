#!/usr/bin/env node
/** Owner-authenticated YG3 / GROUND / ARCHIVE suit HUD probe (requires BOARD_VIEW_SECRET). */
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const base = process.env.BOARD_BASE_URL || "https://my.parthaunnava.com";
const key = process.env.BOARD_VIEW_SECRET?.trim();
if (!key) {
  console.error("BOARD_VIEW_SECRET required");
  process.exit(1);
}

const outDir =
  process.env.BOARD_SHOT_DIR || join(dirname(fileURLToPath(import.meta.url)), "..", "logs", "board-screenshots");
mkdirSync(outDir, { recursive: true });

const DESTS = ["yg3", "ground", "archive"];

async function selectDest(page, dest) {
  await page.evaluate((d) => {
    document.querySelector(`#lm-mode-rail .lm-world-item[data-dest="${d}"]`)?.click();
  }, dest);
  await page.waitForFunction(
    (d) =>
      document.querySelector("#lm-mode-rail .lm-world-item.is-selected")?.getAttribute("data-dest") === d,
    dest,
    { timeout: 8000 },
  );
  await page.waitForTimeout(dest === "yg3" ? 4000 : 1400);
}

async function probeViewport(name, viewport) {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport,
    extraHTTPHeaders: { "x-ground-board-key": key },
  });
  const page = await ctx.newPage();
  await page.goto(`${base}/board`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#lm-suit-hud-plane.on", { timeout: 25_000 });

  const build = await page.evaluate(() =>
    document.querySelector('meta[name="ground-board-build"]')?.getAttribute("content"),
  );

  const modes = {};
  for (const dest of DESTS) {
    await selectDest(page, dest);
    modes[dest] = await page.evaluate((d) => {
      const callouts = document.querySelectorAll(".lm-world-callout").length;
      const hudId =
        d === "yg3" ? "lm-mode-yg3-hud" : d === "ground" ? "lm-mode-ground-hud" : "lm-mode-archive-hud";
      const hud = document.getElementById(hudId);
      const title = hud?.querySelector(".lm-mode-title")?.textContent?.trim();
      const yg3Metrics = [...document.querySelectorAll("#lm-mode-yg3-signals .lm-yg3-metric")].map((el) => ({
        label: el.querySelector(".lm-yg3-metric-lbl")?.textContent?.trim(),
        value: el.querySelector(".lm-yg3-metric-val")?.textContent?.trim(),
        unit: el.querySelector(".lm-yg3-metric-unit")?.textContent?.trim(),
      }));
      const yg3Loading = document.getElementById("lm-mode-yg3-loading")?.textContent?.trim() || "";
      const groundSections = [...document.querySelectorAll("#lm-mode-ground-sections [data-section]")].map(
        (el) => ({
          id: el.getAttribute("data-section"),
          label: el.querySelector(".lm-mode-section-label")?.textContent?.trim(),
          collapsible: el.tagName === "DETAILS",
          open: el.tagName === "DETAILS" ? el.open : null,
          missionTitles: el.querySelectorAll(".lm-ground-mission-title").length,
          rows: el.querySelectorAll(".lm-mode-row").length,
        }),
      );
      const groundStatsHidden = document.getElementById("lm-mode-ground-stats")?.hidden !== false;
      const archiveRows = document.querySelectorAll("#lm-mode-archive-rows .lm-mode-row").length;
      const searchField = !!document.querySelector(".lm-archive-search-field");
      const searchDisabled = document.getElementById("lm-archive-search-input")?.disabled;
      const standby = (hud?.textContent || "").match(/STANDBY/i);
      const sessionPrimaries =
        d === "ground"
          ? [...document.querySelectorAll('[data-section="terminals"] .lm-ground-detail-title')].map((el) =>
              el.textContent?.trim(),
            )
          : [];
      const groundQueueFirst =
        d === "ground"
          ? groundSections[0]?.id === "queue" && groundSections[0]?.missionTitles >= 0
          : true;
      return {
        callouts,
        title,
        yg3Metrics,
        yg3Loading,
        groundSections,
        groundStatsHidden,
        groundQueueFirst,
        archiveRows,
        searchField,
        searchDisabled: !!searchDisabled,
        standby: !!standby,
        sessionPrimaries,
      };
    }, dest);
    if (dest === "archive") {
      await page.evaluate(() => {
        const input = document.getElementById("lm-archive-search-input");
        if (!input) return;
        input.value = "YG3";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await page.waitForTimeout(400);
      await page.waitForResponse(
        (res) =>
          res.url().includes("/api/board/extensions/notes/search") &&
          res.request().method() === "GET" &&
          res.status() === 200,
        { timeout: 12_000 },
      ).catch(() => null);
      await page.waitForTimeout(350);
      modes[dest].searchProbe = await page.evaluate(() => {
        const rows = [...document.querySelectorAll("#lm-mode-archive-rows .lm-mode-row")];
        const slugs = rows.map((r) => r.getAttribute("data-slug") || "");
        const dupes = slugs.filter((s, i) => s && slugs.indexOf(s) !== i).length;
        return {
          rowCount: rows.length,
          stacked: rows.filter((r) => r.classList.contains("lm-archive-result")).length,
          dupes,
        };
      });
      await page.screenshot({
        path: join(outDir, `qa-suit-modes-owner-archive-search-${name}.png`),
      });
      await page.fill("#lm-archive-search-input", "");
      await page.waitForTimeout(400);
    }
    await page.screenshot({ path: join(outDir, `qa-suit-modes-owner-${dest}-${name}.png`) });
  }

  await browser.close();
  const yg3Ready =
    modes.yg3.yg3Metrics.length > 0 ||
    (modes.yg3.yg3Loading === "LOADING" && modes.yg3.yg3Metrics.length === 0);
  const ok =
    DESTS.every((d) => modes[d].callouts === 0 && !modes[d].standby) &&
    modes.yg3.title === "BUSINESS" &&
    yg3Ready &&
    modes.ground.title === "WORK" &&
    modes.ground.groundSections.length >= 1 &&
    modes.ground.groundQueueFirst &&
    modes.ground.groundStatsHidden &&
    modes.ground.groundSections.some((s) => s.label === "PROJECT QUEUE") &&
    modes.ground.groundSections.some((s) => s.id === "jobs" && s.collapsible) &&
    modes.ground.groundSections.some((s) => s.id === "terminals" && s.collapsible) &&
    modes.archive.title === "RETRIEVAL" &&
    modes.archive.searchField &&
    modes.archive.searchDisabled === false &&
    (modes.archive.searchProbe?.dupes ?? 0) === 0 &&
    !modes.ground.sessionPrimaries.some((p) => /Session cwd is/i.test(p || ""));
  return { name, build, modes, ok };
}

const mobile = await probeViewport("390x844", { width: 390, height: 844 });
const desktop = await probeViewport("1280", { width: 1280, height: 900 });
console.log(JSON.stringify({ mobile, desktop }, null, 2));
process.exit(mobile.ok && desktop.ok ? 0 : 1);
