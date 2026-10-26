#!/usr/bin/env node
/**
 * Local rendered QA: World bottom selector + top-left back (mobile + desktop).
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const base = process.env.BOARD_BASE_URL || "http://127.0.0.1:8787";
const outDir =
  process.env.BOARD_SHOT_DIR || join(repoRoot, "logs", "board-screenshots");

async function enterWorldDestination(page, dest) {
  await page.evaluate((d) => {
    const sc = document.getElementById("lm-world-selector-scroll");
    const chip = sc?.querySelector('.lm-world-item[data-dest="' + d + '"]');
    if (!sc || !chip) return;
    sc.scrollLeft = chip.offsetLeft - (sc.clientWidth - chip.offsetWidth) / 2;
    chip.click();
    if (chip.getAttribute("aria-selected") !== "true") chip.click();
    chip.click();
  }, dest);
}

async function menuMetrics(page) {
  return page.evaluate(() => {
    const scroll = document.getElementById("lm-world-selector-scroll");
    const items = [...document.querySelectorAll(".lm-world-item")];
    const selected = document.querySelector(".lm-world-item.is-selected");
    const cs = selected ? getComputedStyle(selected) : null;
    const menu = document.getElementById("lm-world-menu");
    const menuBox = menu?.getBoundingClientRect();
    const poster = document.getElementById("lm-world-poster");
    const posterCs = poster ? getComputedStyle(poster) : null;
    return {
      count: items.length,
      selectedDest: selected?.getAttribute("data-dest") ?? null,
      bottomInset: menuBox ? window.innerHeight - menuBox.bottom : null,
      chipHeight: selected?.offsetHeight ?? null,
      labels: items.map((b) => b.querySelector(".lm-world-chip-label")?.textContent?.trim()),
      hasScatteredHotspot: !!document.querySelector("#lm-world-view .lm-hotspot"),
      poster: !!poster,
      video: !!document.getElementById("lm-world-live"),
      menuBtn: !!document.getElementById("lm-menu-btn"),
      objectPosition: posterCs?.objectPosition ?? null,
      menuItemBackground: cs?.backgroundColor ?? null,
      menuBackdropFilter: cs ? cs.backdropFilter || cs.webkitBackdropFilter : null,
      scrollSnap: scroll ? getComputedStyle(scroll).scrollSnapType : null,
    };
  });
}

async function runViewport(browser, name, viewport) {
  const page = await browser.newPage({ viewport });
  const log = [];
  await page.goto(`${base}/board`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector("#lm-world-menu", { timeout: 15_000 });
  const menu = await menuMetrics(page);
  log.push({ step: "world-menu", menu });
  mkdirSync(outDir, { recursive: true });
  await page.screenshot({ path: join(outDir, `qa-world-menu-${name}.png`) });

  await enterWorldDestination(page, "ground");
  await page.waitForSelector("#lm-persist-back:not([hidden])");
  const backBox = await page.locator("#lm-persist-back").boundingBox();
  log.push({
    step: "one-tap-back-to-world",
    backTop: backBox?.y,
    backH: backBox?.height,
  });
  await page.locator("#lm-persist-back").click();
  await page.waitForFunction(() => !document.getElementById("lm-world-view")?.hidden);
  const after = await page.evaluate(() => ({
    world: !document.getElementById("lm-world-view")?.hidden,
    room: !document.getElementById("lm-room-view")?.hidden,
    backHidden: document.getElementById("lm-persist-back")?.hidden,
  }));
  log.push({
    step: "room→world",
    ok: after.world && !after.room && after.backHidden,
    after,
  });
  await page.close();
  return log;
}

async function main() {
  const { chromium, devices } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const mobile = await runViewport(browser, "390x844", devices["iPhone 13"].viewport);
  const desktop = await runViewport(browser, "1280", { width: 1280, height: 900 });
  await browser.close();
  let liveBuild = null;
  try {
    const res = await fetch(`${base}/board`);
    const html = await res.text();
    const m = html.match(/name="ground-board-build"\s+content="([^"]+)"/);
    liveBuild = m?.[1] ?? null;
  } catch {
    liveBuild = null;
  }
  const report = { base, liveBuild, mobile, desktop };
  console.log(JSON.stringify(report, null, 2));
  const bad = [];
  for (const block of [mobile, desktop]) {
    const m = block.find((x) => x.step === "world-menu")?.menu;
    const back = block.find((x) => x.step === "room→world");
    if (!m || m.count !== 4 || m.hasScatteredHotspot) bad.push("menu-structure");
    if (m && (m.chipHeight < 46 || m.chipHeight > 64)) bad.push("menu-touch-type");
    if (m && m.bottomInset > 48) bad.push("menu-bottom");
    if (m && !m.scrollSnap?.includes("mandatory")) bad.push("scroll-snap");
    if (!back?.ok) bad.push("back-one-tap");
  }
  if (bad.length) {
    console.error("FAILED:", bad.join(", "));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
