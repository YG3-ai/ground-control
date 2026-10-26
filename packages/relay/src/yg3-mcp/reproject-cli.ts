#!/usr/bin/env node
import { join } from "node:path";
import { loadDiscoveryRawMapFromDir } from "./raw-loader.js";
import { projectYg3SnapshotV1 } from "./projector.js";
import {
  loadRepoDotenv,
  relayDataDirFromRepoModule,
} from "./repo-env.js";
import { normalizeWhoamiIdentity } from "./sanitize.js";
import { Yg3SnapshotFileStore } from "./snapshot-file-store.js";
import { Yg3SnapshotMetaStore } from "./snapshot-meta.js";

loadRepoDotenv(import.meta.url);

async function main(): Promise<void> {
  const relayDataDir = relayDataDirFromRepoModule(import.meta.url);
  const rawDir = join(relayDataDir, "yg3", "raw");
  const raw = loadDiscoveryRawMapFromDir(rawDir);
  const syncedAt = new Date().toISOString();
  const identity = normalizeWhoamiIdentity(raw.whoami);
  const snapshot = projectYg3SnapshotV1(identity, syncedAt, raw);
  const meta = Yg3SnapshotMetaStore.defaultPath(relayDataDir);
  try {
    const cur = meta.load();
    if (!cur) meta.bindIdentity(identity);
    else if (
      cur.tenantKey === identity.tenantKey &&
      cur.userKey === identity.userKey
    ) {
      meta.touchWhoamiOk(identity);
    }
  } catch {
    /* snapshot file still updated; meta unchanged on mismatch */
  }
  Yg3SnapshotFileStore.defaultPath(relayDataDir).saveAtomic(snapshot);

  const mapped: string[] = [];
  const unavailable: string[] = [];
  for (const [k, v] of Object.entries(snapshot.metricAvailability)) {
    if (v === "mapped") mapped.push(k);
    else unavailable.push(k);
  }
  mapped.sort();
  unavailable.sort();

  console.log(
    JSON.stringify({
      connected: true,
      source: "yg3-mcp",
      freshness: "ok",
      client_count: snapshot.workspace.clientCount,
      project_count: snapshot.projects.total,
      task_count: snapshot.tasks.total,
      recommendation_count: snapshot.recommendations.length,
      metrics_mapped: mapped,
      metrics_unavailable: unavailable,
    }),
  );
}

main().catch(() => process.exit(1));
