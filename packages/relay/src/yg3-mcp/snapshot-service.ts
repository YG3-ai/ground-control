import { join } from "node:path";
import {
  YG3_SNAPSHOT_SYNC_BACKOFF_MS,
  YG3_SNAPSHOT_TTL_MS,
} from "./constants.js";
import { runBoundedYg3DiscoverySync } from "./discovery-sync.js";
import { createYg3ReadonlyMcpClient, resolveRelayDataDir } from "./factory.js";
import { Yg3RawResponseStore } from "./raw-store.js";
import { Yg3SnapshotFileStore } from "./snapshot-file-store.js";
import { Yg3SnapshotMetaStore } from "./snapshot-meta.js";
import type { Yg3SnapshotV1 } from "./snapshot-v1.js";
import { yg3McpConfigured } from "./access.js";

export type Yg3SnapshotLoadResult = {
  enabled: boolean;
  snapshot: Yg3SnapshotV1 | null;
  health: "ok" | "stale" | "unavailable";
  source: "yg3-mcp" | "none";
};

let inflight: Promise<Yg3SnapshotV1 | null> | null = null;
let lastFailedAt = 0;

export function clearYg3SnapshotFlightForTests(): void {
  inflight = null;
  lastFailedAt = 0;
}

function snapshotAgeMs(snapshot: Yg3SnapshotV1): number {
  const t = Date.parse(snapshot.syncedAt);
  return Number.isFinite(t) ? Date.now() - t : Number.POSITIVE_INFINITY;
}

export async function runYg3OwnerSync(opts: {
  repoRoot: string;
  relayDataDir: string;
  audience: string;
}): Promise<Yg3SnapshotLoadResult> {
  if (!yg3McpConfigured()) {
    return {
      enabled: false,
      snapshot: null,
      health: "unavailable",
      source: "none",
    };
  }
  const client = createYg3ReadonlyMcpClient({
    relayDataDir: opts.relayDataDir,
    repoRoot: opts.repoRoot,
    audience: opts.audience,
  });
  if (!client) {
    return {
      enabled: true,
      snapshot: null,
      health: "unavailable",
      source: "none",
    };
  }
  const rawStore = Yg3RawResponseStore.defaultPath(opts.relayDataDir);
  const fileStore = Yg3SnapshotFileStore.defaultPath(opts.relayDataDir);
  const meta = Yg3SnapshotMetaStore.defaultPath(opts.relayDataDir);

  const result = await runBoundedYg3DiscoverySync({ client, rawStore });
  if (!result.ok) {
    lastFailedAt = Date.now();
    const cached = fileStore.load();
    return {
      enabled: true,
      snapshot: cached,
      health: cached ? "stale" : "unavailable",
      source: cached ? "yg3-mcp" : "none",
    };
  }
  try {
    meta.bindIdentity({
      tenantKey: result.snapshot.tenantKey,
      userKey: result.snapshot.userKey,
    });
    const bound = meta.load();
    if (
      bound &&
      (bound.tenantKey !== result.snapshot.tenantKey ||
        bound.userKey !== result.snapshot.userKey)
    ) {
      throw new Error("tenant_identity_mismatch");
    }
    fileStore.saveAtomic(result.snapshot);
  } catch {
    lastFailedAt = Date.now();
    const cached = fileStore.load();
    return {
      enabled: true,
      snapshot: cached,
      health: cached ? "stale" : "unavailable",
      source: cached ? "yg3-mcp" : "none",
    };
  }
  return {
    enabled: true,
    snapshot: result.snapshot,
    health: "ok",
    source: "yg3-mcp",
  };
}

export async function loadYg3OwnerSnapshot(opts: {
  repoRoot: string;
  relayDataDir: string;
  audience: string;
  force?: boolean;
}): Promise<Yg3SnapshotLoadResult> {
  const fileStore = Yg3SnapshotFileStore.defaultPath(opts.relayDataDir);
  const cached = fileStore.load();
  if (!yg3McpConfigured()) {
    return {
      enabled: false,
      snapshot: cached,
      health: cached ? "stale" : "unavailable",
      source: "none",
    };
  }

  const fresh =
    cached &&
    !opts.force &&
    snapshotAgeMs(cached) <= YG3_SNAPSHOT_TTL_MS;
  if (fresh) {
    return {
      enabled: true,
      snapshot: cached,
      health: "ok",
      source: "yg3-mcp",
    };
  }

  if (Date.now() - lastFailedAt < YG3_SNAPSHOT_SYNC_BACKOFF_MS && cached) {
    return {
      enabled: true,
      snapshot: cached,
      health: "stale",
      source: "yg3-mcp",
    };
  }

  if (inflight) {
    const snap = await inflight;
    return {
      enabled: true,
      snapshot: snap ?? cached,
      health: snap ? "ok" : cached ? "stale" : "unavailable",
      source: snap || cached ? "yg3-mcp" : "none",
    };
  }

  inflight = runYg3OwnerSync(opts).then((r) => r.snapshot);
  try {
    const snap = await inflight;
    return {
      enabled: true,
      snapshot: snap ?? cached,
      health: snap ? "ok" : cached ? "stale" : "unavailable",
      source: snap || cached ? "yg3-mcp" : "none",
    };
  } finally {
    inflight = null;
  }
}

export function resolveYg3PathsFromRelayPackage(
  relayPackageRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): { repoRoot: string; relayDataDir: string } {
  const repoRoot = join(relayPackageRoot, "..", "..");
  return {
    repoRoot,
    relayDataDir: resolveRelayDataDir(repoRoot, env),
  };
}
