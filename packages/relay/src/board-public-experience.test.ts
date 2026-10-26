import { describe, expect, it } from "vitest";
import {
  publicBoardFeedDemo,
  publicGrowthFeedDemo,
  publicNotesFictionFeed,
  FICTION_BUSINESS_NAME,
} from "./board-extensions/public-demo.js";
import { redactBoardForPublic } from "./board-extensions/public-redact.js";
import { normalizePublicHttpUrl, DEFAULT_PUBLIC_REPO_URL } from "./public-urls.js";
import { applyBoardPublicUrls } from "./board-html-loader.js";

const LIVE_MARKER = "fixture-mission-title-unique";

describe("public experience fixtures", () => {
  it("board demo is fictional and deterministic", () => {
    const a = publicBoardFeedDemo();
    const b = publicBoardFeedDemo();
    expect(a).toEqual(b);
    expect(a.public_preview).toBe(true);
    expect(JSON.stringify(a)).toContain(FICTION_BUSINESS_NAME);
    expect(JSON.stringify(a)).not.toContain(LIVE_MARKER);
    expect((a.missions as unknown[]).length).toBeGreaterThan(0);
  });

  it("redactBoardForPublic never leaks live board payloads", () => {
    const live = {
      missions: [{ title: LIVE_MARKER }],
      terminal_sessions: [{ output_tail: "secret" }],
    };
    const out = redactBoardForPublic(live);
    expect(JSON.stringify(out)).not.toContain(LIVE_MARKER);
    expect(JSON.stringify(out)).not.toContain("secret");
  });

  it("growth demo has non-zero fictional metrics", () => {
    const g = publicGrowthFeedDemo("7d");
    expect(g.summary.signups).toBeGreaterThan(0);
    expect(g.insights[0]?.body).toMatch(/fictional|demo/i);
  });

  it("notes demo slugs are namespaced", () => {
    for (const it of publicNotesFictionFeed().items ?? []) {
      expect(it.slug.startsWith("notes/demo/")).toBe(true);
    }
  });

  it("validates public URLs for CTAs", () => {
    expect(normalizePublicHttpUrl("not a url")).toBeNull();
    expect(normalizePublicHttpUrl("https://buy.stripe.com/demo")).toMatch(/^https:/);
    expect(DEFAULT_PUBLIC_REPO_URL).toMatch(/^https:\/\/github\.com\//);
  });

  it("injects repo meta without donation when unset", () => {
    const html = applyBoardPublicUrls("<html><head></head><body></body></html>", {
      repoUrl: DEFAULT_PUBLIC_REPO_URL,
      donationUrl: null,
    });
    expect(html).toContain('ground-public-repo');
    expect(html).not.toContain('ground-public-donation');
  });
});
