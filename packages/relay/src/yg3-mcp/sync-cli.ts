#!/usr/bin/env node
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { growthFeedFromYg3Snapshot } from "./feed-from-snapshot.js";
import { loadRepoDotenv, relayDataDirFromRepoModule } from "./repo-env.js";
import { resolveRepoRootFromRelayModule } from "./repo-env.js";
import { runYg3OwnerSync } from "./snapshot-service.js";
import { isYg3McpEnabled } from "./url.js";

loadRepoDotenv(import.meta.url);

type SanitizedSyncReport = {
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
  if (!isYg3McpEnabled()) {
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
        error_category: "mcp_disabled",
      } satisfies SanitizedSyncReport),
    );
    process.exit(1);
  }

  const repoRoot = resolveRepoRootFromRelayModule(import.meta.url);
  const relayDataDir = relayDataDirFromRepoModule(import.meta.url);
  const result = await runYg3OwnerSync({
    repoRoot,
    relayDataDir,
    audience: "owner",
  });

  const snap = result.snapshot;
  if (!snap) {
    console.log(
      JSON.stringify({
        connected: false,
        source: result.source,
        freshness: result.health,
        client_count: 0,
        project_count: 0,
        task_count: 0,
        recommendation_count: 0,
        metrics_mapped: [],
        metrics_unavailable: [],
        error_category: "sync_failed",
      } satisfies SanitizedSyncReport),
    );
    process.exit(1);
  }

  const storePath = join(relayDataDir, "yg3", "snapshot-v1.json");
  const structOk =
    existsSync(storePath) && (statSync(storePath).mode & 0o777) === 0o600;
  const growthProbe = growthFeedFromYg3Snapshot(
    { enabled: true, snapshot: snap, health: result.health, source: "yg3-mcp" },
    "7d",
  );
  const lists = metricLists(snap);

  const report: SanitizedSyncReport = {
    connected: structOk && Boolean(growthProbe?.ok),
    source: result.source,
    freshness: result.health,
    client_count: snap.workspace.clientCount,
    project_count: snap.projects.total,
    task_count: snap.tasks.total,
    recommendation_count: snap.recommendations.length,
    metrics_mapped: lists.mapped,
    metrics_unavailable: lists.unavailable,
  };
  if (!structOk) report.error_category = "snapshot_write_invalid";
  console.log(JSON.stringify(report));
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
      error_category: "sync_crashed",
    }),
  );
  process.exit(1);
});
