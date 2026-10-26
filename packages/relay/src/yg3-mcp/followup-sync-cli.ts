#!/usr/bin/env node
/**
 * Bounded client-scoped follow-up using trusted IDs from ignored raw cache.
 */
import { join } from "node:path";
import {
  YG3_SYNC_LEAD_LIMIT,
  YG3_SYNC_MAX_CLIENTS,
  YG3_SYNC_OPPORTUNITY_LIMIT,
  YG3_SYNC_WINDOW_DAYS,
} from "./constants.js";
import {
  extractTrustedClientIds,
  parseListProjectsEnvelope,
  parseWhoamiEnvelope,
} from "./envelope-parsers.js";
import { createYg3ReadonlyMcpClient } from "./factory.js";
import { loadDiscoveryRawMapFromDir } from "./raw-loader.js";
import { Yg3RawResponseStore } from "./raw-store.js";
import { projectYg3SnapshotV1 } from "./projector.js";
import {
  loadRepoDotenv,
  relayDataDirFromRepoModule,
  resolveRepoRootFromRelayModule,
} from "./repo-env.js";
import { normalizeWhoamiIdentity } from "./sanitize.js";
import { Yg3SnapshotFileStore } from "./snapshot-file-store.js";
import { Yg3SnapshotMetaStore } from "./snapshot-meta.js";
import { isYg3McpEnabled } from "./url.js";

loadRepoDotenv(import.meta.url);

type Report = {
  connected: boolean;
  source: string;
  freshness: "ok" | "stale" | "unavailable";
  client_count: number;
  project_count: number;
  task_count: number;
  recommendation_count: number;
  metrics_mapped: string[];
  metrics_unavailable: string[];
  error_category?: string;
};

function metricLists(snapshot: {
  metricAvailability: Record<string, string>;
}): { mapped: string[]; unavailable: string[] } {
  const mapped: string[] = [];
  const unavailable: string[] = [];
  for (const [k, v] of Object.entries(snapshot.metricAvailability)) {
    if (v === "mapped") mapped.push(k);
    else unavailable.push(k);
  }
  mapped.sort();
  unavailable.sort();
  return { mapped, unavailable };
}

async function main(): Promise<void> {
  const empty: Report = {
    connected: false,
    source: "none",
    freshness: "unavailable",
    client_count: 0,
    project_count: 0,
    task_count: 0,
    recommendation_count: 0,
    metrics_mapped: [],
    metrics_unavailable: [],
  };

  if (!isYg3McpEnabled()) {
    console.log(JSON.stringify({ ...empty, error_category: "mcp_disabled" }));
    process.exit(1);
  }

  const repoRoot = resolveRepoRootFromRelayModule(import.meta.url);
  const relayDataDir = relayDataDirFromRepoModule(import.meta.url);
  const rawDir = join(relayDataDir, "yg3", "raw");
  const raw = loadDiscoveryRawMapFromDir(rawDir);

  const clientIds = extractTrustedClientIds(
    parseWhoamiEnvelope(raw.whoami),
    parseListProjectsEnvelope(raw.projects),
    YG3_SYNC_MAX_CLIENTS,
  );

  if (!clientIds.length) {
    console.log(
      JSON.stringify({ ...empty, error_category: "no_trusted_client_ids" }),
    );
    process.exit(1);
  }

  const client = createYg3ReadonlyMcpClient({
    relayDataDir,
    repoRoot,
    audience: "owner",
  });
  if (!client) {
    console.log(JSON.stringify({ ...empty, error_category: "client_unavailable" }));
    process.exit(1);
  }

  const rawStore = Yg3RawResponseStore.defaultPath(relayDataDir);
  const capturedAt = new Date().toISOString();

  raw.client_snapshots = raw.client_snapshots ?? [];
  raw.traffic_breakdowns = raw.traffic_breakdowns ?? [];
  raw.search_opportunities = raw.search_opportunities ?? [];
  raw.leads = raw.leads ?? [];

  await client.runReadSession(async (call) => {
    for (const clientId of clientIds) {
      const idArg = { client_id: clientId };
      try {
        const snap = await call("get_client_snapshot", {
          ...idArg,
          window: YG3_SYNC_WINDOW_DAYS,
        });
        raw.client_snapshots!.push(snap);
        rawStore.write(`get_client_snapshot_fu`, snap, capturedAt);
      } catch {
        /* skip */
      }
      try {
        const traffic = await call("show_traffic_breakdown", {
          ...idArg,
          window: YG3_SYNC_WINDOW_DAYS,
        });
        raw.traffic_breakdowns!.push(traffic);
        rawStore.write(`show_traffic_breakdown_fu`, traffic, capturedAt);
      } catch {
        /* skip */
      }
      try {
        const opps = await call("get_search_opportunities", {
          ...idArg,
          limit: YG3_SYNC_OPPORTUNITY_LIMIT,
          days: YG3_SYNC_WINDOW_DAYS,
        });
        raw.search_opportunities!.push(opps);
        rawStore.write(`get_search_opportunities_fu`, opps, capturedAt);
      } catch {
        /* skip */
      }
      try {
        const leads = await call("list_leads", {
          ...idArg,
          limit: YG3_SYNC_LEAD_LIMIT,
          window: YG3_SYNC_WINDOW_DAYS,
        });
        raw.leads!.push(leads);
        rawStore.write(`list_leads_fu`, leads, capturedAt);
      } catch {
        /* skip */
      }
    }
  });

  const identity = normalizeWhoamiIdentity(raw.whoami);
  const snapshot = projectYg3SnapshotV1(identity, capturedAt, raw);
  const meta = Yg3SnapshotMetaStore.defaultPath(relayDataDir);
  meta.bindIdentity(identity);
  Yg3SnapshotFileStore.defaultPath(relayDataDir).saveAtomic(snapshot);

  const lists = metricLists(snapshot);
  console.log(
    JSON.stringify({
      connected: true,
      source: "yg3-mcp",
      freshness: "ok",
      client_count: snapshot.workspace.clientCount,
      project_count: snapshot.projects.total,
      task_count: snapshot.tasks.total,
      recommendation_count: snapshot.recommendations.length,
      metrics_mapped: lists.mapped,
      metrics_unavailable: lists.unavailable,
    } satisfies Report),
  );
}

main().catch(() => {
  console.log(
    JSON.stringify({
      connected: false,
      source: "none",
      freshness: "unavailable",
      client_count: 0,
      project_count: 0,
      task_count: 0,
      recommendation_count: 0,
      metrics_mapped: [],
      metrics_unavailable: [],
      error_category: "followup_crashed",
    }),
  );
  process.exit(1);
});
