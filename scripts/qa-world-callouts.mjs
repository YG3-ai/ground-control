#!/usr/bin/env node
/** Callout anchor stability + per-destination screenshots. */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const base = process.env.BOARD_BASE_URL || "http://127.0.0.1:8787";
const outDir =
  process.env.BOARD_SHOT_DIR || join(repoRoot, "logs", "board-screenshots");

async function selectChip(page, dest) {
  const cur = await page.evaluate(
    () =>
      document.querySelector("#lm-world-view .lm-world-item.is-selected")?.getAttribute("data-dest") ||
      "home",
  );
  if (cur === dest) {
    await page.waitForTimeout(280);
    return;
  }
  await page.evaluate((d) => {
    document.querySelector(`#lm-world-view .lm-world-item[data-dest="${d}"]`)?.click();
  }, dest);
  await page.waitForFunction(
    (d) =>
      document.querySelector("#lm-world-view .lm-world-item.is-selected")?.getAttribute("data-dest") ===
      d,
    dest,
    { timeout: 5000 },
  );
  await page.waitForTimeout(280);
}

async function calloutBox(page) {
  return page.evaluate(() => {
    const el = document.querySelector(".lm-world-callout.on");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      left: r.left,
      top: r.top,
      dest: el.getAttribute("data-dest"),
      styleLeft: el.style.left,
      styleTop: el.style.top,
    };
  });
}

async function prepareCalloutSurface(page, name) {
  await page.waitForFunction(() => {
    const c = document.querySelector(".lm-world-media");
    return c && c.clientWidth > 0 && c.clientHeight > 0;
  });
  if (name === "1280") {
    await page.evaluate(() => {
      const v = document.getElementById("lm-world-live");
      if (v) {
        v.classList.add("lm-world-live-on");
        v.setAttribute("data-src-ready", "1");
      }
      window.dispatchEvent(new Event("resize"));
    });
    await page.waitForTimeout(150);
  }
}

async function runViewport(browser, name, viewport, touch) {
  const ctx = await browser.newContext({ viewport, hasTouch: !!touch, isMobile: !!touch });
  const page = await ctx.newPage();
  await page.goto(`${base}/board`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#lm-world-callouts", { state: "visible" });
  await prepareCalloutSurface(page, name);
  mkdirSync(outDir, { recursive: true });
  const dests = ["home", "yg3", "ground", "archive"];
  const positions = {};
  for (const dest of dests) {
    await selectChip(page, dest);
    const b0 = await calloutBox(page);
    await page.waitForTimeout(120);
    const b1 = await calloutBox(page);
    const stable =
      b0 &&
      b1 &&
      Math.abs(b0.left - b1.left) < 2 &&
      Math.abs(b0.top - b1.top) < 2 &&
      b0.styleLeft === b1.styleLeft &&
      b0.styleTop === b1.styleTop;
    positions[dest] = { box: b0, stable: !!stable, visible: !!b0 };
    await page.screenshot({ path: join(outDir, `qa-world-callout-${name}-${dest}.png`) });
  }
  await ctx.close();
  return { positions };
}

async function main() {
  const { chromium, devices } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const mobileVp = { ...devices["iPhone 13"].viewport, width: 390, height: 844 };
  const mobile = await runViewport(browser, "390x844", mobileVp, true);
  const desktop = await runViewport(browser, "1280", { width: 1280, height: 900 }, false);
  await browser.close();
  let liveBuild = null;
  try {
    const res = await fetch(`${base}/board`);
    const m = (await res.text()).match(/name="ground-board-build"\s+content="([^"]+)"/);
    liveBuild = m?.[1] ?? null;
  } catch {
    liveBuild = null;
  }
  const report = { base, liveBuild, mobile, desktop };
  console.log(JSON.stringify(report, null, 2));
  const fail = [];
  for (const [label, block] of [
    ["mobile", mobile],
    ["desktop", desktop],
  ]) {
    for (const d of ["home", "yg3", "ground", "archive"]) {
      if (!block.positions[d]?.visible) fail.push(`${label}-hidden-${d}`);
      if (!block.positions[d]?.stable) fail.push(`${label}-unstable-${d}`);
    }
    const a = block.positions.home?.box;
    const b = block.positions.ground?.box;
    if (a && b && Math.hypot(a.left - b.left, a.top - b.top) < 40) {
      fail.push(`${label}-callout-travel-same-spot`);
    }
  }
  if (fail.length) {
    console.error("FAILED:", fail.join(", "));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
