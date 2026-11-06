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
      /** Client-scoped analytics fallback only; platform metrics come from growth runner merge. */
      visits: s.growth.visits,
      signups: null,
      trials: null,
      activation: null,
      demandSignups: null,
    },
    outbound: {
      sent: null,
      replies: null,
      note: null,
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

/** v1 snapshots store aggregates only — no persisted client account rows. */
export function snapshotHasRealAccountsFeed(snapshot: Yg3SnapshotV1): boolean {
  const rows = (snapshot as Yg3SnapshotV1 & { recentAccounts?: unknown }).recentAccounts;
  return Array.isArray(rows) && rows.length > 0;
}

export function yg3AccountsFeedFromSnapshot(
  load: Yg3SnapshotLoadResult,
): Yg3AccountsFeedPayload | null {
  if (!load.enabled || !load.snapshot || load.source !== "yg3-mcp") {
    return null;
  }
  if (!snapshotHasRealAccountsFeed(load.snapshot)) {
    return null;
  }
  const s = load.snapshot;
  const raw = (s as Yg3SnapshotV1 & {
    recentAccounts: Array<{
      id?: string;
      name?: string;
      email?: string;
      createdAt?: string;
    }>;
  }).recentAccounts;
  const items = raw
    .map((row) => ({
      id: String(row.id ?? "").trim(),
      name: String(row.name ?? "").trim(),
      email: String(row.email ?? "").trim(),
      createdAt: String(row.createdAt ?? "").trim(),
    }))
    .filter((row) => row.id && row.name && row.createdAt);
  if (!items.length) {
    return null;
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
