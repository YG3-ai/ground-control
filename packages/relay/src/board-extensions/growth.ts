import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { BoardExtensionPaths } from "./paths.js";
import { workRootAdapterConfigured } from "./paths.js";
import { runBounded } from "./safe-exec.js";
import { growthFeedFromYg3Snapshot } from "../yg3-mcp/feed-from-snapshot.js";
import {
  loadYg3OwnerSnapshot,
  resolveYg3PathsFromRelayPackage,
} from "../yg3-mcp/snapshot-service.js";

export type SourceHealth = "ok" | "unavailable" | "stale";

export type GrowthFeedPayload = {
  ok: boolean;
  health: SourceHealth;
  source: "funnels-loopback" | "partha-work-runner" | "yg3-mcp" | "none" | "demo";
  measuredAt: string | null;
  window: string | null;
  from: string | null;
  to: string | null;
  generatedAt: string | null;
  summary: {
    visits: number | null;
    signups: number | null;
    trials: number | null;
    activation: number | null;
    demandSignups: number | null;
  };
  outbound: {
    sent: number | null;
    replies: number | null;
    note: string | null;
  };
  funnelRows: { key: string; label: string; n: number }[];
  insights: {
    id: string;
    kicker: string;
    body: string;
    tone: string;
  }[];
  funnelsUrl: string;
  error?: string;
};

type CacheEntry = { at: number; key: string; payload: GrowthFeedPayload };

let cache: CacheEntry | null = null;
const TTL_MS = 60_000;

type RawReport = {
  generatedAt?: string;
  window?: string;
  from?: string | null;
  to?: string;
  acquisition?: { visits?: number; taggedShare?: number };
  conversion?: {
    signups?: number;
    trials?: number;
    demandSignups?: number;
    giftSignups?: number;
    byPath?: { key: string; label: string; n: number }[];
  };
  journey?: {
    signedUpAndLoggedIn?: number;
    signedUpNeverLoggedIn?: number;
  };
  compare?: { label: string; demandSignups: number } | null;
  outbound?: {
    totals?: { sent?: number; replies?: number };
    health?: { holds?: number };
  };
};

async function buildInsights(
  root: string,
  report: RawReport,
): Promise<GrowthFeedPayload["insights"]> {
  try {
    const { buildRealityInsights } = await import(
      pathToFileURL(join(root, "lib/reality-insights.ts")).href
    );
    return buildRealityInsights({
      acquisition: {
        visits: report.acquisition?.visits ?? 0,
        taggedShare: report.acquisition?.taggedShare ?? 0,
      },
      conversion: {
        signups: report.conversion?.signups ?? 0,
        trials: report.conversion?.trials ?? 0,
        giftSignups: report.conversion?.giftSignups ?? 0,
        demandSignups: report.conversion?.demandSignups ?? 0,
        byPath: report.conversion?.byPath ?? [],
      },
      journey: {
        signedUpAndLoggedIn: report.journey?.signedUpAndLoggedIn ?? 0,
        signedUpNeverLoggedIn: report.journey?.signedUpNeverLoggedIn ?? 0,
      },
      compare: report.compare ?? null,
    });
  } catch {
    return [];
  }
}

function slimReport(
  report: RawReport,
  insights: GrowthFeedPayload["insights"],
  source: GrowthFeedPayload["source"],
): GrowthFeedPayload {
  const totals = report.outbound?.totals;
  return {
    ok: true,
    health: "ok",
    source,
    measuredAt: new Date().toISOString(),
    window: report.window ?? null,
    from: report.from ?? null,
    to: report.to ?? null,
    generatedAt: report.generatedAt ?? null,
    summary: {
      visits: report.acquisition?.visits ?? null,
      signups: report.conversion?.signups ?? null,
      trials: report.conversion?.trials ?? null,
      activation: report.journey?.signedUpAndLoggedIn ?? null,
      demandSignups: report.conversion?.demandSignups ?? null,
    },
    outbound: {
      sent: totals?.sent ?? null,
      replies: totals?.replies ?? null,
      note:
        totals?.sent != null
          ? "Replies = leads with recorded status 'replied' in-window (per source). Not a verified human-written count."
          : null,
    },
    funnelRows: (report.conversion?.byPath ?? []).slice(0, 12),
    insights,
    funnelsUrl: "https://funnels.yg3.ai",
  };
}

function unavailable(err?: string): GrowthFeedPayload {
  return {
    ok: false,
    health: "unavailable",
    source: "none",
    measuredAt: null,
    window: null,
    from: null,
    to: null,
    generatedAt: null,
    summary: {
      visits: null,
      signups: null,
      trials: null,
      activation: null,
      demandSignups: null,
    },
    outbound: { sent: null, replies: null, note: null },
    funnelRows: [],
    insights: [],
    funnelsUrl: "https://funnels.yg3.ai",
    error: err,
  };
}

/** Freshness is the age of the source's own generatedAt, never cache age. */
const SOURCE_STALE_MS = 24 * 60 * 60 * 1000;

function applyFreshness(payload: GrowthFeedPayload): GrowthFeedPayload {
  if (!payload.ok) return payload;
  const t = payload.generatedAt ? Date.parse(payload.generatedAt) : NaN;
  const fresh = Number.isFinite(t) && Date.now() - t <= SOURCE_STALE_MS;
  return { ...payload, health: fresh ? "ok" : "stale" };
}

async function fetchLoopback(
  pathsCfg: BoardExtensionPaths,
  w: string,
): Promise<GrowthFeedPayload | null> {
  const url = `${pathsCfg.funnelsLoopbackBase}/api/dashboard?w=${encodeURIComponent(w)}`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { report?: RawReport };
    if (!data.report) return null;
    const insights = pathsCfg.parthaWorkRoot
      ? await buildInsights(pathsCfg.parthaWorkRoot, data.report)
      : [];
    return slimReport(data.report, insights, "funnels-loopback");
  } catch {
    return null;
  }
}

async function runGrowthRunner(
  pathsCfg: BoardExtensionPaths,
  w: string,
): Promise<GrowthFeedPayload> {
  if (!workRootAdapterConfigured(pathsCfg) || !pathsCfg.parthaWorkEnvFile) {
    return unavailable("work_root_adapter_not_configured");
  }
  const node = process.execPath;
  const args = [
    "--conditions=react-server",
    `--env-file=${pathsCfg.parthaWorkEnvFile}`,
    "--import",
    "tsx",
    pathsCfg.growthRunnerScript,
    `--w=${w}`,
  ];
  const result = await runBounded(node, args, {
    cwd: pathsCfg.parthaWorkRoot!,
    timeoutMs: 45_000,
    maxBuffer: 4_000_000,
    env: {
      ...process.env,
      GROUND_CONTROL_WORK_ROOT: pathsCfg.parthaWorkRoot!,
      PARTHA_WORK_ROOT: pathsCfg.parthaWorkRoot!,
    },
  });
  if (result.code !== 0) {
    return unavailable(result.stderr.slice(0, 200) || "growth runner failed");
  }
  try {
    const body = JSON.parse(result.stdout) as {
      report: RawReport;
      insights: GrowthFeedPayload["insights"];
    };
    return slimReport(body.report, body.insights, "partha-work-runner");
  } catch {
    return unavailable("invalid growth runner JSON");
  }
}

export async function getGrowthFeed(
  w: string,
  pathsCfg: BoardExtensionPaths,
  relayPackageRoot?: string,
): Promise<GrowthFeedPayload> {
  const key = w || "7d";
  const now = Date.now();
  if (cache && cache.key === key && now - cache.at < TTL_MS) {
    return applyFreshness(cache.payload);
  }

  if (relayPackageRoot) {
    const yg3Paths = resolveYg3PathsFromRelayPackage(relayPackageRoot);
    const yg3Load = await loadYg3OwnerSnapshot({
      ...yg3Paths,
      audience: "owner",
    });
    const fromMcp = growthFeedFromYg3Snapshot(yg3Load, key);
    if (fromMcp && fromMcp.health !== "unavailable") {
      const payload = applyFreshness(fromMcp);
      cache = { at: now, key, payload };
      return payload;
    }
  }

  const loopback = await fetchLoopback(pathsCfg, key);
  const payload = applyFreshness(loopback ?? (await runGrowthRunner(pathsCfg, key)));
  cache = { at: now, key, payload };
  return payload;
}

export function clearGrowthCache(): void {
  cache = null;
}
