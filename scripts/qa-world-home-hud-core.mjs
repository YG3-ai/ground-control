#!/usr/bin/env node
/** Suit HUD modes — fixed rail, plane swipe, four mode panels. */
import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const base = process.env.BOARD_BASE_URL || "http://127.0.0.1:8787";
const outDir =
  process.env.BOARD_SHOT_DIR || join(repoRoot, "logs", "board-screenshots");
const MODES = ["home", "yg3", "ground", "archive"];
/** Owner-approved integrated HUD presentation scale before +50% pass */
const APPROVED_PRESENT_SCALE = { mobile: 1.38, desktop: 1.45 };
const FINAL_SCALE_MULTIPLIER = 1.5;
const SCALE_TOLERANCE = 0.08;

function posterContentFillFromFile(file) {
  const probe = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "json",
      file,
    ],
    { encoding: "utf8" },
  );
  const { width: W, height: H } = JSON.parse(probe.stdout).streams[0];
  const raw = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { encoding: "buffer", maxBuffer: W * H * 3 + 1e6 },
  );
  const buf = raw.stdout;
  let lit = 0;
  const total = W * H;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 3;
      if (Math.max(buf[o], buf[o + 1], buf[o + 2]) > 18) lit += 1;
    }
  }
  return { W, H, fill: lit / total };
}

async function selectMode(page, dest) {
  await page.evaluate((d) => {
    document.querySelector(`#lm-mode-rail .lm-world-item[data-dest="${d}"]`)?.click();
  }, dest);
  await page.waitForFunction(
    (d) =>
      document.querySelector("#lm-mode-rail .lm-world-item.is-selected")?.getAttribute("data-dest") ===
      d,
    dest,
    { timeout: 8000 },
  );
  await page.waitForTimeout(350);
}

async function railLeftPositions(page) {
  return page.evaluate(() => {
    const chips = [...document.querySelectorAll("#lm-mode-rail .lm-world-item")];
    return chips.map((c) => Math.round(c.getBoundingClientRect().left));
  });
}

async function hudState(page) {
  return page.evaluate(() => {
    const plane = document.getElementById("lm-suit-hud-plane");
    const track = document.getElementById("lm-suit-hud-track");
    const focus = document.querySelector("#lm-mode-rail .lm-world-item.is-selected")?.getAttribute("data-dest");
    const readout =
      focus === "home"
        ? document.getElementById("lm-cognitive-readout-name")?.textContent?.trim()
        : document.getElementById(`lm-mode-${focus}-name`)?.textContent?.trim();
    return {
      planeOn: plane?.classList.contains("on"),
      focus,
      readout,
      roomHidden: document.getElementById("lm-room-view")?.hidden,
      worldHidden: document.getElementById("lm-world-view")?.hidden,
      trackTransform: track?.style?.transform || "",
    };
  });
}

async function touchSwipeHudLeft(page) {
  const box = await page.locator("#lm-world-view").boundingBox();
  if (!box) return { ok: false, reason: "no-world-box" };
  const cy = box.y + box.height * 0.38;
  const fromX = box.x + box.width * 0.78;
  const toX = box.x + box.width * 0.12;
  return page.evaluate(
    async ({ fromX, toX, cy }) => {
      const el = document.getElementById("lm-world-view");
      const mk = (x, y) =>
        new Touch({
          identifier: 99,
          target: el,
          clientX: x,
          clientY: y,
          pageX: x,
          pageY: y,
          radiusX: 2,
          radiusY: 2,
          rotationAngle: 0,
          force: 1,
        });
      const rail = () =>
        [...document.querySelectorAll("#lm-mode-rail .lm-world-item")].map((c) =>
          Math.round(c.getBoundingClientRect().left),
        );
      const before = rail();
      el.dispatchEvent(
        new TouchEvent("touchstart", {
          bubbles: true,
          cancelable: true,
          touches: [mk(fromX, cy)],
          changedTouches: [mk(fromX, cy)],
        }),
      );
      const steps = 14;
      for (let i = 1; i <= steps; i++) {
        const x = fromX + ((toX - fromX) * i) / steps;
        el.dispatchEvent(
          new TouchEvent("touchmove", {
            bubbles: true,
            cancelable: true,
            touches: [mk(x, cy)],
            changedTouches: [mk(x, cy)],
          }),
        );
      }
      const during = rail();
      el.dispatchEvent(
        new TouchEvent("touchend", {
          bubbles: true,
          cancelable: true,
          touches: [],
          changedTouches: [mk(toX, cy)],
        }),
      );
      await new Promise((r) => setTimeout(r, 520));
      const focus = document.querySelector("#lm-mode-rail .lm-world-item.is-selected")?.getAttribute(
        "data-dest",
      );
      const stable =
        before.length === during.length && before.every((x, i) => Math.abs(x - during[i]) < 2);
      return { ok: stable && focus === "yg3", focus, stable, before, during };
    },
    { fromX, toX, cy },
  );
}

const HUD_SURFACE_SKIP = new Set([
  "lm-home-readout-cluster",
  "lm-cognitive-brain-halo",
  "lm-cognitive-glow-canvas",
  "lm-cognitive-energy",
  "lm-cognitive-brain-canvas",
  "lm-cognitive-brain-source",
]);

function near(actual, expected, tol) {
  return Math.abs(actual - expected) <= tol;
}

async function railNavVisualAudit(page) {
  await selectMode(page, "home");
  return page.evaluate(() => {
    const rail = document.getElementById("lm-mode-rail");
    const marker = document.getElementById("lm-mode-rail-marker");
    function parseRgb(str) {
      const m = String(str || "").match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (!m) return null;
      return { r: +m[1], g: +m[2], b: +m[3] };
    }
    function isAmber(rgb) {
      if (!rgb) return false;
      return rgb.r > 200 && rgb.g > 130 && rgb.g < 225 && rgb.b < 160;
    }
    function dotLikeAmber(el) {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
      const w = parseFloat(cs.width);
      const h = parseFloat(cs.height);
      if (!w || !h || w > 16 || h > 16) return false;
      const br = parseFloat(cs.borderRadius);
      if (br < Math.min(w, h) * 0.35) return false;
      if (isAmber(parseRgb(cs.backgroundColor))) return true;
      if (isAmber(parseRgb(cs.boxShadow))) return true;
      return false;
    }
    let amberDots = 0;
    if (rail) {
      rail.querySelectorAll("*").forEach((el) => {
        if (dotLikeAmber(el)) amberDots += 1;
      });
    }
    if (marker) {
      const cs = getComputedStyle(marker);
      if (cs.display !== "none" && cs.visibility !== "hidden") amberDots += 1;
    }
    const selected = [...(rail?.querySelectorAll(".lm-world-item.is-selected") || [])];
    const label = selected[0]?.querySelector(".lm-world-chip-label");
    const before = label ? getComputedStyle(label, "::before") : null;
    const activeBacklight = !!(
      label &&
      before &&
      before.backgroundImage &&
      before.backgroundImage !== "none"
    );
    const inactive = [...(rail?.querySelectorAll(".lm-world-item:not(.is-selected) .lm-world-chip-label") || [])];
    const inactiveDimmed = inactive.every((el) => {
      const c = parseRgb(getComputedStyle(el).color);
      return c && c.r < 250;
    });
    return {
      amberDots,
      markerPresent: !!marker,
      selectedCount: selected.length,
      activeBacklight,
      inactiveDimmed,
      railNavOk:
        amberDots === 0 &&
        !marker &&
        selected.length === 1 &&
        activeBacklight &&
        inactiveDimmed,
    };
  });
}

async function brainMountStabilityAudit(page) {
  await selectMode(page, "home");
  await page.waitForSelector("#lm-brain-core-poster", { timeout: 8000 });
  await page.waitForTimeout(600);
  const samples = [];
  for (let i = 0; i < 14; i++) {
    await page.waitForTimeout(220);
    const sample = await page.evaluate(() => {
      const canvas = document.getElementById("lm-cognitive-brain-canvas");
      const present = document.querySelector(".lm-cognitive-brain-present");
      const mount = document.getElementById("lm-cognitive-brain-mount");
      const c = canvas?.getBoundingClientRect();
      const p = present?.getBoundingClientRect();
      const m = mount?.getBoundingClientRect();
      return {
        cLeft: c?.left ?? 0,
        cTop: c?.top ?? 0,
        cWidth: c?.width ?? 0,
        cHeight: c?.height ?? 0,
        pLeft: p?.left ?? 0,
        pTop: p?.top ?? 0,
        mLeft: m?.left ?? 0,
        mTop: m?.top ?? 0,
      };
    });
    samples.push(sample);
  }
  const maxDelta = (key) => {
    let min = Infinity;
    let max = -Infinity;
    for (const s of samples) {
      const v = s[key];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return max - min;
  };
  const tol = samples[0]?.cWidth > 400 ? 1.25 : 1.5;
  const brainMountStable =
    maxDelta("cLeft") <= tol &&
    maxDelta("cTop") <= tol &&
    maxDelta("cWidth") <= tol &&
    maxDelta("cHeight") <= tol &&
    maxDelta("pLeft") <= tol &&
    maxDelta("pTop") <= tol &&
    maxDelta("mLeft") <= tol &&
    maxDelta("mTop") <= tol;
  return { brainMountStable, samples, maxDelta: {
    cLeft: maxDelta("cLeft"),
    cTop: maxDelta("cTop"),
    cWidth: maxDelta("cWidth"),
    cHeight: maxDelta("cHeight"),
    pLeft: maxDelta("pLeft"),
    pTop: maxDelta("pTop"),
  }};
}

async function homeHudCompositionAudit(page) {
  await selectMode(page, "home");
  await page.waitForSelector("#lm-brain-core-poster", { timeout: 8000 });
  await page.evaluate(async () => {
    const p = document.getElementById("lm-brain-core-poster");
    if (p && !p.complete) await p.decode();
  });
  await page.waitForFunction(
    () => {
      const p = document.getElementById("lm-brain-core-poster");
      return p && p.naturalWidth >= 700 && p.naturalHeight >= 400;
    },
    { timeout: 15_000 },
  );
  await page.waitForTimeout(800);
  return page.evaluate(
    ({ approvedPresentScale, finalScaleMultiplier, scaleTolerance }) => {
    const field = document.getElementById("lm-cognitive-field");
    const mount = document.getElementById("lm-cognitive-brain-mount");
    const col = document.getElementById("lm-cognitive-brain-col");
    const readout = document.getElementById("lm-cognitive-readout");
    const state = document.getElementById("lm-cognitive-readout-state");
    const f = field?.getBoundingClientRect();
    const m = mount?.getBoundingClientRect();
    const c = col?.getBoundingClientRect();
    const ro = readout?.getBoundingClientRect();
    const mobile = window.innerWidth <= 767;
    const ultrawideDesktop = !mobile && window.innerWidth >= 1800;
    const headlinePx = state ? parseFloat(getComputedStyle(state).fontSize) : 0;
    const margin = 6;
    const brainWidthVsStage = f && m ? m.width / f.width : 0;
    const brainHeightVsStage = f && m ? m.height / f.height : 0;
    const brainHeightVsCol = c && m ? m.height / c.height : 0;
    const colSlack = mobile ? 32 : 12;
    let brainInsideCol =
      !!c &&
      !!m &&
      m.left >= c.left - colSlack &&
      m.right <= c.right + colSlack &&
      m.top >= c.top - colSlack &&
      m.bottom <= c.bottom + colSlack;
    const stageSlack = mobile ? 14 : 8;
    const brainInsideStage =
      !!f &&
      !!m &&
      m.left >= f.left - stageSlack &&
      m.right <= f.right + stageSlack &&
      m.top >= f.top - stageSlack &&
      m.bottom <= f.bottom + stageSlack;
    const brainInsideViewport =
      !!m &&
      m.left >= margin &&
      m.right <= window.innerWidth - margin &&
      m.top >= margin &&
      m.bottom <= window.innerHeight - margin;
    const readoutPos = readout ? getComputedStyle(readout).position : "";
    const readoutZ = readout ? parseInt(getComputedStyle(readout).zIndex, 10) || 0 : 0;
    const layeredHud =
      readoutPos === "absolute" &&
      readoutZ >= 4 &&
      !!f &&
      !!ro &&
      (mobile ? ro.top < f.bottom - 24 : ro.left >= f.left + f.width * 0.52);
    const verticalStack = mobile && layeredHud;
    const readoutRightOfCol = !mobile && layeredHud;
    const canvas = document.getElementById("lm-cognitive-brain-canvas");
    const pressed = document.querySelector('.lm-cognitive-region-hit[aria-pressed="true"]');
    const anyHit = document.querySelector(".lm-cognitive-region-hit");
    const hit = pressed || anyHit;
    let glowAligned = true;
    const glowBox = canvas?.getBoundingClientRect() || m;
    if (hit && glowBox) {
      const h = hit.getBoundingClientRect();
      const hx = h.left + h.width / 2;
      const hy = h.top + h.height / 2;
      glowAligned =
        hx >= glowBox.left - 12 &&
        hx <= glowBox.right + 12 &&
        hy >= glowBox.top - 12 &&
        hy <= glowBox.bottom + 12;
    }
    const canvasOpacity = canvas ? parseFloat(getComputedStyle(canvas).opacity) : 0;
    let brainCanvasFill = 0;
    const video = document.getElementById("lm-brain-core-video");
    const poster = document.getElementById("lm-brain-core-poster");
    const letterboxDims =
      !!(poster && poster.naturalWidth >= 700 && poster.naturalHeight >= 400) ||
      !!(video && video.videoWidth >= 700 && video.videoHeight >= 400);
    let brainLitMarginPx = 0;
    let brainLitBboxArea = 0;
    let brainLitCanvasMinX = 0;
    let brainLitCanvasMaxX = 0;
    let brainLitCanvasMinY = 0;
    let brainLitCanvasMaxY = 0;
    if (canvas && canvas.width > 0 && canvas.height > 0) {
      const ctx = canvas.getContext("2d");
      if (ctx) {
        const w = canvas.width;
        const h = canvas.height;
        const data = ctx.getImageData(0, 0, w, h).data;
        let lit = 0;
        let minX = w;
        let minY = h;
        let maxX = 0;
        let maxY = 0;
        const total = w * h;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const a = data[(y * w + x) * 4 + 3];
            if (a <= 16) continue;
            lit += 1;
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
          }
        }
        brainCanvasFill = total ? lit / total : 0;
        if (lit > 0) {
          brainLitMarginPx = Math.min(minX, minY, w - 1 - maxX, h - 1 - maxY);
          brainLitBboxArea = (maxX - minX + 1) * (maxY - minY + 1);
          brainLitCanvasMinX = minX;
          brainLitCanvasMaxX = maxX;
          brainLitCanvasMinY = minY;
          brainLitCanvasMaxY = maxY;
        }
      }
    }
    let brainScreenClipOk = false;
    let brainScreenEdgePadPx = 0;
    let brainLitScreen = null;
    const rail = document.getElementById("lm-mode-rail");
    const railBox = rail?.getBoundingClientRect();
    let brainClearOfRail = true;
    if (canvas && m && canvas.width > 0 && canvas.height > 0 && brainLitBboxArea > 0) {
      const ctx2 = canvas.getContext("2d");
      const cR = canvas.getBoundingClientRect();
      if (ctx2 && cR.width > 0 && cR.height > 0) {
        const data2 = ctx2.getImageData(0, 0, canvas.width, canvas.height).data;
        const w2 = canvas.width;
        const h2 = canvas.height;
        let minSx = Infinity;
        let minSy = Infinity;
        let maxSx = -Infinity;
        let maxSy = -Infinity;
        const step = Math.max(1, Math.floor(Math.min(w2, h2) / 96));
        for (let y = 0; y < h2; y += step) {
          for (let x = 0; x < w2; x += step) {
            const a = data2[(y * w2 + x) * 4 + 3];
            if (a <= 16) continue;
            const sx = cR.left + (x / w2) * cR.width;
            const sy = cR.top + (y / h2) * cR.height;
            if (sx < minSx) minSx = sx;
            if (sy < minSy) minSy = sy;
            if (sx > maxSx) maxSx = sx;
            if (sy > maxSy) maxSy = sy;
          }
        }
        if (minSx < Infinity) {
          brainLitScreen = { left: minSx, top: minSy, right: maxSx, bottom: maxSy };
          if (c) {
            brainInsideCol =
              minSx >= c.left - colSlack &&
              maxSx <= c.right + colSlack &&
              minSy >= c.top - colSlack &&
              maxSy <= c.bottom + colSlack;
          }
          const pad = mobile ? 8 : 10;
          const vPad = 6;
          brainScreenEdgePadPx = Math.min(
            minSx - vPad,
            minSy - vPad,
            window.innerWidth - vPad - maxSx,
            (railBox ? railBox.top - vPad : window.innerHeight - vPad) - maxSy,
          );
          brainScreenClipOk =
            minSx >= vPad &&
            minSy >= vPad &&
            maxSx <= window.innerWidth - vPad &&
            maxSy <= (railBox ? railBox.top - vPad : window.innerHeight - vPad);
        }
      }
    }
    let brainLitSpanVsStage = 0;
    let brainLitScreenW = 0;
    let brainLitScreenH = 0;
    let brainCenteredInMount = false;
    let brainMountBreathingBalance = 0;
    let brainMountCenterDeltaPx = 0;
    let brainOpticalOffsetRatio = 0;
    if (brainLitScreen && f) {
      brainLitScreenW = brainLitScreen.right - brainLitScreen.left;
      brainLitScreenH = brainLitScreen.bottom - brainLitScreen.top;
      brainLitSpanVsStage = brainLitScreenW / f.width;
    }
    if (canvas && canvas.width > 0 && brainLitBboxArea > 0 && m && m.width > 40) {
      const w = canvas.width;
      const h = canvas.height;
      const padL = brainLitCanvasMinX;
      const padR = w - 1 - brainLitCanvasMaxX;
      const padT = brainLitCanvasMinY;
      const padB = h - 1 - brainLitCanvasMaxY;
      brainMountBreathingBalance = Math.min(padL, padR) / Math.max(padL, padR, 1);
      const litCx = (brainLitCanvasMinX + brainLitCanvasMaxX) / 2;
      brainMountCenterDeltaPx = Math.abs(litCx - (w - 1) / 2);
      const centerTol = w * (mobile ? 0.07 : 0.06);
      const mountCx = (m.left + m.right) / 2;
      const colCx = c ? (c.left + c.right) / 2 : mountCx;
      const mountCenteredInSection = Math.abs(mountCx - colCx) <= (mobile ? 6 : 8);
      const cR = canvas.getBoundingClientRect();
      let screenPadL = 0;
      let screenPadR = 0;
      if (brainLitScreen && cR.width > 0) {
        screenPadL = brainLitScreen.left - cR.left;
        screenPadR = cR.right - brainLitScreen.right;
        const screenBalance =
          Math.min(screenPadL, screenPadR) / Math.max(screenPadL, screenPadR, 1);
        brainMountBreathingBalance = Math.max(brainMountBreathingBalance, screenBalance);
        const mediaCx = (cR.left + cR.right) / 2;
        const brainCx = (brainLitScreen.left + brainLitScreen.right) / 2;
        brainMountCenterDeltaPx = Math.abs(brainCx - mediaCx);
      }
      const fieldCx = f ? (f.left + f.right) / 2 : 0;
      const brainScreenCx = brainLitScreen
        ? (brainLitScreen.left + brainLitScreen.right) / 2
        : fieldCx;
      brainOpticalOffsetRatio = f ? (brainScreenCx - fieldCx) / f.width : 0;
      const readoutCx = ro ? (ro.left + ro.right) / 2 : fieldCx;
      if (mobile) {
        brainCenteredInMount =
          mountCenteredInSection &&
          brainOpticalOffsetRatio >= 0.04 &&
          brainOpticalOffsetRatio <= 0.17 &&
          brainMountBreathingBalance >= 0.5;
      } else {
        brainCenteredInMount =
          mountCenteredInSection &&
          brainOpticalOffsetRatio >= 0.008 &&
          brainOpticalOffsetRatio <= 0.09 &&
          brainMountCenterDeltaPx <= (cR?.width || m.width) * 0.08 &&
          brainMountBreathingBalance >= 0.68;
      }
    }
    let readoutOverBrainOverlap = 0;
    let readoutIntegratedHud = false;
    const canvasRectForHud = canvas?.getBoundingClientRect();
    const hudOverlayBox = (() => {
      if (canvasRectForHud && canvasRectForHud.width > 40) {
        const split = mobile ? 0.42 : 0.48;
        return {
          left: canvasRectForHud.left + canvasRectForHud.width * split,
          top: canvasRectForHud.top,
          right: canvasRectForHud.right,
          bottom: canvasRectForHud.bottom,
        };
      }
      if (brainLitScreen) {
        const split = mobile ? 0.35 : 0.4;
        const w = brainLitScreen.right - brainLitScreen.left;
        return {
          left: brainLitScreen.left + w * split,
          top: brainLitScreen.top,
          right: brainLitScreen.right,
          bottom: brainLitScreen.bottom,
        };
      }
      return m;
    })();
    if (ro && hudOverlayBox) {
      const box =
        hudOverlayBox.left != null
          ? hudOverlayBox
          : {
              left: hudOverlayBox.x,
              top: hudOverlayBox.y,
              right: hudOverlayBox.right,
              bottom: hudOverlayBox.bottom,
            };
      const overlapX = Math.max(0, Math.min(box.right, ro.right) - Math.max(box.left, ro.left));
      const overlapY = Math.max(0, Math.min(box.bottom, ro.bottom) - Math.max(box.top, ro.top));
      readoutOverBrainOverlap = overlapX * overlapY;
      readoutIntegratedHud = readoutOverBrainOverlap >= (mobile ? 900 : 1800);
    }
    let glowNotObscured = true;
    if (hit && ro) {
      const h = hit.getBoundingClientRect();
      const hx = h.left + h.width / 2;
      const hy = h.top + h.height / 2;
      const pad = mobile ? 4 : 6;
      glowNotObscured =
        hx < ro.left - pad ||
        hx > ro.right + pad ||
        hy < ro.top - pad ||
        hy > ro.bottom + pad;
    }
    if (m && railBox) {
      brainClearOfRail = m.bottom <= railBox.top + 10;
      if (brainLitScreen) {
        brainClearOfRail = brainLitScreen.bottom <= railBox.top + 8;
      }
    }
    let brainClearOfReadout = readoutIntegratedHud;
    const present = document.querySelector(".lm-cognitive-brain-present");
    const canvasRect = canvas?.getBoundingClientRect();
    const mountEl = document.getElementById("lm-cognitive-brain-mount");
    const layoutW = mountEl?.clientWidth || 1;
    const layoutH = mountEl?.clientHeight || 1;
    const visualScaleW = canvasRect ? canvasRect.width / layoutW : 0;
    const visualScaleH = canvasRect ? canvasRect.height / layoutH : 0;
    let presentScale = 1;
    if (present) {
      const fieldCs = getComputedStyle(
        document.getElementById("lm-cognitive-field") || document.documentElement,
      );
      const rawScale = parseFloat(fieldCs.getPropertyValue("--lm-brain-present-scale") || "");
      if (Number.isFinite(rawScale) && rawScale > 0.5) {
        presentScale = rawScale;
      } else {
        const tr = getComputedStyle(present).transform;
        if (tr && tr !== "none") {
          const m = tr.match(/matrix\(([^)]+)\)/);
          if (m) {
            const parts = m[1].split(",").map((x) => parseFloat(x.trim()));
            if (parts[0] > 0) presentScale = parts[0];
          }
        }
      }
      if (!Number.isFinite(presentScale) || presentScale < 0.5) {
        presentScale = Math.max(visualScaleW, visualScaleH, 1);
      }
    }
    const approvedVisual = mobile ? approvedPresentScale.mobile : approvedPresentScale.desktop;
    const nominalTarget = approvedVisual * finalScaleMultiplier;
    const targetVisual = presentScale > 0.5 ? presentScale : nominalTarget;
    const scaleVsApprovedUniform =
      visualScaleW >= targetVisual * (1 - scaleTolerance) &&
      visualScaleW <= targetVisual * (1 + scaleTolerance) &&
      visualScaleH >= targetVisual * (1 - scaleTolerance) &&
      visualScaleH <= targetVisual * (1 + scaleTolerance);
    const approvedLitW = mobile ? 0.443 : 0.482;
    const approvedLitH = mobile ? 0.28 : 0.42;
    const litWVsStage = f && brainLitScreenW > 0 ? brainLitScreenW / f.width : 0;
    const litHVsStage = f && brainLitScreenH > 0 ? brainLitScreenH / f.height : 0;
    const litBoundsVsApproved = mobile
      ? litWVsStage >= approvedLitW * finalScaleMultiplier * (1 - scaleTolerance) &&
        litHVsStage >= approvedLitH * finalScaleMultiplier * (1 - scaleTolerance * 2.2)
      : litWVsStage >= approvedLitW * finalScaleMultiplier * (1 - scaleTolerance) &&
        litHVsStage >= approvedLitH * finalScaleMultiplier * (1 - scaleTolerance);
    const canvasToScreenX = canvas && canvasRect ? canvasRect.width / canvas.width : 1;
    const canvasToScreenY = canvas && canvasRect ? canvasRect.height / canvas.height : 1;
    const renderedLitBboxArea = brainLitBboxArea * canvasToScreenX * canvasToScreenY;
    const baselineFill = mobile ? 0.04 : 0.05;
    const minRenderedLitArea = mobile ? 17500 : 22000;
    const enlargedVsBaseline = ultrawideDesktop
      ? scaleVsApprovedUniform &&
        brainCanvasFill >= baselineFill * 0.88 &&
        renderedLitBboxArea >= minRenderedLitArea * 0.55 &&
        brainLitMarginPx >= 2
      : scaleVsApprovedUniform &&
        litBoundsVsApproved &&
        brainCanvasFill >= baselineFill * 0.92 &&
        renderedLitBboxArea >= minRenderedLitArea &&
        brainLitMarginPx >= 2;
    const visibleContentFill = brainCanvasFill;
    const stockBrainAsset =
      (video?.getAttribute("src") || "").includes("brain-core-stock.mp4") &&
      (poster?.getAttribute("src") || "").includes("brain-core-stock-poster");
    const videoCs = video ? getComputedStyle(video) : null;
    const canvasCs = canvas ? getComputedStyle(canvas) : null;
    const mountBox = document.getElementById("lm-cognitive-brain-mount")?.getBoundingClientRect();
    const readyOk = !video || video.readyState >= 2 || (poster && poster.complete);
    const brainVisible =
      stockBrainAsset &&
      letterboxDims &&
      readyOk &&
      !!mountBox &&
      mountBox.width > 80 &&
      mountBox.height > 80 &&
      parseFloat(canvasCs?.opacity || "0") > 0.2 &&
      !document.getElementById("lm-cognitive-hud")?.classList.contains("lm-cognitive-hud--halo-only");
    const fieldCs = field ? getComputedStyle(field) : null;
    const fieldBgClear =
      fieldCs &&
      fieldCs.backgroundImage === "none" &&
      (fieldCs.backgroundColor === "rgba(0, 0, 0, 0)" || fieldCs.backgroundColor === "transparent") &&
      fieldCs.boxShadow === "none";
    const plane = document.getElementById("lm-suit-hud-plane");
    const stage = document.getElementById("lm-stage");
    const glowCanvas = document.getElementById("lm-cognitive-glow-canvas");
    const instrumentOverflowVisible = [
      "lm-cognitive-field",
      "lm-cognitive-brain-col",
      "lm-cognitive-brain-mount",
    ].every((id) => {
      const el = document.getElementById(id);
      return el && getComputedStyle(el).overflow === "visible";
    });
    const outerCarouselClipped =
      !!plane &&
      getComputedStyle(plane).overflow === "hidden" &&
      !!stage &&
      getComputedStyle(stage).overflow === "hidden";
    const noPageHScroll = document.documentElement.scrollWidth <= window.innerWidth + 2;
    const canvasBox = canvas?.getBoundingClientRect();
    const brainBleedsPastStage =
      !!(f && canvasBox && (canvasBox.left < f.left - 4 || canvasBox.right > f.right + 4));
    const yg3Slide = document.querySelector('.lm-suit-hud-slide[data-mode="yg3"]');
    const neighborSlideIsolated =
      !yg3Slide || yg3Slide.getBoundingClientRect().left >= window.innerWidth - 2;
    const glowZ = glowCanvas ? parseInt(getComputedStyle(glowCanvas).zIndex, 10) || 0 : 0;
    const readoutAboveGlow = readoutZ > glowZ;
    const brainOverflowOk = ultrawideDesktop
      ? brainScreenClipOk || brainBleedsPastStage
      : brainBleedsPastStage;
    const hudOverflowHierarchyOk =
      instrumentOverflowVisible &&
      outerCarouselClipped &&
      noPageHScroll &&
      brainOverflowOk &&
      neighborSlideIsolated &&
      readoutAboveGlow;
    const brainMinWidth = mobile ? 280 : 520;
    const brainLargeEnough = (m?.width ?? 0) >= brainMinWidth;
    const brainStageDominant = mobile
      ? brainWidthVsStage >= 0.88 && brainHeightVsStage >= 0.4
      : ultrawideDesktop
        ? brainLitSpanVsStage >= 0.22 && brainHeightVsStage >= 0.34
        : brainWidthVsStage >= 0.78 && brainHeightVsStage >= 0.62;
    const projectLabel =
      document.getElementById("lm-cognitive-readout-name")?.textContent?.trim() || "";
    const projectTitle =
      document.getElementById("lm-cognitive-readout-state")?.textContent?.trim() || "";
    const instrumentSigCount = document.querySelectorAll("#lm-home-instruments .lm-home-sig").length;
    const instrumentText = document.getElementById("lm-home-instruments")?.textContent || "";
    const homeHudLiveCopy =
      instrumentSigCount >= 0 &&
      instrumentSigCount <= 3 &&
      !/\bLINK\b/.test(instrumentText) &&
      !/\b0\s*(JOBS|SESSIONS|FACTS)\b/.test(instrumentText) &&
      !/standby/i.test(projectTitle) &&
      !/standby/i.test(projectLabel);
    const homeHudProjectLabel =
      projectLabel === "CURRENT PROJECT" ||
      projectLabel === "PROJECT" ||
      projectLabel === "STATUS";
    const cluster = document.getElementById("lm-home-readout-cluster");
    const clusterCs = cluster ? getComputedStyle(cluster) : null;
    const clusterBackdropOk =
      !!cluster &&
      clusterCs &&
      (clusterCs.backdropFilter === "none" || clusterCs.backdropFilter === "") &&
      (clusterCs.webkitBackdropFilter === "none" || !clusterCs.webkitBackdropFilter) &&
      clusterCs.borderRadius === "1px";
    const projectTitleOk =
      projectTitle === "READY" ||
      projectTitle === "WORKING" ||
      projectTitle === "GROUND LIFE MIRROR" ||
      projectTitle === "LIFE MIRROR" ||
      projectTitle === "Preview";
    const homeCompositionOk = mobile
      ? brainInsideStage &&
        brainInsideViewport &&
        brainStageDominant &&
        brainLitSpanVsStage >= 0.4 &&
        brainLargeEnough &&
        headlinePx >= 17 &&
        layeredHud &&
        glowAligned &&
        glowNotObscured &&
        canvasOpacity >= 0.9 &&
        fieldBgClear &&
        stockBrainAsset &&
        letterboxDims &&
        brainVisible &&
        (brainCanvasFill >= 0.04 || visibleContentFill >= 0.04) &&
        enlargedVsBaseline &&
        brainLitMarginPx >= 2 &&
        presentScale >= 1.35 &&
        brainScreenClipOk &&
        brainClearOfRail &&
        readoutIntegratedHud &&
        brainCenteredInMount &&
        hudOverflowHierarchyOk &&
        homeHudLiveCopy &&
        homeHudProjectLabel &&
        clusterBackdropOk &&
        projectTitleOk
      : brainInsideStage &&
        brainInsideViewport &&
        brainStageDominant &&
        brainLitSpanVsStage >= (ultrawideDesktop ? 0.22 : 0.45) &&
        brainLargeEnough &&
        headlinePx >= 19 &&
        readoutRightOfCol &&
        glowAligned &&
        glowNotObscured &&
        canvasOpacity >= 0.9 &&
        fieldBgClear &&
        stockBrainAsset &&
        letterboxDims &&
        brainVisible &&
        (brainCanvasFill >= 0.04 || visibleContentFill >= 0.04) &&
        enlargedVsBaseline &&
        brainLitMarginPx >= 2 &&
        presentScale >= 1.35 &&
        brainScreenClipOk &&
        brainClearOfRail &&
        readoutIntegratedHud &&
        brainCenteredInMount &&
        hudOverflowHierarchyOk &&
        homeHudLiveCopy &&
        homeHudProjectLabel &&
        clusterBackdropOk &&
        projectTitleOk;
    return {
      mobile,
      projectLabel,
      projectTitle,
      instrumentSigCount,
      homeHudLiveCopy,
      homeHudProjectLabel,
      clusterBackdropOk,
      projectTitleOk,
      brainInsideCol,
      brainInsideStage,
      brainInsideViewport,
      brainWidth: m?.width ?? 0,
      brainWidthVsStage,
      brainHeightVsStage,
      brainHeightVsCol,
      brainLitSpanVsStage,
      brainCenteredInMount,
      brainOpticalOffsetRatio,
      brainMountBreathingBalance,
      brainMountCenterDeltaPx,
      headlinePx,
      verticalStack,
      layeredHud,
      readoutRightOfCol,
      readoutOverBrainOverlap,
      readoutIntegratedHud,
      glowNotObscured,
      glowAligned,
      canvasOpacity,
      fieldBgClear,
      brainLargeEnough,
      brainCanvasFill,
      letterboxDims,
      stockBrainAsset,
      brainVisible,
      brainLitMarginPx,
      brainLitBboxArea,
      renderedLitBboxArea,
      presentScale,
      brainLitScreenW,
      brainLitScreenH,
      canvasScreenW: canvasRect?.width ?? 0,
      canvasScreenH: canvasRect?.height ?? 0,
      visualScaleW,
      visualScaleH,
      scaleVsApprovedUniform,
      litWVsStage,
      litHVsStage,
      litBoundsVsApproved,
      enlargedVsBaseline,
      brainScreenClipOk,
      brainScreenEdgePadPx,
      brainClearOfRail,
      brainClearOfReadout,
      hudOverflowHierarchyOk,
      instrumentOverflowVisible,
      outerCarouselClipped,
      noPageHScroll,
      brainBleedsPastStage,
      neighborSlideIsolated,
      readoutAboveGlow,
      homeCompositionOk,
    };
  },
    {
      approvedPresentScale: APPROVED_PRESENT_SCALE,
      finalScaleMultiplier: FINAL_SCALE_MULTIPLIER,
      scaleTolerance: SCALE_TOLERANCE,
    },
  );
}

async function hudStageBBox(page) {
  await selectMode(page, "home");
  return page.evaluate(() => {
    const field = document.getElementById("lm-cognitive-field");
    const brain = document.getElementById("lm-cognitive-brain-mount");
    const col = document.getElementById("lm-cognitive-brain-col");
    const readout = document.getElementById("lm-cognitive-readout");
    const rail = document.getElementById("lm-mode-rail");
    const r = field?.getBoundingClientRect();
    const b = brain?.getBoundingClientRect();
    const colBox = col?.getBoundingClientRect();
    const ro = readout?.getBoundingClientRect();
    const railBox = rail?.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const mobile = vw <= 767;
    const readoutPos = readout ? getComputedStyle(readout).position : "";
    return {
      mobile,
      widthRatio: r ? r.width / vw : 0,
      heightRatio: r ? r.height / vh : 0,
      marginLeftRatio: r ? r.left / vw : 0,
      marginRightRatio: r ? (vw - r.right) / vw : 0,
      centerXRatio: r ? (r.left + r.right) / 2 / vw : 0,
      aboveRail: !!(r && railBox && r.bottom <= railBox.top + 12),
      verticalStack:
        mobile &&
        readoutPos === "absolute" &&
        !!ro &&
        !!r &&
        ro.top < r.bottom - 24,
      horizontalLayout:
        !mobile &&
        readoutPos === "absolute" &&
        !!ro &&
        !!r &&
        ro.left >= r.left + r.width * 0.52,
      stageWidth: r?.width ?? 0,
      stageHeight: r?.height ?? 0,
    };
  });
}

function stageProportionsOk(bbox) {
  if (!bbox?.aboveRail) return false;
  if (bbox.mobile) {
    return (
      near(bbox.widthRatio, 0.8, 0.07) &&
      near(bbox.marginLeftRatio, 0.1, 0.07) &&
      near(bbox.marginRightRatio, 0.1, 0.07) &&
      near(bbox.centerXRatio, 0.5, 0.04) &&
      bbox.heightRatio >= 0.58 &&
      bbox.heightRatio <= 0.86 &&
      bbox.verticalStack
    );
  }
  return (
    near(bbox.widthRatio, 0.6, 0.07) &&
    near(bbox.marginLeftRatio, 0.2, 0.07) &&
    near(bbox.marginRightRatio, 0.2, 0.07) &&
    near(bbox.centerXRatio, 0.5, 0.04) &&
    bbox.horizontalLayout
  );
}

async function mobilePortraitHudMetrics(page) {
  await selectMode(page, "home");
  return page.evaluate((skipIds) => {
    const skip = new Set(skipIds);
    const backdropHits = [];
    const filterBlurHits = [];
    const plane = document.getElementById("lm-suit-hud-plane");
    if (plane) {
      plane.querySelectorAll("*").forEach((el) => {
        if (skip.has(el.id) || [...el.classList].some((c) => skip.has(c))) return;
        const tag = el.tagName;
        if (tag === "VIDEO" || tag === "CANVAS" || tag === "IMG" || tag === "SVG") return;
        const cs = getComputedStyle(el);
        const bd = cs.backdropFilter || cs.webkitBackdropFilter || "";
        if (bd && bd !== "none") {
          backdropHits.push(el.id || el.className?.toString?.()?.slice(0, 40) || tag);
        }
        const fl = cs.filter || "";
        if (fl && fl !== "none" && fl.includes("blur")) {
          filterBlurHits.push(el.id || el.className?.toString?.()?.slice(0, 40) || tag);
        }
      });
    }
    const field = document.getElementById("lm-cognitive-field");
    const brain = document.getElementById("lm-cognitive-brain-mount");
    const readout = document.getElementById("lm-cognitive-readout");
    const rail = document.getElementById("lm-mode-rail");
    const f = field?.getBoundingClientRect();
    const b = brain?.getBoundingClientRect();
    const r = readout?.getBoundingClientRect();
    const railBox = rail?.getBoundingClientRect();
    const vw = window.innerWidth;
    const readoutPos = readout ? getComputedStyle(readout).position : "";
    const verticalStack =
      !!b && !!r && readoutPos !== "absolute" && r.top >= b.bottom - 6 && r.width >= vw * 0.55;
    const aboveRail = !!f && !!railBox && f.bottom <= railBox.top + 10;
    const brainWidthRatio = b ? b.width / vw : 0;
    const fieldCs = field ? getComputedStyle(field) : null;
    const fieldOverlayClear =
      fieldCs &&
      fieldCs.backgroundImage === "none" &&
      (fieldCs.backgroundColor === "rgba(0, 0, 0, 0)" || fieldCs.backgroundColor === "transparent");
    return {
      backdropHits,
      filterBlurHits,
      verticalStack,
      aboveRail,
      brainWidthRatio,
      brainWidth: b?.width ?? 0,
      readoutPosition: readoutPos,
      fieldOverlayClear,
      noHudBlur: backdropHits.length === 0 && filterBlurHits.length === 0,
    };
  }, [...HUD_SURFACE_SKIP]);
}


async function keyboardStepHud(page, key) {
  await page.keyboard.press(key);
  await page.waitForTimeout(400);
  return page.evaluate(() =>
    document.querySelector("#lm-mode-rail .lm-world-item.is-selected")?.getAttribute("data-dest"),
  );
}

async function runViewport(browser, tag, viewport, touch) {
  const ctx = await browser.newContext({ viewport, hasTouch: !!touch, isMobile: !!touch });
  const page = await ctx.newPage();
  await page.goto(`${base}/board`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#lm-suit-hud-plane.on", { timeout: 12_000 });
  mkdirSync(outDir, { recursive: true });
  const hist0 = await page.evaluate(() => history.length);
  const railBefore = await railLeftPositions(page);
  await page.evaluate(() => {
    const track = document.getElementById("lm-suit-hud-track");
    if (track) track.style.transform = "translate3d(-140px,0,0)";
  });
  const railDuring = await railLeftPositions(page);
  await page.evaluate(() => {
    const track = document.getElementById("lm-suit-hud-track");
    if (track) track.style.transform = "";
  });
  const shots = {};
  for (const mode of MODES) {
    await selectMode(page, mode);
    const st = await hudState(page);
    shots[mode] = st;
    await page.screenshot({ path: join(outDir, `qa-hud-mode-${tag}-${mode}.png`) });
  }
  await selectMode(page, "home");
  const histAfter = await page.evaluate(() => history.length);
  const railAfter = await railLeftPositions(page);
  const railStable =
    railBefore.length === railAfter.length &&
    railBefore.every((x, i) => Math.abs(x - railAfter[i]) < 2) &&
    railDuring.every((x, i) => Math.abs(x - railBefore[i]) < 2);
  const hudStage = await hudStageBBox(page);
  const railNav = await railNavVisualAudit(page);
  await selectMode(page, "home");
  const homeComposition = await homeHudCompositionAudit(page);
  const brainStability = await brainMountStabilityAudit(page);
  await page.screenshot({ path: join(outDir, `qa-home-hud-composition-${tag}.png`) });
  let touchSwipe = null;
  let mobilePortrait = null;
  if (touch) {
    mobilePortrait = await mobilePortraitHudMetrics(page);
    touchSwipe = await touchSwipeHudLeft(page);
  }
  let keyboardHud = null;
  if (!touch) {
    await selectMode(page, "home");
    const afterRight = await keyboardStepHud(page, "ArrowRight");
    const afterLeft = await keyboardStepHud(page, "ArrowLeft");
    keyboardHud = { afterRight, afterLeft, ok: afterRight === "yg3" && afterLeft === "home" };
  }
  await ctx.close();
  return {
    shots,
    railStable,
    homeHistoryDelta: histAfter - hist0,
    railBefore,
    railAfter,
    touchSwipe,
    keyboardHud,
    mobilePortrait,
    hudStage,
    stageProportionsOk: stageProportionsOk(hudStage),
    railNav,
    homeComposition,
    brainStability,
  };
}

async function main() {
  const { chromium, devices } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const mobileVp = { ...devices["iPhone 13"].viewport, width: 390, height: 844 };
  const mobile = await runViewport(browser, "390x844", mobileVp, true);
  const desktop = await runViewport(browser, "1280", { width: 1280, height: 900 }, false);
  const desktop984 = await runViewport(browser, "984x944", { width: 984, height: 944 }, false);
  const desktopUltra = await runViewport(
    browser,
    "1914x958",
    { width: 1914, height: 958 },
    false,
  );
  await browser.close();
  let liveBuild = null;
  try {
    const res = await fetch(`${base}/board`);
    const m = (await res.text()).match(/name="ground-board-build"\s+content="([^"]+)"/);
    liveBuild = m?.[1] ?? null;
  } catch {
    liveBuild = null;
  }
  let brainMediaHttp = null;
  try {
    const head = await fetch(`${base}/assets/life-mirror/brain-core-stock.mp4`, { method: "HEAD" });
    const range = await fetch(`${base}/assets/life-mirror/brain-core-stock.mp4`, {
      headers: { Range: "bytes=0-1023" },
    });
    brainMediaHttp = {
      status: head.status,
      contentType: head.headers.get("content-type"),
      acceptRanges: head.headers.get("accept-ranges"),
      rangeStatus: range.status,
      rangeBytes: range.headers.get("content-length"),
    };
  } catch {
    brainMediaHttp = null;
  }
  const report = { base, liveBuild, mobile, desktop, desktop984, desktopUltra, brainMediaHttp };
  console.log(JSON.stringify(report, null, 2));
  const fail = [];
  const check = (label, r) => {
    if (!r.railStable) fail.push(`${label}-rail-moved`);
    if (r.homeHistoryDelta > 0) fail.push(`${label}-home-history`);
    if (label === "mobile" && r.touchSwipe && !r.touchSwipe.ok) fail.push(`${label}-touch-swipe`);
    if (label === "desktop" && r.keyboardHud && !r.keyboardHud.ok) fail.push(`${label}-keyboard-hud`);
    if (!r.stageProportionsOk) fail.push(`${label}-stage-proportions`);
    if (!r.railNav?.railNavOk) fail.push(`${label}-rail-nav-visual`);
    if (!r.homeComposition?.homeCompositionOk) fail.push(`${label}-home-composition`);
    if (!r.brainStability?.brainMountStable) fail.push(`${label}-brain-mount-stable`);
    if (label === "mobile" && r.mobilePortrait) {
      const m = r.mobilePortrait;
      if (!m.noHudBlur) fail.push("mobile-hud-blur");
      if (!m.fieldOverlayClear) fail.push("mobile-field-overlay");
    }
    for (const mode of MODES) {
      const s = r.shots[mode];
      if (!s?.planeOn || s.focus !== mode || !s.readout || !s.roomHidden || s.worldHidden) {
        fail.push(`${label}-${mode}-hud`);
      }
    }
  };
  check("mobile", mobile);
  check("desktop", desktop);
  check("desktop984", desktop984);
  check("desktopUltra", desktopUltra);
  const v984 = desktop984.homeComposition?.visualScaleW ?? 0;
  const v128 = desktop.homeComposition?.visualScaleW ?? 0;
  const vUltra = desktopUltra.homeComposition?.visualScaleW ?? 0;
  const lit984 = desktop984.homeComposition?.brainLitScreenW ?? 0;
  const litUltra = desktopUltra.homeComposition?.brainLitScreenW ?? 0;
  if (v984 < 2.0) fail.push("desktop984-brain-scale-low");
  if (vUltra >= v128 - 0.06) fail.push("ultrawide-brain-not-capped");
  if (vUltra > 1.45) fail.push("ultrawide-brain-scale-high");
  if (lit984 > 0 && litUltra > 0 && litUltra > lit984 * 1.02) {
    fail.push("ultrawide-brain-silhouette-wider-than-984");
  }
  if (!brainMediaHttp || brainMediaHttp.status !== 200) fail.push("brain-mp4-http");
  if (brainMediaHttp && brainMediaHttp.rangeStatus !== 206 && brainMediaHttp.rangeStatus !== 200) {
    fail.push("brain-mp4-range");
  }
  if (!mobile.homeComposition?.brainVisible || !desktop.homeComposition?.brainVisible) {
    fail.push("brain-not-visible");
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
