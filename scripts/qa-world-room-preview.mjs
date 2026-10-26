#!/usr/bin/env node
/** Central room portal preview + label rail QA. */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const base = process.env.BOARD_BASE_URL || "http://127.0.0.1:8787";
const outDir =
  process.env.BOARD_SHOT_DIR || join(repoRoot, "logs", "board-screenshots");

async function cdpTouchSwipe(page, x1, y1, x2, y2, steps = 14) {
  const cdp = await page.context().newCDPSession(page);
  const pt = (x, y) => ({
    x: Math.round(x),
    y: Math.round(y),
    radiusX: 1,
    radiusY: 1,
    force: 1,
    id: 0,
  });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [pt(x1, y1)] });
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [pt(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t)],
    });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

async function selectDest(page, dest) {
  const cur = await page.evaluate(
    () =>
      document.querySelector("#lm-world-view .lm-world-item.is-selected")?.getAttribute("data-dest") ||
      "home",
  );
  if (cur === dest) return;
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
  await page.waitForTimeout(320);
}

async function portalState(page) {
  return page.evaluate(() => {
    const frame = document.getElementById("lm-world-portal-frame");
    const btn = document.getElementById("lm-world-portal-btn");
    const fr = frame?.getBoundingClientRect();
    const active = document.querySelector(".lm-world-portal-img.is-active");
    const hud = document.getElementById("lm-cognitive-hud");
    const focus =
      document.querySelector("#lm-world-view .lm-world-item.is-selected")?.getAttribute("data-dest");
    const activeDest =
      focus === "home" && hud?.classList.contains("on")
        ? "home"
        : active?.getAttribute("data-dest");
    return {
      frame: fr ? { left: fr.left, top: fr.top, width: fr.width, height: fr.height } : null,
      name: document.getElementById("lm-world-portal-name")?.textContent?.trim(),
      activeDest,
      activePos: active?.style?.objectPosition || getComputedStyle(active || document.body).objectPosition,
      chipIcons: document.querySelectorAll(".lm-world-chip-icon").length,
    };
  });
}

async function runViewport(browser, tag, viewport, touch) {
  const ctx = await browser.newContext({ viewport, hasTouch: !!touch, isMobile: !!touch });
  const page = await ctx.newPage();
  await page.goto(`${base}/board`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#lm-world-portal-btn", { state: "visible" });
  await page.waitForFunction(() => document.querySelector(".lm-world-media")?.clientWidth > 0);
  if (tag === "1280") {
    await page.evaluate(() => {
      const v = document.getElementById("lm-world-live");
      if (v) {
        v.classList.add("lm-world-live-on");
        v.setAttribute("data-src-ready", "1");
      }
      window.dispatchEvent(new Event("resize"));
    });
    await page.waitForTimeout(120);
  }
  mkdirSync(outDir, { recursive: true });
  const dests = ["home", "yg3", "ground", "archive"];
  const frames = [];
  const positions = {};
  const anchor = await portalState(page);
  for (const dest of dests) {
    await selectDest(page, dest);
    const s0 = await portalState(page);
    await page.waitForTimeout(140);
    const s1 = await portalState(page);
    const stable =
      s0.frame &&
      s1.frame &&
      Math.abs(s0.frame.left - s1.frame.left) < 2 &&
      Math.abs(s0.frame.top - s1.frame.top) < 2;
    positions[dest] = {
      activeDest: s0.activeDest,
      name: s0.name,
      stable,
      frame: s0.frame,
    };
    frames.push(s0.frame);
    await page.screenshot({ path: join(outDir, `qa-world-room-preview-${tag}-${dest}.png`) });
  }
  const portalFixed = dests.every((d) => positions[d]?.stable);
  let swipe = null;
  if (touch) {
    const strip = await page.locator("#lm-world-selector-scroll").boundingBox();
    if (strip) {
      const midY = strip.y + strip.height * 0.5;
      await cdpTouchSwipe(page, strip.x + strip.width * 0.75, midY, strip.x + strip.width * 0.2, midY);
      await page.waitForTimeout(220);
      swipe = await page.evaluate(() => {
        const focus = document.querySelector("#lm-world-view .lm-world-item.is-selected")?.getAttribute("data-dest");
        const portal =
          focus === "home"
            ? "home"
            : document.querySelector(".lm-world-portal-img.is-active")?.getAttribute("data-dest");
        return {
          focus,
          portal,
          roomHidden: document.getElementById("lm-room-view")?.hidden,
        };
      });
    }
  }
  await selectDest(page, "ground");
  await page.evaluate(() => document.getElementById("lm-world-portal-btn")?.click());
  await page.waitForTimeout(200);
  const opened = await page.evaluate(() => ({
    roomHidden: document.getElementById("lm-room-view")?.hidden,
    label: document.getElementById("lm-dest-label")?.textContent?.trim(),
  }));
  await page.screenshot({ path: join(outDir, `qa-world-room-preview-${tag}-opened.png`) });
  await ctx.close();
  return { anchor, positions, portalFixed, swipe, opened };
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
  for (const [label, block] of [["mobile", mobile], ["desktop", desktop]]) {
    if (block.anchor.chipIcons > 0) fail.push(`${label}-legacy-chip-icons`);
    if (!block.portalFixed) fail.push(`${label}-portal-moved`);
    for (const d of ["home", "yg3", "ground", "archive"]) {
      const p = block.positions[d];
      if (p?.activeDest !== d) fail.push(`${label}-preview-${d}`);
      if (!p?.stable) fail.push(`${label}-unstable-${d}`);
    }
    if (label === "mobile" && block.swipe) {
      if (!block.swipe.roomHidden) fail.push("mobile-swipe-opened-room");
      if (block.swipe.focus !== block.swipe.portal) fail.push("mobile-swipe-portal-mismatch");
    }
    if (block.opened.roomHidden || block.opened.label !== "GROUND") fail.push(`${label}-portal-open-fail`);
  }
  const root = await fetch(base + "/").then((r) => r.status).catch(() => 0);
  const board = await fetch(base + "/board").then((r) => r.status).catch(() => 0);
  if (root !== 200 || board !== 200) fail.push("routes");
  if (fail.length) {
    console.error("FAILED:", fail.join(", "));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
