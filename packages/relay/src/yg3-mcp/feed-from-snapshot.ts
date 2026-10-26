import type { GrowthFeedPayload } from "../board-extensions/growth.js";
import type { LifecycleFeedPayload } from "../board-extensions/lifecycle.js";
import type { Yg3AccountsFeedPayload } from "../board-yg3-accounts-present.js";
import type { Yg3SnapshotV1 } from "./snapshot-v1.js";
import type { Yg3SnapshotLoadResult } from "./snapshot-service.js";

export function growthFeedFromYg3Snapshot(
  load: Yg3SnapshotLoadResult,
  window: string,
): GrowthFeedPayload | null {
  if (!load.enabled || !load.snapshot || load.source !== "yg3-mcp") {
    return null;
  }
  const s = load.snapshot;
  const health =
    load.health === "ok"
      ? "ok"
      : load.health === "stale"
        ? "stale"
        : "unavailable";
  return {
    ok: true,
    health,
    source: "yg3-mcp",
    measuredAt: s.syncedAt,
    window,
    from: null,
    to: null,
    generatedAt: s.syncedAt,
    summary: {
      visits: s.growth.visits,
      signups: s.growth.leads,
      trials: null,
      activation: s.workspace.connectedCount,
      demandSignups: s.growth.opportunities,
    },
    outbound: {
      sent: null,
      replies: s.growth.leads,
      note: "YG3 MCP snapshot aggregates (no message bodies).",
    },
    funnelRows: s.growth.trafficRows.map((r) => ({
      key: r.key,
      label: r.label,
      n: r.count,
    })),
    insights: s.insights,
    funnelsUrl: "https://funnels.yg3.ai",
  };
}

export function yg3AccountsFeedFromSnapshot(
  load: Yg3SnapshotLoadResult,
): Yg3AccountsFeedPayload | null {
  if (!load.enabled || !load.snapshot || load.source !== "yg3-mcp") {
    return null;
  }
  const s = load.snapshot;
  const items = [];
  const n = Math.min(
    s.workspace.clientsInScope ?? s.workspace.clientCount,
    40,
  );
  for (let i = 0; i < n; i += 1) {
    const scoped =
      i === 0 && s.workspace.privateScopedDisplayName
        ? s.workspace.privateScopedDisplayName
        : null;
    items.push({
      id: `ws-${i + 1}`,
      name: scoped ?? `Workspace ${i + 1}`,
      email: "",
      createdAt: s.syncedAt,
    });
  }
  return {
    ok: true,
    health: load.health === "unavailable" ? "unavailable" : load.health,
    measuredAt: s.syncedAt,
    items,
  };
}

export function lifecycleFeedFromYg3Snapshot(
  load: Yg3SnapshotLoadResult,
): LifecycleFeedPayload | null {
  if (!load.enabled || !load.snapshot || load.source !== "yg3-mcp") {
    return null;
  }
  const s = load.snapshot;
  return {
    ok: true,
    health: load.health === "unavailable" ? "unavailable" : load.health,
    source: "yg3-mcp",
    measuredAt: s.syncedAt,
    asOf: s.syncedAt,
    recommendations: s.recommendations.slice(0, 3),
  };
}

export function snapshotHasNoPiiFields(snapshot: Yg3SnapshotV1): boolean {
  const blob = JSON.stringify(snapshot);
  return !/@|mailto:/i.test(blob);
}
