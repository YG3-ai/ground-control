import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { startRelay } from "./server.js";
import type { RelayConfig } from "./config.js";

const html = readFileSync(join(import.meta.dirname, "board.html"), "utf8");

describe("ground control repair markers (board.html)", () => {
  it("isolates vertical list scrolling from global HUD swipe", () => {
    expect(html).toContain("overscroll-behavior: contain");
    expect(html).toMatch(/\.lm-mode-scroll[\s\S]*touch-action:\s*pan-y/);
    expect(html).toContain(".lm-public-hero, .lm-mode-hud, .lm-mode-scroll");
  });

  it("badge counts pending approvals only", () => {
    const block = html.match(/function syncSpatialAlerts[\s\S]*?}\s*function/)?.[0] ?? "";
    expect(block).toContain("var n = approvalN");
    expect(block).not.toMatch(/approvalN \+ lifeN/);
    expect(block).toContain("pending approval");
  });

  it("persist back label remains Back", () => {
    expect(html).toContain('<span class="lm-back-label">Back</span>');
  });
});

describe("ground control repair (playwright)", () => {
  const port = 28793;
  const baseUrl = `http://127.0.0.1:${port}`;
  let relay: Awaited<ReturnType<typeof startRelay>>;
  let browser: Browser;

  beforeAll(async () => {
    const root = join(process.cwd(), ".vitest-tmp", "board-gc-repair");
    mkdirSync(root, { recursive: true });
    relay = await startRelay({
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
    });
    browser = await chromium.launch({ headless: true });
  }, 45_000);

  afterAll(async () => {
    await browser?.close();
    await relay?.close();
  });

  it("Sign in hero receives center tap (elementFromPoint + Playwright tap)", async () => {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
    });
    await page.goto(`${baseUrl}/board`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector("#lm-public-signin-hero", { state: "visible", timeout: 20_000 });
    const hit = await page.evaluate(() => {
      const btn = document.getElementById("lm-public-signin-hero");
      if (!btn) return { id: null, ancestry: [] };
      const r = btn.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const top = document.elementFromPoint(cx, cy);
      const ancestry: string[] = [];
      let el: Element | null = top;
      while (el) {
        ancestry.push(el.id ? `${el.tagName}#${el.id}` : el.tagName);
        if (el === btn) break;
        el = el.parentElement;
      }
      return { id: top ? (top as HTMLElement).id || top.tagName : null, ancestry, hitsButton: top === btn || ancestry[0] === "BUTTON#lm-public-signin-hero" };
    });
    expect(hit.hitsButton || hit.ancestry.some((a) => a === "BUTTON#lm-public-signin-hero")).toBe(true);
    await page.locator("#lm-public-signin-hero").tap({ force: false });
    await page.waitForFunction(
      () => {
        const g = document.getElementById("gate");
        return g && getComputedStyle(g).display !== "none";
      },
      { timeout: 10_000 },
    );
    await page.close();
  });

  it("YG3 accounts list does not widen document on horizontal drag", async () => {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
    });
    await page.goto(`${baseUrl}/board`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.locator("#lm-world-chip-yg3").tap();
    await page.waitForSelector("#lm-yg3-accounts-feed", { timeout: 20_000 });
    const before = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const box = await page.locator("#lm-yg3-accounts-feed").boundingBox();
    if (box) {
      const y = box.y + Math.min(box.height / 2, 120);
      await page.mouse.move(box.x + box.width / 2, y);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 - 80, y, { steps: 6 });
      await page.mouse.up();
    }
    const after = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(before).toBeLessThanOrEqual(1);
    expect(after).toBeLessThanOrEqual(1);
    expect(
      await page.evaluate(
        () => document.getElementById("lm-world-chip-yg3")?.getAttribute("aria-selected") === "true",
      ),
    ).toBe(true);
    await page.close();
  });
});
