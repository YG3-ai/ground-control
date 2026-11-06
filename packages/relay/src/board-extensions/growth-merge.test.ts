import { describe, expect, it } from "vitest";
import type { GrowthFeedPayload } from "./growth.js";
import { mergeRunnerPlatformMetrics } from "./growth-merge.js";

function basePayload(overrides: Partial<GrowthFeedPayload> = {}): GrowthFeedPayload {
  return {
    ok: true,
    health: "ok",
    source: "yg3-mcp",
    measuredAt: "2026-01-01T00:00:00.000Z",
    window: "7",
    from: null,
    to: "2026-01-07",
    generatedAt: "2026-01-01T00:00:00.000Z",
    summary: {
      visits: 9,
      signups: 3,
      trials: null,
      activation: null,
      demandSignups: 2,
    },
    outbound: { sent: null, replies: 3, note: "mcp leads" },
    funnelRows: [{ key: "mcp", label: "MCP row", n: 1 }],
    insights: [{ id: "mcp", kicker: "MCP", body: "from snapshot", tone: "neutral" }],
    funnelsUrl: "https://funnels.yg3.ai",
    ...overrides,
  };
}

describe("mergeRunnerPlatformMetrics", () => {
  it("replaces MCP signups/demand/traffic with runner platform counts", () => {
    const mcp = basePayload();
    const runner = basePayload({
      ok: true,
      source: "partha-work-runner",
      summary: {
        visits: 120,
        signups: 4,
        trials: 1,
        activation: 2,
        demandSignups: 3,
      },
      outbound: { sent: 10, replies: 2, note: "runner" },
      insights: [{ id: "r", kicker: "Runner", body: "platform", tone: "neutral" }],
      funnelRows: [{ key: "path", label: "Organic", n: 4 }],
      window: "7",
      from: "2026-01-01",
      to: "2026-01-07",
      generatedAt: "2026-01-07T12:00:00.000Z",
    });
    const merged = mergeRunnerPlatformMetrics(mcp, runner);
    expect(merged.summary).toEqual(runner.summary);
    expect(merged.outbound).toEqual(runner.outbound);
    expect(merged.insights).toEqual(runner.insights);
    expect(merged.funnelRows).toEqual(runner.funnelRows);
    expect(merged.generatedAt).toBe(runner.generatedAt);
    expect(merged.source).toBe("yg3-mcp");
  });

  it("leaves MCP payload when runner is unavailable", () => {
    const mcp = basePayload();
    const runner = basePayload({ ok: false, health: "unavailable", source: "none" });
    expect(mergeRunnerPlatformMetrics(mcp, runner)).toEqual(mcp);
  });
});
