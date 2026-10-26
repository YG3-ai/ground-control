import { describe, expect, it } from "vitest";
import {
  extensionJsonHasEmailLike,
  redactBoardForPublic,
  redactBrainFeedForPublic,
  redactGrowthForPublic,
  redactLifecycleForPublic,
} from "./board-extensions/public-redact.js";
import type { GrowthFeedPayload } from "./board-extensions/growth.js";
import type { LifecycleFeedPayload } from "./board-extensions/lifecycle.js";

const SAMPLE_EMAIL = "prospect.person@example.com";

describe("public extension redaction", () => {
  it("strips prospect email from lifecycle recommendations and detail", () => {
    const raw: LifecycleFeedPayload = {
      ok: true,
      health: "ok",
      source: "lifecycle-queue",
      measuredAt: "2026-10-24T00:00:00.000Z",
      asOf: "2026-10-24T00:00:00.000Z",
      recommendations: [
        {
          id: "decision:opp-1",
          title: "Terrane follow-up",
          metric: SAMPLE_EMAIL,
          kind: "decision",
          detail: {
            opportunityId: "opp-1abcdef",
            email: SAMPLE_EMAIL,
            title: "Terrane follow-up",
          },
        },
        {
          id: "build:opp-2",
          title: `BUILD due: ${SAMPLE_EMAIL}`,
          metric: "promised 2026-10-25",
          kind: "build",
          detail: {
            opportunityId: "opp-2abcdef",
            email: SAMPLE_EMAIL,
            promised: "2026-10-25",
          },
        },
      ],
    };
    const redacted = redactLifecycleForPublic(raw);
    const json = JSON.stringify(redacted);
    expect(extensionJsonHasEmailLike(json)).toBe(false);
    expect(redacted.recommendations[0]?.metric).toContain("opportunity");
    expect(redacted.recommendations[0]?.detail).not.toHaveProperty("email");
    expect(redacted.recommendations[1]?.title).toMatch(/^BUILD due ·/);
  });

  it("internal audience keeps the unredacted payload", () => {
    const raw: LifecycleFeedPayload = {
      ok: true,
      health: "ok",
      source: "lifecycle-queue",
      measuredAt: "2026-10-24T00:00:00.000Z",
      asOf: "2026-10-24T00:00:00.000Z",
      recommendations: [
        {
          id: "decision:opp-1",
          title: "Terrane follow-up",
          metric: SAMPLE_EMAIL,
          kind: "decision",
          detail: {
            opportunityId: "opp-1abcdef",
            email: SAMPLE_EMAIL,
            title: "Terrane follow-up",
          },
        },
      ],
    };
    // The internal/authenticated path returns the payload untouched: the
    // contact identifier is still present for the owner.
    const internalJson = JSON.stringify(raw);
    expect(extensionJsonHasEmailLike(internalJson)).toBe(true);
    expect(internalJson).toContain(SAMPLE_EMAIL);
    expect(raw.recommendations[0]?.detail).toHaveProperty(
      "email",
      SAMPLE_EMAIL,
    );
    // Only the public projection strips it.
    const publicJson = JSON.stringify(redactLifecycleForPublic(raw));
    expect(extensionJsonHasEmailLike(publicJson)).toBe(false);
  });

  it("replaces live board with fiction and never leaks owner payloads", () => {
    const raw = {
      at: "2026-10-25T00:00:00.000Z",
      owner: { id: "o1", display_name: "Owner" },
      missions: [{ id: "m1", title: "Secret mission", goal: "g" }],
      approvals: [{ id: "a1", title: "Approve wire transfer" }],
      columns: { done: [{ title: "Done work" }] },
      health: { worker: true, open_terminals: 2 },
    };
    const out = redactBoardForPublic(raw);
    expect(out.public_preview).toBe(true);
    expect((out.missions as unknown[]).length).toBeGreaterThan(0);
    expect(JSON.stringify(out)).not.toMatch(/Secret mission/);
    expect(JSON.stringify(out)).not.toMatch(/wire transfer/);
    expect((out.health as { worker?: boolean }).worker).toBe(false);
  });

  it("brain feed public projection uses demo slugs only", () => {
    const out = redactBrainFeedForPublic({
      ok: true,
      health: "ok",
      measuredAt: "2026-10-25T00:00:00.000Z",
      items: [{ slug: "daily/secret", title: "Private dossier" }],
    });
    expect(out.items?.length).toBeGreaterThan(0);
    expect(JSON.stringify(out)).not.toMatch(/dossier/);
    for (const it of out.items ?? []) {
      expect(String(it.slug).startsWith("notes/demo/")).toBe(true);
    }
  });

  it("redacts email-like tokens in growth insights", () => {
    const raw: GrowthFeedPayload = {
      ok: true,
      health: "ok",
      source: "funnels-loopback",
      measuredAt: null,
      window: "7d",
      from: null,
      to: null,
      generatedAt: "2026-10-24T00:00:00.000Z",
      summary: {
        visits: 1,
        signups: 1,
        trials: 0,
        activation: 0,
        demandSignups: 0,
      },
      outbound: { sent: 0, replies: 0, note: `Contact ${SAMPLE_EMAIL} replied` },
      funnelRows: [{ key: "x", label: SAMPLE_EMAIL, n: 1 }],
      insights: [
        {
          id: "i1",
          kicker: "Lead",
          body: `Reply from ${SAMPLE_EMAIL}`,
          tone: "neutral",
        },
      ],
      funnelsUrl: "https://funnels.yg3.ai",
    };
    const json = JSON.stringify(redactGrowthForPublic(raw));
    expect(extensionJsonHasEmailLike(json)).toBe(false);
  });
});
