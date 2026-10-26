import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { startRelay } from "./server.js";
import type { RelayConfig } from "./config.js";
import { FICTION_BUSINESS_NAME } from "./board-extensions/public-demo.js";

const port = 28799;
const baseUrl = `http://127.0.0.1:${port}`;

function publicCfg(): RelayConfig {
  const root = join(process.cwd(), ".vitest-tmp", "board-public-playwright");
  mkdirSync(root, { recursive: true });
  return {
    host: "127.0.0.1",
    port,
    publicBaseUrl: baseUrl,
    jwtSecret: "test-jwt-secret-at-least-32-chars-long!!",
    workerToken: "test-worker-token-at-least-24c",
    ownerId: "owner-test",
    ownerApprovalSecret: "approval-secret-test",
    boardViewSecret: "approval-secret-test",
    boardPublicReadOnly: true,
    boardUnlockPasswordHash: null,
    allowDevToken: false,
    dataDir: join(root, "relay-data"),
    publicRepoUrl: "https://github.com/YG3-ai/ground-control",
    publicDonationUrl: null,
  };
}

describe("public board experience (playwright)", () => {
  let relay: Awaited<ReturnType<typeof startRelay>>;
  let browser: Browser;

  beforeAll(async () => {
    relay = await startRelay(publicCfg());
    browser = await chromium.launch({ headless: true });
  }, 45_000);

  afterAll(async () => {
    await browser?.close();
    await relay?.close();
  });

  it("shows fictional demo hero and install CTA without donation when unset", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`${baseUrl}/board`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector("#lm-public-hero", { state: "visible", timeout: 20_000 });
    const badge = await page.locator(".lm-public-hero-badge").textContent();
    expect(badge || "").toMatch(/demo data/i);
    const heroText = await page.locator("#lm-public-hero").innerText();
    expect(heroText).toContain("Ground Control");
    expect(heroText).toContain("Install on Mac");
    const donateHidden = await page.evaluate(() => {
      const el = document.getElementById("lm-public-donate-hero");
      return !el || el.hidden;
    });
    expect(donateHidden).toBe(true);
    const boardRes = await fetch(`${baseUrl}/api/board`);
    expect(boardRes.status).toBe(200);
    const boardJson = (await boardRes.json()) as {
      owner?: { display_name?: string };
      public_preview?: boolean;
    };
    expect(boardJson.public_preview).toBe(true);
    expect(boardJson.owner?.display_name).toBe(FICTION_BUSINESS_NAME);
    await page.close();
  });

  it("swipes suit HUD to YG3 and shows growth metrics offline", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`${baseUrl}/board`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector("#lm-world-chip-yg3", { timeout: 20_000 });
    await page.click("#lm-world-chip-yg3");
    await page.waitForFunction(
      () => {
        const el = document.getElementById("lm-mode-yg3-signals");
        return el && el.querySelector(".lm-yg3-metric");
      },
      { timeout: 20_000 },
    );
    await page.close();
  });

  it("public POST to yg3 sync does not trigger writes", async () => {
    const res = await fetch(`${baseUrl}/api/board/extensions/yg3-sync/trigger`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  it("respects reduced motion (no world live video forced on)", async () => {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      reducedMotion: "reduce",
    });
    await page.goto(`${baseUrl}/board`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const liveDisplay = await page.evaluate(() => {
      const v = document.getElementById("lm-world-live");
      return v ? getComputedStyle(v).display : "none";
    });
    expect(liveDisplay).toBe("none");
    await page.close();
  });

  it("logged-out public shell hides owner mark and duplicate install chip on mobile", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`${baseUrl}/board`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector("#lm-public-hero", { state: "visible", timeout: 20_000 });
    const chrome = await page.evaluate(() => {
      const mark = document.getElementById("lm-mark");
      const persist = document.getElementById("lm-public-install-persist");
      const app = document.getElementById("app");
      return {
        markHidden: !mark || mark.hidden || getComputedStyle(mark).display === "none",
        publicShell: app?.classList.contains("lm-public-shell") === true,
        persistHidden: !persist || persist.hidden,
      };
    });
    expect(chrome.publicShell).toBe(true);
    expect(chrome.markHidden).toBe(true);
    expect(chrome.persistHidden).toBe(true);
    await page.screenshot({ path: "/tmp/ground-control-repair-public-mobile-390x844.png" });
    await page.close();
  });

  it("Sign in CTA is hit-testable and opens unlock gate", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
    await page.goto(`${baseUrl}/board`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector("#lm-public-signin-hero", { state: "visible", timeout: 20_000 });
    const centerHit = await page.evaluate(() => {
      const btn = document.getElementById("lm-public-signin-hero");
      if (!btn) return false;
      const r = btn.getBoundingClientRect();
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return el === btn || Boolean(el && btn.contains(el));
    });
    expect(centerHit).toBe(true);
    await page.locator("#lm-public-signin-hero").tap();
    await page.waitForFunction(
      () => {
        const g = document.getElementById("gate");
        return g && getComputedStyle(g).display !== "none";
      },
      { timeout: 10_000 },
    );
    await page.close();
  });

  it("install CTA uses configured repo URL", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`${baseUrl}/board`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector("#lm-public-install-hero", { state: "visible", timeout: 20_000 });
    const opened = await page.evaluate(() => {
      var captured = "";
      var prev = window.open;
      window.open = function (url) {
        captured = String(url || "");
        return null;
      };
      document.getElementById("lm-public-install-hero")?.click();
      window.open = prev;
      return captured;
    });
    expect(opened).toMatch(/^https:\/\/github\.com\//);
    await page.close();
  });
});
