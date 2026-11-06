import type { GrowthFeedPayload } from "./growth.js";

/** Platform funnel metrics (funnels / partha-work runner) override MCP client aggregates. */
export function mergeRunnerPlatformMetrics(
  mcp: GrowthFeedPayload,
  runner: GrowthFeedPayload,
): GrowthFeedPayload {
  if (!runner.ok) {
    return mcp;
  }
  return {
    ...mcp,
    window: runner.window ?? mcp.window,
    from: runner.from ?? mcp.from,
    to: runner.to ?? mcp.to,
    generatedAt: runner.generatedAt ?? mcp.generatedAt,
    insights: runner.insights.length ? runner.insights : mcp.insights,
    funnelRows: runner.funnelRows.length ? runner.funnelRows : mcp.funnelRows,
    outbound:
      runner.outbound.sent != null || runner.outbound.replies != null
        ? runner.outbound
        : mcp.outbound,
    summary: {
      visits: runner.summary.visits,
      signups: runner.summary.signups,
      trials: runner.summary.trials,
      activation: runner.summary.activation,
      demandSignups: runner.summary.demandSignups,
    },
  };
}
