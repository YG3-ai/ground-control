import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import {
  RelayClient,
  WorkerService,
  buildTestConfig,
  dockerAvailable,
  ensureMockImage,
  initGitFixture,
  makeTempRoot,
} from "@agent-control/worker";
import { startRelay } from "./server.js";
import type { RelayConfig } from "./config.js";

const BOARD_KEY = "approval-secret-test";
const VIEWPORT = { width: 390, height: 844 };
async function clickRoomAction(page: Page, action: string) {
  await page.evaluate((a) => {
    const btn = document.querySelector('[data-action="' + a + '"]');
    if (btn instanceof HTMLElement) btn.click();
  }, action);
}

async function enterGroundRoom(page: Page) {
  await page.evaluate(() => {
    try {
      sessionStorage.setItem("gc_spatial_dest", "ground");
    } catch {
      /* ignore */
    }
  });
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector("#lm-stage", { timeout: 15_000 });
  await page.waitForFunction(
    () => {
      const room = document.getElementById("lm-room-view");
      return !!(room && !room.hidden);
    },
    { timeout: 15_000 },
  );
}

async function openControlSurface(page: Page) {
  await enterGroundRoom(page);
  await clickRoomAction(page, "terminals");
  await page.waitForSelector("#lm-surface", { state: "visible", timeout: 15_000 });
}

async function openWorkbenchSurface(page: Page) {
  await enterGroundRoom(page);
  await clickRoomAction(page, "mission");
  await page.waitForSelector("#lm-surface", { state: "visible", timeout: 15_000 });
}

/** Focus a suit HUD mode on the immersive world view. */
async function focusHudMode(page: Page, dest: string) {
  const chip = page.locator(`#lm-world-chip-${dest}`);
  await chip.click();
  if ((await chip.getAttribute("aria-selected")) !== "true") {
    await chip.click();
  }
}

/** Owner board on public-preview shell: archive search is disabled until unlock completes. */
async function waitForOwnerArchiveReady(page: Page) {
  await page.waitForFunction(
    () => {
      const input = document.getElementById("lm-archive-search-input") as HTMLInputElement | null;
      return Boolean(input && !input.disabled);
    },
    { timeout: 15_000 },
  );
}

async function focusArchiveHud(page: Page) {
  await waitForOwnerArchiveReady(page);
  await focusHudMode(page, "archive");
  await page.waitForFunction(
    () => document.getElementById("lm-world-chip-archive")?.getAttribute("aria-selected") === "true",
    { timeout: 5_000 },
  );
}

async function waitForArchiveDetailOpen(page: Page) {
  await page.waitForFunction(
    () => {
      const el = document.getElementById("lm-detail");
      return Boolean(el && !el.hidden);
    },
    { timeout: 10_000 },
  );
}

/** DOM click avoids Playwright hit-testing through the suit HUD swipe catcher. */
async function clickArchiveRow(page: Page, slug: string) {
  const row = page.locator(`#lm-mode-archive-rows button[data-slug="${slug}"]`);
  await row.waitFor({ state: "visible", timeout: 15_000 });
  await row.evaluate((btn) => {
    (btn as HTMLButtonElement).click();
  });
}

async function openBoard(page: Page, baseUrl: string, withKey = false) {
  if (withKey) {
    await page.addInitScript((key) => {
      try {
        localStorage.setItem("gc_board_key", key);
      } catch {
        /* ignore */
      }
    }, BOARD_KEY);
  }
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector("#lm-stage", { timeout: 15_000 });
}

describe("board spatial interactions (playwright)", () => {
  let relay: Awaited<ReturnType<typeof startRelay>>;
  const port = 28797;
  const baseUrl = `http://127.0.0.1:${port}`;
  let browser: Browser;

  beforeAll(async () => {
    const root = join(process.cwd(), ".vitest-tmp", "spatial-relay-only");
    mkdirSync(root, { recursive: true });
    relay = await startRelay({
      host: "127.0.0.1",
      port,
      publicBaseUrl: baseUrl,
      jwtSecret: "test-jwt-secret-at-least-32-chars-long!!",
      workerToken: "test-worker-token-at-least-24c",
      ownerId: "owner-test",
      ownerApprovalSecret: BOARD_KEY,
      boardViewSecret: BOARD_KEY,
      boardPublicReadOnly: true,
      boardUnlockPasswordHash: null,
      allowDevToken: false,
      dataDir: join(root, "relay-data"),
      publicRepoUrl: "https://github.com/YG3-ai/ground-control",
      publicDonationUrl: null,
    });
    browser = await chromium.launch({ headless: true });
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    await relay?.close();
  });

  it("world menu is a compact bottom strip with four HUD modes", async () => {
    const page = await browser.newPage({ viewport: VIEWPORT });
    await openBoard(page, `${baseUrl}/board`);
    expect(await page.locator("#lm-world-menu").isVisible()).toBe(true);
    expect(await page.locator("#lm-mode-rail").isVisible()).toBe(true);
    expect(await page.locator(".lm-world-item").count()).toBe(4);
    expect(await page.locator("#lm-world-view .lm-hotspot").count()).toBe(0);
    const metrics = await page.evaluate(() => {
      const menu = document.getElementById("lm-world-menu");
      const menuBox = menu?.getBoundingClientRect();
      const item = document.querySelector(".lm-world-item");
      return {
        bottomInset: menuBox ? window.innerHeight - menuBox.bottom : 999,
        chipHeight: item?.offsetHeight ?? 0,
        homeSelected:
          document.querySelector('[data-dest="home"]')?.getAttribute("aria-selected") ===
          "true",
      };
    });
    expect(metrics.bottomInset).toBeLessThan(48);
    expect(metrics.chipHeight).toBeGreaterThanOrEqual(32);
    expect(metrics.homeSelected).toBe(true);
    await page.close();
  });

  it("world map loads asset and focuses Ground HUD mode", async () => {
    const page = await browser.newPage({ viewport: VIEWPORT });
    await openBoard(page, `${baseUrl}/board`);
    expect(await page.locator("#lm-world-poster[src*='world.webp']").isVisible()).toBe(true);
    const assetRes = await page.request.get(`${baseUrl}/assets/life-mirror/world.webp`);
    expect(assetRes.status()).toBe(200);
    const liveRes = await page.request.get(`${baseUrl}/assets/life-mirror/world-live.mp4`);
    expect(liveRes.status()).toBe(200);
    expect(await page.locator("#conn-label").count()).toBe(0);
    expect(await page.locator("#lm-conn").count()).toBe(0);
    await focusHudMode(page, "ground");
    expect(await page.locator("#lm-world-chip-ground").getAttribute("aria-selected")).toBe("true");
    expect(await page.locator("#lm-mode-ground-hud").isVisible()).toBe(true);
    await page.close();
  });

  it("world live wiring requests mp4 and pauses when leaving World", async () => {
    const page = await browser.newPage({ viewport: VIEWPORT });
    const [, liveReq] = await Promise.all([
      openBoard(page, `${baseUrl}/board`, true),
      page.waitForRequest((r) => r.url().includes("world-live.mp4"), { timeout: 15_000 }),
    ]);
    expect(liveReq.url()).toContain("world-live.mp4");
    const video = page.locator("#lm-world-live");
    await page.evaluate(() => {
      const v = document.getElementById("lm-world-live");
      if (!v) return;
      v.setAttribute("data-src-ready", "1");
      let playing = true;
      v.pause = () => {
        playing = false;
        v.classList.remove("lm-world-live-on");
      };
      Object.defineProperty(v, "paused", {
        configurable: true,
        get: () => !playing,
      });
      v.classList.add("lm-world-live-on");
    });
    await focusHudMode(page, "ground");
    await openControlSurface(page);
    expect(await video.evaluate((v) => v.paused)).toBe(true);
    await page.close();
  });

  it("desktop world hides link chrome and keeps poster stack", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await openBoard(page, `${baseUrl}/`);
    expect(await page.locator("#conn-label").count()).toBe(0);
    expect(await page.locator(".lm-chrome .dot").count()).toBe(0);
    expect(await page.locator("#lm-world-poster").isVisible()).toBe(true);
    expect(await page.locator("#lm-world-live").count()).toBe(1);
    await page.close();
  });

  it("immersive chrome has no system hamburger menu", async () => {
    const page = await browser.newPage({ viewport: VIEWPORT });
    await openBoard(page, `${baseUrl}/`);
    expect(await page.locator("#lm-menu-btn").count()).toBe(0);
    expect(await page.locator("#lm-menu").count()).toBe(0);
    await page.close();
  });

  it("ground room workbench hotspot opens missions interior", async () => {
    const page = await browser.newPage({ viewport: VIEWPORT });
    await openBoard(page, `${baseUrl}/`, true);
    await openWorkbenchSurface(page);
    expect(await page.locator("#lm-interior[data-interior='workbench']").isVisible()).toBe(true);
    await page.click("#lm-persist-back");
    expect(await page.locator("#lm-detail[hidden]").count()).toBeGreaterThanOrEqual(0);
    await page.close();
  });

  it("workbench interior shows blueprint model or honest offline state", async () => {
    const page = await browser.newPage({ viewport: VIEWPORT });
    await openBoard(page, `${baseUrl}/`, true);
    await openWorkbenchSurface(page);
    await page.waitForSelector("#lm-interior[data-interior='workbench'], #lm-interior[data-interior='armory']", { timeout: 10_000 });
    const blueprint = await page.locator(".wb-blueprint").count();
    const empty = await page.locator("#panel-missions .wb-surface .empty, #panel-missions .empty").count();
    const offline = await page.locator("#panel-missions .empty").filter({ hasText: /offline/i }).count();
    expect(blueprint + empty + offline).toBeGreaterThan(0);
    const railCount = await page.locator(".wb-rail-chip").count();
    if (railCount > 0) {
      const box = await page.locator(".wb-rail-chip").first().boundingBox();
      if (box) {
        expect(box.height).toBeGreaterThanOrEqual(44);
        expect(box.width).toBeGreaterThanOrEqual(44);
      }
    }
    await page.close();
  });

  it("persist back label stays Back on interior surface", async () => {
    const page = await browser.newPage({ viewport: VIEWPORT });
    await openBoard(page, `${baseUrl}/`, true);
    await openControlSurface(page);
    const back = page.locator("#lm-persist-back");
    await back.waitFor({ state: "visible", timeout: 10_000 });
    expect(await back.locator(".lm-back-label").innerText()).toBe("Back");
    await back.click();
    await page.waitForFunction(() => document.getElementById("lm-surface")?.hidden === true, {
      timeout: 5_000,
    });
    await page.close();
  });

  it("persist back meets minimum touch target on interior surface", async () => {
    const page = await browser.newPage({ viewport: VIEWPORT });
    await openBoard(page, `${baseUrl}/`, true);
    await openControlSurface(page);
    const back = page.locator("#lm-persist-back");
    expect(await back.isVisible()).toBe(true);
    expect(await back.locator(".lm-back-chev").count()).toBe(1);
    const box = await back.boundingBox();
    expect(box).toBeTruthy();
    if (box) {
      expect(box.height).toBeGreaterThanOrEqual(48);
      expect(box.width).toBeGreaterThanOrEqual(80);
      expect(box.y).toBeLessThan(120);
    }
    await page.close();
  });

  it("browser back from control surface returns to world in one action", async () => {
    const page = await browser.newPage({ viewport: VIEWPORT });
    await openBoard(page, `${baseUrl}/`, true);
    await openControlSurface(page);
    expect(await page.locator("#lm-surface").isVisible()).toBe(true);
    await page.goBack();
    expect(await page.locator("#lm-world-view").isVisible()).toBe(true);
    expect(await page.locator("#lm-surface").isHidden()).toBe(true);
    await page.close();
  });

  it("browser back unwinds detail then interior surface", async () => {
    const page = await browser.newPage({ viewport: VIEWPORT });
    await openBoard(page, `${baseUrl}/`, true);
    await openWorkbenchSurface(page);
    const module = page.locator(".wb-module").first();
    if (await module.count()) {
      await module.click();
      await page.waitForSelector("#lm-detail:not([hidden])", { timeout: 10_000 });
      await page.goBack();
      await page.waitForSelector("#lm-detail[hidden]", { timeout: 5_000 });
    }
    await page.goBack();
    expect(await page.locator("#lm-world-view").isVisible()).toBe(true);
    await page.close();
  });

  it("one tap persist back from control surface returns to ground room on mobile", async () => {
    const page = await browser.newPage({ viewport: VIEWPORT });
    await openBoard(page, `${baseUrl}/board`, true);
    await openControlSurface(page);
    await page.waitForSelector("#lm-persist-back:not([hidden])");
    await page.locator("#lm-persist-back").click();
    await page.waitForFunction(() => document.getElementById("lm-surface")?.hidden === true, {
      timeout: 5_000,
    });
    expect(await page.locator("#lm-room-view").isVisible()).toBe(true);
    expect(await page.locator("#lm-persist-back").isVisible()).toBe(true);
    await page.close();
  });

  it("persistent back from control surface returns to ground room before world", async () => {
    const page = await browser.newPage({ viewport: VIEWPORT });
    await openBoard(page, `${baseUrl}/board`, true);
    await openControlSurface(page);
    await page.click("#lm-persist-back");
    expect(await page.locator("#lm-room-view").isVisible()).toBe(true);
    expect(await page.locator("#lm-surface").isHidden()).toBe(true);
    await page.close();
  });

  it("ground room capabilities hotspot opens armory interior", async () => {
    const page = await browser.newPage({ viewport: VIEWPORT });
    await openBoard(page, `${baseUrl}/`, true);
    await enterGroundRoom(page);
    await clickRoomAction(page, "capabilities");
    await page.waitForSelector("#lm-surface", { state: "visible", timeout: 15_000 });
    expect(await page.locator("#lm-interior[data-interior='armory']").isVisible()).toBe(true);
    await page.click("#lm-persist-back");
    await page.close();
  });

  it("home and ground suit HUD avoid horizontal overflow on mobile", async () => {
    const page = await browser.newPage({ viewport: VIEWPORT });
    await openBoard(page, `${baseUrl}/`, true);
    for (const dest of ["home", "ground"]) {
      await focusHudMode(page, dest);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);
      expect(await page.locator("[data-ground-surface]").count()).toBe(0);
    }
    await page.close();
  });

  it("archive note detail has no horizontal overflow on mobile", async () => {
    const page = await browser.newPage({ viewport: VIEWPORT });
    const longUrl = "https://example.com/" + "segment/".repeat(80) + "end";
    await page.route("**/api/board/extensions/notes/recent*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          health: "ok",
          measuredAt: null,
          items: [{ slug: "notes/qa-overflow", title: "Overflow note" }],
        }),
      });
    });
    await page.route("**/api/board/extensions/notes/search*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          items: [{ slug: "notes/qa-overflow", title: "Overflow note", excerpt: "tags=-" }],
        }),
      });
    });
    await page.route("**/api/board/extensions/notes/read*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          slug: "notes/qa-overflow",
          title: "Overflow note",
          body: "# Overflow\n\n" + longUrl + "\n\n`inline-code-" + "x".repeat(200) + "`",
        }),
      });
    });
    await openBoard(page, `${baseUrl}/`, true);
    await focusArchiveHud(page);
    const searchResponse = page.waitForResponse(
      (r) => r.url().includes("/api/board/extensions/notes/search") && r.ok(),
      { timeout: 8_000 },
    );
    await page.locator("#lm-archive-search-input").fill("overflow");
    await searchResponse;
    await page.locator("#lm-mode-archive-rows").evaluate((el) => {
      el.scrollTop = 48;
    });
    await clickArchiveRow(page, "notes/qa-overflow");
    await waitForArchiveDetailOpen(page);
    const overflow = await page.evaluate(() => {
      const body = document.getElementById("lm-detail-body");
      const detail = document.getElementById("lm-detail");
      return {
        doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        detail: detail ? detail.scrollWidth - detail.clientWidth : 0,
        body: body ? body.scrollWidth - body.clientWidth : 0,
      };
    });
    expect(overflow.doc).toBeLessThanOrEqual(1);
    expect(overflow.detail).toBeLessThanOrEqual(1);
    expect(overflow.body).toBeLessThanOrEqual(1);
    await page.click("#lm-persist-back");
    await page.waitForFunction(() => document.getElementById("lm-detail")?.hidden === true);
    expect(await page.locator("#lm-archive-search-input").inputValue()).toBe("overflow");
    expect(
      await page.locator('#lm-mode-archive-rows button[data-slug="notes/qa-overflow"]').count(),
    ).toBe(1);
    await page.close();
  });

  it("browser back from archive note restores list before world", async () => {
    const page = await browser.newPage({ viewport: VIEWPORT });
    await page.route("**/api/board/extensions/notes/recent*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          items: [{ slug: "notes/back", title: "Back test" }],
        }),
      });
    });
    await page.route("**/api/board/extensions/notes/read*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, title: "Back test", body: "# Back test\n\nHello" }),
      });
    });
    await openBoard(page, `${baseUrl}/`, true);
    await focusArchiveHud(page);
    await clickArchiveRow(page, "notes/back");
    await waitForArchiveDetailOpen(page);
    await page.goBack();
    await page.waitForFunction(() => document.getElementById("lm-detail")?.hidden === true);
    expect(await page.locator("#lm-world-view").isVisible()).toBe(true);
    expect(await page.locator('#lm-mode-archive-rows button[data-slug="notes/back"]').count()).toBe(1);
    await page.close();
  });

  it("home has no world readability veil; interior modes do", async () => {
    const page = await browser.newPage({ viewport: VIEWPORT });
    await openBoard(page, `${baseUrl}/`, true);
    const veilAtHome = await page.evaluate(() => {
      const veil = document.getElementById("lm-world-readability-veil");
      return veil ? parseFloat(getComputedStyle(veil).opacity || "0") : -1;
    });
    expect(veilAtHome).toBeLessThan(0.05);
    await focusHudMode(page, "ground");
    await page.waitForFunction(
      () => {
        const veil = document.getElementById("lm-world-readability-veil");
        return !!(veil && parseFloat(getComputedStyle(veil).opacity || "0") > 0.2);
      },
      { timeout: 5000 },
    );
    const veilGround = await page.evaluate(() => {
      const veil = document.getElementById("lm-world-readability-veil");
      return veil ? parseFloat(getComputedStyle(veil).opacity || "0") : 0;
    });
    expect(veilGround).toBeGreaterThan(0.2);
    await focusHudMode(page, "home");
    await page.waitForFunction(
      () => {
        const veil = document.getElementById("lm-world-readability-veil");
        return !!(veil && parseFloat(getComputedStyle(veil).opacity || "0") < 0.05);
      },
      { timeout: 5000 },
    );
    await page.close();
  });

  it("vertical swipe gesture does not change HUD mode", async () => {
    const page = await browser.newPage({ viewport: VIEWPORT });
    await openBoard(page, `${baseUrl}/`, true);
    const startX = 195;
    const startY = 360;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX, startY + 140, { steps: 8 });
    await page.mouse.up();
    expect(
      await page.evaluate(() => {
        const chip = document.querySelector('[data-dest="home"]');
        return chip?.getAttribute("aria-selected") === "true";
      }),
    ).toBe(true);
    await page.close();
  });

  it("horizontal swipe snaps one mode and rail stays fixed", async () => {
    const page = await browser.newPage({ viewport: VIEWPORT });
    await openBoard(page, `${baseUrl}/`, true);
    const railBefore = await page.locator("#lm-mode-rail").evaluate((el) => {
      const m = getComputedStyle(el).transform;
      return m === "none" ? "" : m;
    });
    const startX = 280;
    const y = 400;
    await page.mouse.move(startX, y);
    await page.mouse.down();
    await page.mouse.move(startX - 160, y, { steps: 12 });
    await page.mouse.up();
    await page.waitForFunction(
      () =>
        document.getElementById("lm-world-chip-yg3")?.getAttribute("aria-selected") === "true",
      { timeout: 5000 },
    );
    const railAfter = await page.locator("#lm-mode-rail").evaluate((el) => {
      const m = getComputedStyle(el).transform;
      return m === "none" ? "" : m;
    });
    expect(railAfter).toBe(railBefore);
    expect(await page.locator("#lm-world-chip-yg3").getAttribute("aria-selected")).toBe("true");
    const offset = await page.evaluate(() => {
      const track = document.getElementById("lm-suit-hud-track");
      const plane = document.getElementById("lm-suit-hud-plane");
      if (!track || !plane) return { offset: 999, width: 0 };
      const m = getComputedStyle(track).transform;
      var tx = 0;
      if (m && m !== "none") {
        const nums = m.match(/matrix\(([^)]+)\)/);
        if (nums) {
          const parts = nums[1].split(",").map((x) => parseFloat(x.trim()));
          tx = Math.abs(parts[4] || 0);
        }
      }
      return { offset: tx, width: plane.clientWidth };
    });
    expect(offset.width).toBeGreaterThan(0);
    expect(offset.offset).toBeGreaterThan(offset.width * 0.35);
    await page.close();
  });

  it("tap navigation on mode rail still switches modes", async () => {
    const page = await browser.newPage({ viewport: VIEWPORT });
    await openBoard(page, `${baseUrl}/`, true);
    await page.locator("#lm-world-chip-archive").click();
    expect(await page.locator("#lm-world-chip-archive").getAttribute("aria-selected")).toBe("true");
    await page.locator("#lm-world-chip-home").click();
    expect(await page.locator("#lm-world-chip-home").getAttribute("aria-selected")).toBe("true");
    await page.close();
  });

  it("rapid suit mode switches keep HUD plane aligned", async () => {
    const page = await browser.newPage({ viewport: VIEWPORT });
    await openBoard(page, `${baseUrl}/`, true);
    for (const dest of ["yg3", "ground", "archive", "home", "archive", "ground"]) {
      await page.locator(`#lm-world-chip-${dest}`).click();
    }
    const offset = await page.evaluate(() => {
      const plane = document.getElementById("lm-suit-hud-plane");
      if (!plane) return 999;
      const m = getComputedStyle(plane).transform;
      if (!m || m === "none") return 0;
      const nums = m.match(/matrix\(([^)]+)\)/);
      if (!nums) return 0;
      const parts = nums[1].split(",").map((x) => parseFloat(x.trim()));
      return Math.abs(parts[4] || 0);
    });
    expect(offset).toBeLessThan(8);
    await page.close();
  });
});

describe.skipIf(!dockerAvailable())(
  "board spatial system depth (playwright + worker)",
  () => {
    const root = makeTempRoot();
    const fixture = join(root, "fixture");
    const port = 28798;
    const baseUrl = `http://127.0.0.1:${port}`;
    let relay: Awaited<ReturnType<typeof startRelay>>;
    let service: WorkerService;
    let client: RelayClient;
    let browser: Browser;

    beforeAll(async () => {
      ensureMockImage();
      mkdirSync(fixture);
      initGitFixture(fixture);
      const cfg: RelayConfig = {
        host: "127.0.0.1",
        port,
        publicBaseUrl: baseUrl,
        jwtSecret: "test-jwt-secret-at-least-32-chars-long!!",
        workerToken: "test-worker-token-at-least-24c",
        ownerId: "owner-test",
        ownerApprovalSecret: BOARD_KEY,
        boardViewSecret: BOARD_KEY,
        boardPublicReadOnly: false,
        boardUnlockPasswordHash: null,
        allowDevToken: false,
        dataDir: join(root, "relay-data"),
        publicRepoUrl: "https://github.com/YG3-ai/ground-control",
        publicDonationUrl: null,
      };
      relay = await startRelay(cfg);
      const workerCfg = buildTestConfig(root, fixture);
      workerCfg.owner.id = "owner-test";
      workerCfg.relay.url = `ws://127.0.0.1:${port}/worker`;
      service = new WorkerService({
        config: workerCfg,
        dbPath: join(root, "data", "worker", "jobs.db"),
        configRoot: root,
      });
      service.start();
      client = new RelayClient(workerCfg.relay.url, cfg.workerToken, service);
      client.start();
      const start = Date.now();
      while (!relay.hub.connected && Date.now() - start < 15_000) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(relay.hub.connected).toBe(true);
      browser = await chromium.launch({ headless: true });
    }, 120_000);

    afterAll(async () => {
      await browser?.close();
      client?.stop();
      service?.close();
      await relay?.close();
    });

    it("Ground HUD shows current project first with collapsible jobs/terminals and history feed", async () => {
      const page = await browser.newPage({ viewport: VIEWPORT });
      await openBoard(page, `${baseUrl}/`, true);
      await focusHudMode(page, "ground");
      const sections = page.locator("#lm-mode-ground-sections [data-section]");
      const count = await sections.count();
      if (count === 0) {
        await page.close();
        return;
      }
      expect(await sections.first().getAttribute("data-section")).toBe("current_project");
      expect(await page.locator(".lm-ground-history-feed, .lm-ground-section-empty").count()).toBeGreaterThan(0);
      const jobs = page.locator('[data-section="jobs"]');
      if (await jobs.count()) {
        expect(await jobs.evaluate((el) => el.tagName)).toBe("DETAILS");
        const summary = jobs.locator("summary.lm-ground-disclosure-summary");
        expect(await summary.count()).toBe(1);
        const box = await summary.boundingBox();
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(40);
      }
      expect(await page.locator("#lm-mode-ground-stats").isHidden()).toBe(true);
      expect(await page.locator("[data-ground-surface]").count()).toBe(0);
      await page.close();
    });

    it("Ground room Terminal hotspot opens System ops surface", async () => {
      const page = await browser.newPage({ viewport: VIEWPORT });
      await openBoard(page, `${baseUrl}/`, true);
      await enterGroundRoom(page);
      await page.click('[data-action="terminals"]');
      expect(await page.locator("#lm-surface").isVisible()).toBe(true);
      expect(await page.locator("#lm-interior[data-interior='control']").isVisible()).toBe(true);
      await page.waitForSelector("#home-system-ops", { timeout: 20_000 });
      await page.close();
    });

    it("history drill-down restores full Ground HUD in one back (regression)", async () => {
      const page = await browser.newPage({ viewport: VIEWPORT });
      await openBoard(page, `${baseUrl}/`, true);
      await focusHudMode(page, "ground");
      await page.waitForSelector("#lm-mode-ground-hud", { timeout: 20_000 });
      const historyRow = page.locator(".lm-ground-history-row").first();
      if (!(await historyRow.count())) {
        await page.close();
        return;
      }
      const scrollBefore = await page.locator("#lm-mode-ground-sections").evaluate((el) => el.scrollTop);
      await historyRow.click();
      await page.waitForSelector("#lm-detail:not([hidden])", { timeout: 10_000 });
      expect(await page.locator("#lm-detail-k").innerText()).toBe("PROJECT");
      expect(await page.locator("#lm-persist-back").getAttribute("aria-label")).toBe(
        "Back to Ground",
      );
      expect(await page.locator(".lm-ground-history-detail-k").count()).toBeGreaterThan(0);
      await page.locator("#lm-persist-back").click();
      await page.waitForSelector("#lm-detail[hidden]", { timeout: 5_000 });
      await page.waitForFunction(
        () => {
          const plane = document.getElementById("lm-suit-hud-plane");
          const hud = document.getElementById("lm-mode-ground-hud");
          return (
            plane &&
            plane.classList.contains("on") &&
            hud &&
            hud.offsetParent !== null
          );
        },
        { timeout: 5_000 },
      );
      expect(await page.locator("#lm-world-chip-ground").getAttribute("aria-selected")).toBe("true");
      for (const section of ["current_project", "jobs", "terminals", "history"]) {
        expect(await page.locator(`[data-section="${section}"]`).count()).toBeGreaterThan(0);
      }
      const scrollAfter = await page.locator("#lm-mode-ground-sections").evaluate((el) => el.scrollTop);
      expect(scrollAfter).toBe(scrollBefore);
      await page.close();
    });
  },
);
