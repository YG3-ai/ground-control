import type { BoardExtensionPaths } from "./paths.js";
import { workRootAdapterConfigured } from "./paths.js";
import { runBounded } from "./safe-exec.js";
import { lifecycleFeedFromYg3Snapshot } from "../yg3-mcp/feed-from-snapshot.js";
import {
  loadYg3OwnerSnapshot,
  resolveYg3PathsFromRelayPackage,
} from "../yg3-mcp/snapshot-service.js";

export type LifecycleFeedPayload = {
  ok: boolean;
  health: "ok" | "unavailable" | "stale";
  source: "lifecycle-queue" | "yg3-mcp" | "none" | "demo";
  measuredAt: string | null;
  asOf: string | null;
  recommendations: {
    id: string;
    title: string;
    metric: string;
    kind: "decision" | "build" | "proof";
    detail: Record<string, unknown>;
  }[];
  error?: string;
};

type QueuePayload = {
  asOf: string;
  needsDecision: { opportunityId: string; email: string; title: string }[];
  buildFulfillmentDue: { opportunityId: string; email: string; promised?: string | null }[];
  proofWithoutUse: { opportunityId: string; email: string }[];
};

let cache: { at: number; payload: LifecycleFeedPayload } | null = null;
const TTL_MS = 60_000;

function unavailable(err?: string): LifecycleFeedPayload {
  return {
    ok: false,
    health: "unavailable",
    source: "none",
    measuredAt: null,
    asOf: null,
    recommendations: [],
    error: err,
  };
}

/** Freshness is the age of the source's own asOf, never cache age. */
const SOURCE_STALE_MS = 24 * 60 * 60 * 1000;

function applyFreshness(payload: LifecycleFeedPayload): LifecycleFeedPayload {
  if (!payload.ok) return payload;
  const t = payload.asOf ? Date.parse(payload.asOf) : NaN;
  const fresh = Number.isFinite(t) && Date.now() - t <= SOURCE_STALE_MS;
  return { ...payload, health: fresh ? "ok" : "stale" };
}

function toRecommendations(q: QueuePayload): LifecycleFeedPayload["recommendations"] {
  const out: LifecycleFeedPayload["recommendations"] = [];
  for (const d of q.needsDecision.slice(0, 5)) {
    out.push({
      id: `decision:${d.opportunityId}`,
      title: d.title,
      metric: d.email,
      kind: "decision",
      detail: d,
    });
  }
  for (const b of q.buildFulfillmentDue.slice(0, 2)) {
    if (out.length >= 3) break;
    out.push({
      id: `build:${b.opportunityId}`,
      title: `BUILD due: ${b.email}`,
      metric: b.promised ? `promised ${b.promised}` : "fulfillment queue",
      kind: "build",
      detail: b,
    });
  }
  for (const p of q.proofWithoutUse.slice(0, 2)) {
    if (out.length >= 3) break;
    out.push({
      id: `proof:${p.opportunityId}`,
      title: `Proof without use: ${p.email}`,
      metric: "lifecycle ledger",
      kind: "proof",
      detail: p,
    });
  }
  return out.slice(0, 3);
}

export async function getLifecycleFeed(
  pathsCfg: BoardExtensionPaths,
  relayPackageRoot?: string,
): Promise<LifecycleFeedPayload> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) {
    return applyFreshness(cache.payload);
  }

  if (relayPackageRoot) {
    const yg3Paths = resolveYg3PathsFromRelayPackage(relayPackageRoot);
    const yg3Load = await loadYg3OwnerSnapshot({
      ...yg3Paths,
      audience: "owner",
    });
    const fromMcp = lifecycleFeedFromYg3Snapshot(yg3Load);
    if (fromMcp && fromMcp.health !== "unavailable") {
      const payload = applyFreshness(fromMcp);
      cache = { at: now, payload };
      return payload;
    }
  }

  if (
    !workRootAdapterConfigured(pathsCfg) ||
    !pathsCfg.lifecycleQueueScript
  ) {
    return unavailable("work_root_adapter_not_configured");
  }

  const node = process.execPath;
  const result = await runBounded(
    node,
    ["--import", "tsx", pathsCfg.lifecycleQueueScript, "queue", "--json"],
    {
      cwd: pathsCfg.parthaWorkRoot!,
      timeoutMs: 30_000,
      maxBuffer: 2_000_000,
    },
  );
  if (result.code !== 0) {
    return unavailable(result.stderr.slice(0, 200) || "lifecycle queue failed");
  }
  try {
    const q = JSON.parse(result.stdout) as QueuePayload;
    const payload: LifecycleFeedPayload = applyFreshness({
      ok: true,
      health: "ok",
      source: "lifecycle-queue",
      measuredAt: new Date().toISOString(),
      asOf: q.asOf,
      recommendations: toRecommendations(q),
    });
    cache = { at: now, payload };
    return payload;
  } catch {
    return unavailable("invalid lifecycle JSON");
  }
}

export function clearLifecycleCache(): void {
  cache = null;
}
