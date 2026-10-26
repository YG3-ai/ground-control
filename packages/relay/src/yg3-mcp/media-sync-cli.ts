#!/usr/bin/env node
/**
 * Owner-directed YG3 client workspace sync (role-aware selection).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  YG3_SYNC_LEAD_LIMIT,
  YG3_SYNC_OPPORTUNITY_LIMIT,
  YG3_SYNC_WINDOW_DAYS,
} from "./constants.js";
import { createYg3ReadonlyMcpClient } from "./factory.js";
import { loadDiscoveryRawMapFromDir } from "./raw-loader.js";
import { projectYg3SnapshotV1 } from "./projector.js";
import {
  loadRepoDotenv,
  relayDataDirFromRepoModule,
  resolveRepoRootFromRelayModule,
} from "./repo-env.js";
import { Yg3RawResponseStore } from "./raw-store.js";
import { normalizeWhoamiIdentity } from "./sanitize.js";
import { Yg3SnapshotFileStore } from "./snapshot-file-store.js";
import { Yg3SnapshotMetaStore } from "./snapshot-meta.js";
import { isYg3McpEnabled } from "./url.js";
import { resolveWorkspaceForSync } from "./workspace-selector.js";
import type { MetricAvailability } from "./snapshot-v1.js";

loadRepoDotenv(import.meta.url);

const REPORT_PATH = "/tmp/ground-control-yg3-media-sync.txt";

type Buckets = { mapped: string[]; empty: string[]; unavailable: string[] };

function bucketMetrics(
  availability: Record<string, MetricAvailability>,
): Buckets {
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

function failReport(blocker: string, extra: Record<string, string> = {}): never {
  writeReport([
    "selected_workspace_verified=false",
    "selection_basis=none",
    "sync_success=false",
    "mapped=none",
    "empty=none",
    "unavailable=none",
    "selector_status=selection_required",
    "tests=not_run",
    "production_updated=false",
    `blocker=${blocker}`,
    ...Object.entries(extra).map(([k, v]) => `${k}=${v}`),
  ]);
  process.exit(1);
}

async function main(): Promise<void> {
  if (!isYg3McpEnabled()) {
    failReport("mcp_disabled");
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
    failReport("client_unavailable");
  }
  const mcp = client as NonNullable<typeof client>;

  let selectionBasis = "none";
  let selectorStatus = "selection_required";
  let prefetchedSnapshot: unknown | undefined;

  await mcp.runReadSession(async (call) => {
    raw.whoami = raw.whoami ?? (await call("whoami", {}));
    rawStore.write("whoami", raw.whoami, capturedAt);

    const picked = await resolveWorkspaceForSync({
      call,
      relayDataDir,
      whoamiPayload: raw.whoami,
    });
    if (!picked.ok) {
      writeReport([
        "selected_workspace_verified=false",
        "selection_basis=none",
        "sync_success=false",
        "mapped=none",
        "empty=none",
        "unavailable=none",
        `selector_status=${picked.selectorStatus}`,
        "tests=not_run",
        "production_updated=false",
        `blocker=${picked.blocker}`,
      ]);
      process.exit(1);
    }
    const clientId = picked.clientId;
    selectionBasis = picked.selectionBasis;
    selectorStatus = picked.selectorStatus;
    prefetchedSnapshot = picked.prefetchedSnapshot;

    const idArg = { client_id: clientId };
    raw.client_snapshots = [];
    raw.traffic_breakdowns = [];
    raw.search_opportunities = [];
    raw.leads = [];

    const snap =
      prefetchedSnapshot ??
      (await call("get_client_snapshot", {
        ...idArg,
        window: YG3_SYNC_WINDOW_DAYS,
      }));
    raw.client_snapshots!.push(snap);
    rawStore.write("get_client_snapshot_media", snap, capturedAt);

    const traffic = await call("show_traffic_breakdown", {
      ...idArg,
      window: YG3_SYNC_WINDOW_DAYS,
    });
    raw.traffic_breakdowns!.push(traffic);
    rawStore.write("show_traffic_breakdown_media", traffic, capturedAt);

    const opps = await call("get_search_opportunities", {
      ...idArg,
      limit: YG3_SYNC_OPPORTUNITY_LIMIT,
      days: YG3_SYNC_WINDOW_DAYS,
    });
    raw.search_opportunities!.push(opps);
    rawStore.write("get_search_opportunities_media", opps, capturedAt);

    const leads = await call("list_leads", {
      ...idArg,
      limit: YG3_SYNC_LEAD_LIMIT,
      window: YG3_SYNC_WINDOW_DAYS,
    });
    raw.leads!.push(leads);
    rawStore.write("list_leads_media", leads, capturedAt);
  });

  const identity = normalizeWhoamiIdentity(raw.whoami);
  const snapshot = projectYg3SnapshotV1(identity, capturedAt, raw, {
    allowClientScopedMetrics: true,
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
    /* snapshot file authoritative */
  }
  Yg3SnapshotFileStore.defaultPath(relayDataDir).saveAtomic(snapshot);

  const buckets = bucketMetrics(snapshot.metricAvailability);

  writeReport([
    "selected_workspace_verified=true",
    `selection_basis=${selectionBasis}`,
    "sync_success=true",
    `mapped=${buckets.mapped.join(",") || "none"}`,
    `empty=${buckets.empty.join(",") || "none"}`,
    `unavailable=${buckets.unavailable.join(",") || "none"}`,
    `selector_status=${selectorStatus}`,
    "tests=pending",
    "production_updated=false",
    "blocker=none",
  ]);

  console.log(
    JSON.stringify({
      selected_workspace_verified: true,
      selection_basis: selectionBasis,
      selector_status: selectorStatus,
      sync_success: true,
      production_updated: false,
    }),
  );
}

main().catch((err: unknown) => {
  const code =
    err instanceof Error ? err.name.replace(/[^a-zA-Z0-9_]/g, "_") : "error";
  writeReport([
    "selected_workspace_verified=false",
    "selection_basis=none",
    "sync_success=false",
    "mapped=none",
    "empty=none",
    "unavailable=none",
    "selector_status=selection_invalid",
    "tests=not_run",
    "production_updated=false",
    "blocker=media_sync_crashed",
    `error_code=${code}`,
  ]);
  process.exit(1);
});
