#!/usr/bin/env node
/**
 * Cached raw reproject with strict workspace verification (no live MCP reads).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadBroadListClientsPayload,
  loadDiscoveryRawMapFromDir,
} from "./raw-loader.js";
import { projectYg3SnapshotV1 } from "./projector.js";
import { parseWhoamiEnvelope } from "./envelope-parsers.js";
import {
  loadRepoDotenv,
  relayDataDirFromRepoModule,
} from "./repo-env.js";
import { normalizeWhoamiIdentity } from "./sanitize.js";
import { Yg3SnapshotFileStore } from "./snapshot-file-store.js";
import { Yg3SnapshotMetaStore } from "./snapshot-meta.js";
import { parseListClientsEnvelope } from "./workspace-resolve.js";
import { verifyExactWorkspaceAuthority } from "./workspace-verify.js";
import type { MetricAvailability } from "./snapshot-v1.js";

loadRepoDotenv(import.meta.url);

const REPORT_PATH = "/tmp/ground-control-yg3-verified-sync.txt";

type MetricBuckets = {
  mapped: string[];
  empty: string[];
  unavailable: string[];
};

function bucketMetrics(
  availability: Record<string, MetricAvailability>,
): MetricBuckets {
  const mapped: string[] = [];
  const empty: string[] = [];
  const unavailable: string[] = [];
  for (const [k, v] of Object.entries(availability)) {
    if (v === "mapped") mapped.push(k);
    else if (v === "empty") empty.push(k);
    else unavailable.push(k);
  }
  mapped.sort();
  empty.sort();
  unavailable.sort();
  return { mapped, empty, unavailable };
}

function writeReport(lines: string[]): void {
  writeFileSync(REPORT_PATH, `${lines.join("\n")}\n`, "utf8");
}

async function main(): Promise<void> {
  const relayDataDir = relayDataDirFromRepoModule(import.meta.url);
  const rawDir = join(relayDataDir, "yg3", "raw");
  const raw = loadDiscoveryRawMapFromDir(rawDir);
  const broadList = loadBroadListClientsPayload(rawDir);
  const whoami = parseWhoamiEnvelope(raw.whoami);
  const broadClients = broadList
    ? parseListClientsEnvelope(broadList)
    : [];
  const verification = verifyExactWorkspaceAuthority(whoami, broadClients);
  const selectedWorkspaceVerified = verification.verified;

  const syncedAt = new Date().toISOString();
  const identity = normalizeWhoamiIdentity(raw.whoami);
  const snapshot = projectYg3SnapshotV1(identity, syncedAt, raw, {
    allowClientScopedMetrics: selectedWorkspaceVerified,
  });

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
    /* snapshot file still updated */
  }
  Yg3SnapshotFileStore.defaultPath(relayDataDir).saveAtomic(snapshot);

  const buckets = bucketMetrics(snapshot.metricAvailability);
  const checks = [
    "cached_raw_load",
    "broad_list_clients_for_authority",
    "no_live_mcp_reads",
    "client_scoped_gated_on_verification",
  ];

  const blocker = selectedWorkspaceVerified
    ? "none"
    : verification.reason === "none"
      ? "no_broad_workspace_candidates"
      : "workspace_not_exact_authority";

  writeReport([
    `selected_workspace_verified=${selectedWorkspaceVerified}`,
    `sync_success=true`,
    `mapped=${buckets.mapped.join(",") || "none"}`,
    `empty=${buckets.empty.join(",") || "none"}`,
    `unavailable=${buckets.unavailable.join(",") || "none"}`,
    `checks=${checks.join(",")}`,
    `blocker=${blocker}`,
    `workspace_authority=${selectedWorkspaceVerified ? verification.authority : "none"}`,
    `broad_client_candidate_count=${broadClients.length}`,
  ]);

  console.log(
    JSON.stringify({
      selected_workspace_verified: selectedWorkspaceVerified,
      sync_success: true,
      metrics_mapped: buckets.mapped,
      metrics_empty: buckets.empty,
      metrics_unavailable: buckets.unavailable,
      blocker,
      production_updated: false,
    }),
  );
}

main().catch(() => {
  writeReport([
    "selected_workspace_verified=false",
    "sync_success=false",
    "mapped=none",
    "empty=none",
    "unavailable=none",
    "checks=none",
    "blocker=verified_sync_crashed",
  ]);
  process.exit(1);
});
