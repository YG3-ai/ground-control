#!/usr/bin/env node
/**
 * World bottom selector: real touch swipe (CDP), confirm tap, drag guard, back.
 */
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
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [pt(x1, y1)],
  });
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [pt(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t)],
    });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

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
  await page.waitForTimeout(200);
}

async function runViewport(browser, name, viewport, useTouch) {
  const context = await browser.newContext({
    viewport,
    hasTouch: !!useTouch,
    isMobile: !!useTouch,
  });
  const page = await context.newPage();
  const log = [];
  await page.goto(`${base}/board`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector("#lm-world-selector-scroll", { state: "visible", timeout: 15_000 });

  const layout = await page.evaluate(() => {
    const menu = document.getElementById("lm-world-menu");
    const scroll = document.getElementById("lm-world-selector-scroll");
    const menuBox = menu?.getBoundingClientRect();
    const selected = document.querySelector("#lm-world-view .lm-world-item.is-selected");
    return {
      bottomInset: menuBox ? window.innerHeight - menuBox.bottom : null,
      scrollSnap: scroll ? getComputedStyle(scroll).scrollSnapType : null,
      touchAction: scroll ? getComputedStyle(scroll).touchAction : null,
      selectedDest: selected?.getAttribute("data-dest") ?? null,
      calloutOn: document.querySelector(".lm-world-callout.on")?.getAttribute("data-dest") ?? null,
    };
  });
  log.push({ step: "layout", layout });
  mkdirSync(outDir, { recursive: true });
  await page.screenshot({ path: join(outDir, `qa-world-selector-${name}.png`) });
  const bottomPx = await page.evaluate(() => {
    const meta = document.querySelector('meta[name="theme-color"]')?.getAttribute("content");
    const htmlBg = getComputedStyle(document.documentElement).backgroundColor;
    const bodyBg = getComputedStyle(document.body).backgroundColor;
    const scroll = document.getElementById("lm-world-selector-scroll");
    const scrollStyle = scroll ? getComputedStyle(scroll) : null;
    return {
      themeColor: meta,
      htmlBg,
      bodyBg,
      immersive: document.documentElement.classList.contains("lm-immersive-world"),
      scrollOverflowY: scrollStyle?.overflowY,
      scrollbarWidth: scrollStyle?.scrollbarWidth,
    };
  });
  log.push({ step: "bottom-chrome", bottomPx });

  let stripBox = await page.locator("#lm-world-selector-scroll").boundingBox();
  if (!stripBox) {
    await page.waitForTimeout(400);
    stripBox = await page.locator("#lm-world-selector-scroll").boundingBox();
  }
  if (!stripBox) throw new Error("selector strip missing");
  const midY = stripBox.y + stripBox.height * 0.55;
  const startX = stripBox.x + stripBox.width * 0.72;
  const endX = stripBox.x + stripBox.width * 0.22;

  if (useTouch) {
    await cdpTouchSwipe(page, startX, midY, endX, midY);
  } else {
    await page.mouse.move(startX, midY);
    await page.mouse.down();
    await page.mouse.move(endX, midY, { steps: 16 });
    await page.mouse.up();
  }
  await page.waitForTimeout(200);

  const afterSwipe = await page.evaluate(() => ({
    focus: document.querySelector("#lm-world-view .lm-world-item.is-selected")?.getAttribute("data-dest"),
    callout: document.querySelector(".lm-world-callout.on")?.getAttribute("data-dest"),
    roomHidden: document.getElementById("lm-room-view")?.hidden,
  }));
  log.push({ step: "swipe-select-only", afterSwipe });

  if (!afterSwipe.roomHidden) log.push({ step: "fail", reason: "room opened on swipe" });
  if (useTouch && afterSwipe.focus === "home" && afterSwipe.callout === "home") {
    log.push({ step: "fail", reason: "swipe did not change selection" });
  }

  await enterWorldDestination(page, "ground");
  await page.waitForSelector("#lm-persist-back:not([hidden])");
  log.push({ step: "tap-enter-ground", destLabel: await page.locator("#lm-dest-label").textContent() });

  await page.locator("#lm-persist-back").click();
  await page.waitForFunction(() => !document.getElementById("lm-world-view")?.hidden);

  await page.screenshot({ path: join(outDir, `qa-world-selector-${name}-after-back.png`) });

  await context.close();
  return log;
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
    const html = await res.text();
    const m = html.match(/name="ground-board-build"\s+content="([^"]+)"/);
    liveBuild = m?.[1] ?? null;
  } catch {
    liveBuild = null;
  }
  const report = { base, liveBuild, mobile, desktop };
  console.log(JSON.stringify(report, null, 2));
  const fail = [];
  for (const [label, block] of [["mobile", mobile], ["desktop", desktop]]) {
    const swipe = block.find((x) => x.step === "swipe-select-only")?.afterSwipe;
    const enter = block.find((x) => x.step === "tap-enter-ground");
    const f = block.find((x) => x.step === "fail");
    if (f && label === "mobile") fail.push(`${label}-${f.reason}`);
    if (!swipe?.roomHidden) fail.push(`${label}-swipe-opened-room`);
    if (label === "mobile" && swipe?.focus === "home") fail.push("mobile-swipe-no-change");
    const chrome = block.find((x) => x.step === "bottom-chrome")?.bottomPx;
    if (label === "mobile" && chrome?.themeColor !== "#0a0a0c") fail.push("mobile-theme-color");
    if (label === "mobile" && swipe?.focus !== swipe?.callout) fail.push(`${label}-callout-mismatch`);
    if (enter?.destLabel !== "GROUND") fail.push(`${label}-enter-ground`);
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
