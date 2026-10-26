#!/usr/bin/env node
/** Owner-authenticated HOME HUD probe (requires BOARD_VIEW_SECRET). */
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

async function probeViewport(name, viewport) {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport,
    extraHTTPHeaders: { "x-ground-board-key": key },
  });
  const page = await ctx.newPage();
  await page.goto(`${base}/board`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#lm-suit-hud-plane.on", { timeout: 20_000 });
  await page.evaluate(() => {
    document.querySelector('#lm-mode-rail .lm-world-item[data-dest="home"]')?.click();
  });
  await page.waitForTimeout(1500);
  const board = await page.request.get(`${base}/api/board`, {
    headers: { "x-ground-board-key": key },
  });
  const boardJson = await board.json();
  const hud = await page.evaluate(() => {
    const sigs = [...document.querySelectorAll("#lm-home-instruments .lm-home-sig")].map((el) => ({
      id: el.getAttribute("data-sig"),
      label: el.querySelector(".lm-home-sig-lbl")?.textContent?.trim(),
      value: el.querySelector(".lm-home-sig-val")?.textContent?.trim(),
      unit: el.querySelector(".lm-home-sig-unit")?.textContent?.trim(),
    }));
    const veil = document.getElementById("lm-home-background-veil");
    const veilOpacity = veil ? parseFloat(getComputedStyle(veil).opacity) : 0;
    return {
      projectLabel: document.getElementById("lm-cognitive-readout-name")?.textContent?.trim(),
      projectTitle: document.getElementById("lm-cognitive-readout-state")?.textContent?.trim(),
      conn: document.getElementById("lm-home-readout-cluster")?.getAttribute("data-conn"),
      homeVeilOpacity: veilOpacity,
      worldHomeOn: document.getElementById("lm-world-view")?.classList.contains("lm-world-home-on"),
      sigs,
      instrumentText: document.getElementById("lm-home-instruments")?.textContent || "",
    };
  });
  const build = await page.evaluate(() =>
    document.querySelector('meta[name="ground-board-build"]')?.getAttribute("content"),
  );
  await page.screenshot({ path: join(outDir, `qa-home-hud-owner-${name}.png`) });
  await browser.close();
  const activeJobs = (boardJson.tasks || []).filter((t) =>
    ["queued", "preparing", "running", "awaiting_followup", "cancelling"].includes(
      String(t.status || ""),
    ),
  ).length;
  const statusTitle = activeJobs > 0 ? "WORKING" : "READY";
  const primaryOk =
    hud.projectLabel === "STATUS" && hud.projectTitle === statusTitle;
  const veilOk =
    hud.worldHomeOn === true &&
    hud.homeVeilOpacity >= 0.14 &&
    hud.homeVeilOpacity <= 0.16;
  const ok =
    boardJson.public_preview !== true &&
    primaryOk &&
    veilOk &&
    !/\bLINK\b/.test(hud.instrumentText);
  return { name, build, boardHydrated: !boardJson.public_preview, tasks: (boardJson.tasks || []).length, sessions: (boardJson.terminal_sessions || []).length, hud, ok };
}

const mobile = await probeViewport("390x844", { width: 390, height: 844 });
const desktop = await probeViewport("1280", { width: 1280, height: 900 });
console.log(JSON.stringify({ mobile, desktop }, null, 2));
process.exit(mobile.ok && desktop.ok ? 0 : 1);
