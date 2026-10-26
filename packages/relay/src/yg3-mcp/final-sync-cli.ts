#!/usr/bin/env node
/**
 * Slice 3B2C: list_clients workspace resolution + single-workspace read sync.
 */
import { join } from "node:path";
import {
  YG3_LIST_CLIENTS_LIMIT,
  YG3_SYNC_LEAD_LIMIT,
  YG3_SYNC_OPPORTUNITY_LIMIT,
  YG3_SYNC_WINDOW_DAYS,
} from "./constants.js";
import {
  extractSyncFailingClientName,
  extractSyncFailingClientSlug,
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
import {
  parseListClientsEnvelope,
  resolveExactWorkspace,
} from "./workspace-resolve.js";
import { growthFeedFromYg3Snapshot } from "./feed-from-snapshot.js";

loadRepoDotenv(import.meta.url);

type FinalReport = {
  connected: boolean;
  workspace_selected: boolean;
  source: string;
  freshness: "ok" | "stale" | "unavailable";
  client_count: number;
  project_count: number;
  task_count: number;
  recommendation_count: number;
  metrics_mapped: string[];
  metrics_unavailable: string[];
  workspace_candidate_count?: number;
  error_category?: string;
  production_updated: boolean;
  harness_growth_ok?: boolean;
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
  const base: FinalReport = {
    connected: false,
    workspace_selected: false,
    source: "none",
    freshness: "unavailable",
    client_count: 0,
    project_count: 0,
    task_count: 0,
    recommendation_count: 0,
    metrics_mapped: [],
    metrics_unavailable: [],
    production_updated: false,
  };

  if (!isYg3McpEnabled()) {
    console.log(JSON.stringify({ ...base, error_category: "mcp_disabled" }));
    process.exit(1);
  }

  const repoRoot = resolveRepoRootFromRelayModule(import.meta.url);
  const relayDataDir = relayDataDirFromRepoModule(import.meta.url);
  const rawDir = join(relayDataDir, "yg3", "raw");
  const raw = loadDiscoveryRawMapFromDir(rawDir);
  const rawStore = Yg3RawResponseStore.defaultPath(relayDataDir);
  const capturedAt = new Date().toISOString();

  const client = createYg3ReadonlyMcpClient({
    relayDataDir,
    repoRoot,
    audience: "owner",
  });
  if (!client) {
    console.log(JSON.stringify({ ...base, error_category: "client_unavailable" }));
    process.exit(1);
  }

  let resolutionOk = false;
  let failCandidateCount = 0;
  let failReason: "none" | "ambiguous" = "none";

  await client.runReadSession(async (call) => {
    raw.whoami = await call("whoami", {});
    rawStore.write("whoami", raw.whoami, capturedAt);

    let listClientsPayload = await call("list_clients", {
      include_archived: false,
      limit: YG3_LIST_CLIENTS_LIMIT,
    });
    raw.clients_list = listClientsPayload;
    rawStore.write("list_clients", listClientsPayload, capturedAt);

    let whoami = parseWhoamiEnvelope(raw.whoami);
    let clients = parseListClientsEnvelope(listClientsPayload);
    const syncFailSlug = raw.client_connections
      ? extractSyncFailingClientSlug(raw.client_connections)
      : null;
    const syncFailName = raw.client_connections
      ? extractSyncFailingClientName(raw.client_connections)
      : null;

    let resolution = resolveExactWorkspace(
      whoami,
      clients,
      syncFailSlug
        ? { ...process.env, YG3_SYNC_WORKSPACE_SLUG: syncFailSlug }
        : process.env,
    );

    if (!resolution.ok && syncFailName) {
      listClientsPayload = await call("list_clients", {
        include_archived: false,
        limit: YG3_LIST_CLIENTS_LIMIT,
        query: syncFailName,
      });
      raw.clients_list = listClientsPayload;
      rawStore.write("list_clients_query", listClientsPayload, capturedAt);
      clients = parseListClientsEnvelope(listClientsPayload);
      whoami = whoami
        ? { ...whoami, scopeClientDisplayName: syncFailName }
        : whoami;
      resolution = resolveExactWorkspace(whoami, clients);
    }

    if (!resolution.ok) {
      failCandidateCount = resolution.candidateCount;
      failReason = resolution.reason;
      return;
    }
    resolutionOk = true;

    const clientId = resolution.clientId;
    raw.client_snapshots = [];
    raw.traffic_breakdowns = [];
    raw.search_opportunities = [];
    raw.leads = [];
    const idArg = { client_id: clientId };

    const snap = await call("get_client_snapshot", {
      ...idArg,
      window: YG3_SYNC_WINDOW_DAYS,
    });
    raw.client_snapshots!.push(snap);
    rawStore.write("get_client_snapshot", snap, capturedAt);

    const traffic = await call("show_traffic_breakdown", {
      ...idArg,
      window: YG3_SYNC_WINDOW_DAYS,
    });
    raw.traffic_breakdowns!.push(traffic);
    rawStore.write("show_traffic_breakdown", traffic, capturedAt);

    const opps = await call("get_search_opportunities", {
      ...idArg,
      limit: YG3_SYNC_OPPORTUNITY_LIMIT,
      days: YG3_SYNC_WINDOW_DAYS,
    });
    raw.search_opportunities!.push(opps);
    rawStore.write("get_search_opportunities", opps, capturedAt);

    const leads = await call("list_leads", {
      ...idArg,
      limit: YG3_SYNC_LEAD_LIMIT,
      window: YG3_SYNC_WINDOW_DAYS,
    });
    raw.leads!.push(leads);
    rawStore.write("list_leads", leads, capturedAt);
  });

  if (!resolutionOk) {
    console.log(
      JSON.stringify({
        ...base,
        connected: true,
        source: "yg3-mcp",
        workspace_selected: false,
        workspace_candidate_count: failCandidateCount,
        error_category:
          failReason === "none"
            ? "no_workspace_candidates"
            : "workspace_ambiguous",
        production_updated: false,
      }),
    );
    process.exit(1);
  }

  const identity = normalizeWhoamiIdentity(raw.whoami);
  const snapshot = projectYg3SnapshotV1(identity, capturedAt, raw);
  if (snapshot.workspace.privateScopedDisplayName === null) {
    const who = parseWhoamiEnvelope(raw.whoami);
    const clients = parseListClientsEnvelope(raw.clients_list);
    const res = resolveExactWorkspace(who, clients);
    if (res.ok && res.privateDisplayName) {
      snapshot.workspace.privateScopedDisplayName = res.privateDisplayName;
    }
  }

  try {
    const meta = Yg3SnapshotMetaStore.defaultPath(relayDataDir);
    const cur = meta.load();
    if (!cur) meta.bindIdentity(identity);
    else if (
      cur.tenantKey === identity.tenantKey &&
      cur.userKey === identity.userKey
    ) {
      meta.touchWhoamiOk(identity);
    }
  } catch {
    /* snapshot file is authoritative for feeds */
  }
  Yg3SnapshotFileStore.defaultPath(relayDataDir).saveAtomic(snapshot);

  const lists = metricLists(snapshot);
  const harness = growthFeedFromYg3Snapshot(
    {
      enabled: true,
      snapshot,
      health: "ok",
      source: "yg3-mcp",
    },
    "7d",
  );

  console.log(
    JSON.stringify({
      connected: true,
      workspace_selected: true,
      source: "yg3-mcp",
      freshness: "ok",
      client_count: snapshot.workspace.clientCount,
      project_count: snapshot.projects.total,
      task_count: snapshot.tasks.total,
      recommendation_count: snapshot.recommendations.length,
      metrics_mapped: lists.mapped,
      metrics_unavailable: lists.unavailable,
      production_updated: false,
      harness_growth_ok: Boolean(harness?.ok),
    } satisfies FinalReport),
  );
}

main().catch(() => {
  console.log(
    JSON.stringify({
      connected: false,
      workspace_selected: false,
      source: "none",
      freshness: "unavailable",
      client_count: 0,
      project_count: 0,
      task_count: 0,
      recommendation_count: 0,
      metrics_mapped: [],
      metrics_unavailable: [],
      production_updated: false,
      error_category: "final_sync_crashed",
    }),
  );
  process.exit(1);
});
