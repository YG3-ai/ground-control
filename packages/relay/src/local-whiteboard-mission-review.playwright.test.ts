import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import {
  createService,
  initGitFixture,
  makeTempRoot,
} from "../../worker/src/test-utils.js";
import type { WorkerService } from "../../worker/src/service.js";
import {
  contractMarkerPayload,
  type MissionContract,
} from "../../worker/src/missions/contract.js";

const port = 28788;
const baseUrl = `http://127.0.0.1:${port}`;

describe("local whiteboard mission review (playwright)", () => {
  let service: WorkerService;
  let browser: Browser;
  let missionTitle: string;

  beforeAll(async () => {
    const root = makeTempRoot();
    const fixture = join(root, "fixture");
    mkdirSync(fixture, { recursive: true });
    initGitFixture(fixture);
    service = createService(root, fixture);
    service.config.worker.local_control = {
      enabled: true,
      bind: "127.0.0.1",
      port,
      browser_requires_approval: false,
    };
    service.config.supervisor = { enabled: false };

    const contract: MissionContract = {
      version: 1,
      steps: [{ id: "x", title: "done", kind: "synthetic", agent: "mock", project_id: "demo-sandbox" }],
      supervision: { max_step_retries: 0, backoff_sec: 0 },
      evidence: { require_git_head: false, require_usability: false },
    };
    missionTitle = "Playwright review packet";
    const impl = service.store.createJob({
      ownerId: "owner-test",
      projectId: "demo-sandbox",
      agent: "mock",
      prompt: "ui fixture",
      timeoutSec: 60,
    });
    service.store.updateJob(impl.id, {
      status: "succeeded",
      exit_code: 0,
      finished_at: new Date().toISOString(),
    });
    const mission = service.missions.create({
      ownerId: "owner-test",
      title: missionTitle,
      goal: "Owner sees ready_for_review column and review markers",
      markers: {
        project_active: true,
        ...contractMarkerPayload(contract),
        "step_done:x": true,
        implementation_branch: "feat/mission-supervisor-recovery",
      },
    });
    service.missions.update("owner-test", mission.id, {
      status: "verifying",
      linkJobId: impl.id,
      markers: { review_packet_version: 2 },
    });
    const review = await service.submitMissionReview("owner-test", mission.id, {
      summary: "Branch feat/mission-supervisor-recovery · packet v2",
      review_packet_version: 2,
      notify: false,
    });
    expect(review.blocked).toBe(false);

    service.start();
    browser = await chromium.launch({ headless: true });
  }, 45_000);

  afterAll(async () => {
    await browser?.close();
    service?.stop();
  });

  async function assertReviewColumn(viewport: { width: number; height: number }) {
    const page = await browser.newPage({ viewport });
    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForSelector("#board", { state: "visible", timeout: 15_000 });
    await page.waitForSelector(".col h2 span", { timeout: 10_000 });
    const colText = await page.locator(".col", {
      has: page.locator("h2 span", { hasText: "Ready for review" }),
    }).innerText();
    expect(colText).toContain(missionTitle);
    const api = await page.evaluate(async (title) => {
      const res = await fetch("/api/board");
      const data = (await res.json()) as {
        columns?: { ready_for_review?: { title?: string; markers?: Record<string, unknown> }[] };
        missions?: { title?: string; markers?: Record<string, unknown> }[];
      };
      const colCount = data.columns?.ready_for_review?.length ?? 0;
      const mission = (data.missions ?? []).find((m) => m.title === title);
      return {
        colCount,
        reviewPacket: mission?.markers?.review_packet_version,
        reviewState: mission?.markers?.review_state,
      };
    }, missionTitle);
    expect(api.colCount).toBeGreaterThanOrEqual(1);
    expect(api.reviewPacket).toBe(2);
    expect(api.reviewState).toBe("ready_for_review");
    await page.close();
  }

  it("desktop: ready_for_review column shows review packet chips", async () => {
    await assertReviewColumn({ width: 1280, height: 800 });
  });

  it("mobile: ready_for_review column is tappable and visible", async () => {
    await assertReviewColumn({ width: 390, height: 844 });
  });
});
