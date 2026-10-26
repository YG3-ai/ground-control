import { assertOwnerYg3McpAccess, yg3McpConfigured } from "../yg3-mcp/access.js";
import { createYg3ReadonlyMcpClient } from "../yg3-mcp/factory.js";
import { Yg3RawResponseStore } from "../yg3-mcp/raw-store.js";
import {
  toPublicYg3SyncStatus,
  Yg3SyncStatusStore,
} from "../yg3-mcp/yg3-sync-status.js";
import { runVerifiedOwnerYg3Sync } from "../yg3-mcp/verified-owner-sync.js";
import { resolveYg3PathsFromRelayPackage } from "../yg3-mcp/snapshot-service.js";

export type Yg3SyncStatusPayload = {
  ok: boolean;
  enabled: boolean;
  status: ReturnType<typeof toPublicYg3SyncStatus>;
};

export type Yg3SyncTriggerPayload =
  | { ok: true; started: true }
  | { ok: true; skipped: "already_running" }
  | { ok: false; error: string };

export async function getYg3SyncStatus(
  audience: string,
  relayPackageRoot: string,
): Promise<Yg3SyncStatusPayload> {
  assertOwnerYg3McpAccess(audience);
  const enabled = yg3McpConfigured();
  if (!enabled) {
    return {
      ok: true,
      enabled: false,
      status: toPublicYg3SyncStatus(null),
    };
  }
  const { relayDataDir } = resolveYg3PathsFromRelayPackage(relayPackageRoot);
  const stored = Yg3SyncStatusStore.defaultPath(relayDataDir).load();
  return {
    ok: true,
    enabled: true,
    status: toPublicYg3SyncStatus(stored),
  };
}

export async function triggerYg3ManualSync(
  audience: string,
  relayPackageRoot: string,
): Promise<Yg3SyncTriggerPayload> {
  assertOwnerYg3McpAccess(audience);
  if (!yg3McpConfigured()) {
    return { ok: false, error: "mcp_disabled" };
  }
  const { repoRoot, relayDataDir } =
    resolveYg3PathsFromRelayPackage(relayPackageRoot);
  const client = createYg3ReadonlyMcpClient({
    relayDataDir,
    repoRoot,
    audience: "owner",
  });
  if (!client) {
    return { ok: false, error: "client_unavailable" };
  }
  const result = await runVerifiedOwnerYg3Sync({
    client,
    relayDataDir,
    rawStore: Yg3RawResponseStore.defaultPath(relayDataDir),
    trigger: "manual",
  });
  if (result.skipped === "already_running") {
    return { ok: true, skipped: "already_running" };
  }
  if (!result.ok) {
    return { ok: false, error: result.errorCode };
  }
  return { ok: true, started: true };
}
