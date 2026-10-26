import { join } from "node:path";
import {
  YG3_SYNC_LEAD_LIMIT,
  YG3_SYNC_OPPORTUNITY_LIMIT,
  YG3_SYNC_PROJECT_LIMIT,
  YG3_SYNC_TASK_LIMIT,
  YG3_SYNC_WINDOW_DAYS,
} from "./constants.js";
import type { Yg3ReadonlyMcpClient } from "./client.js";
import {
  parseListProjectsEnvelope,
  parseWhoamiEnvelope,
} from "./envelope-parsers.js";
import type { DiscoveryRawMap } from "./projector.js";
import { projectYg3SnapshotV1 } from "./projector.js";
import type { Yg3RawResponseStore } from "./raw-store.js";
import { normalizeWhoamiIdentity } from "./sanitize.js";
import type { Yg3SnapshotV1 } from "./snapshot-v1.js";
import { Yg3SnapshotFileStore } from "./snapshot-file-store.js";
import { Yg3SnapshotMetaStore } from "./snapshot-meta.js";
import { tryAcquireYg3SyncLock } from "./yg3-sync-lock.js";
import {
  sanitizeSyncErrorCode,
  Yg3SyncStatusStore,
  type Yg3SyncTrigger,
} from "./yg3-sync-status.js";
import { resolveWorkspaceForSync } from "./workspace-selector.js";

export type VerifiedOwnerSyncResult =
  | { ok: true; snapshot: Yg3SnapshotV1; skipped?: "already_running" }
  | { ok: false; errorCode: string; skipped?: "already_running" };

function projectArgs(): Record<string, unknown> {
  return { limit: YG3_SYNC_PROJECT_LIMIT, archived: false };
}

function taskArgs(): Record<string, unknown> {
  return { limit: YG3_SYNC_TASK_LIMIT, archived: false };
}

async function appendClientScopedReads(
  call: (tool: string, args: Record<string, unknown>) => Promise<unknown>,
  rawStore: Yg3RawResponseStore,
  clientId: string,
  capturedAt: string,
  raw: DiscoveryRawMap,
): Promise<void> {
  const idArg = { client_id: clientId };
  raw.client_snapshots = raw.client_snapshots ?? [];
  raw.traffic_breakdowns = raw.traffic_breakdowns ?? [];
  raw.search_opportunities = raw.search_opportunities ?? [];
  raw.leads = raw.leads ?? [];

  const snap = await call("get_client_snapshot", {
    ...idArg,
    window: YG3_SYNC_WINDOW_DAYS,
  });
  raw.client_snapshots.push(snap);
  rawStore.write("get_client_snapshot_verified", snap, capturedAt);

  try {
    const traffic = await call("show_traffic_breakdown", {
      ...idArg,
      window: YG3_SYNC_WINDOW_DAYS,
    });
    raw.traffic_breakdowns.push(traffic);
    rawStore.write("show_traffic_breakdown_verified", traffic, capturedAt);
  } catch {
    /* optional */
  }
  try {
    const opps = await call("get_search_opportunities", {
      ...idArg,
      limit: YG3_SYNC_OPPORTUNITY_LIMIT,
      days: YG3_SYNC_WINDOW_DAYS,
    });
    raw.search_opportunities.push(opps);
    rawStore.write("get_search_opportunities_verified", opps, capturedAt);
  } catch {
    /* optional */
  }
  try {
    const leads = await call("list_leads", {
      ...idArg,
      limit: YG3_SYNC_LEAD_LIMIT,
      window: YG3_SYNC_WINDOW_DAYS,
    });
    raw.leads.push(leads);
    rawStore.write("list_leads_verified", leads, capturedAt);
  } catch {
    /* optional */
  }
}

export async function runVerifiedOwnerYg3Sync(opts: {
  client: Yg3ReadonlyMcpClient;
  relayDataDir: string;
  rawStore: Yg3RawResponseStore;
  trigger: Yg3SyncTrigger;
}): Promise<VerifiedOwnerSyncResult> {
  const lock = tryAcquireYg3SyncLock(opts.relayDataDir);
  if (!lock) {
    return { ok: false, errorCode: "sync_already_running", skipped: "already_running" };
  }

  const statusStore = Yg3SyncStatusStore.defaultPath(opts.relayDataDir);
  const prior = statusStore.load();
  const capturedAt = new Date().toISOString();
  let identity = { tenantKey: "unknown-tenant", userKey: "unknown-user" };

  const writeStatus = (
    state: "running" | "ok" | "error",
    errorCode: string | null,
    attemptAt: string,
  ) => {
    const next = {
      version: 1 as const,
      tenantKey: identity.tenantKey,
      userKey: identity.userKey,
      state,
      lastAttemptAt: attemptAt,
      lastSuccessAt:
        state === "ok" ? attemptAt : (prior?.lastSuccessAt ?? null),
      lastTrigger: opts.trigger,
      lastErrorCode:
        state === "error" ? sanitizeSyncErrorCode(errorCode) : null,
    };
    statusStore.saveAtomic(next);
  };

  try {
    writeStatus("running", null, capturedAt);
    const raw: DiscoveryRawMap = {};

    await opts.client.runReadSession(async (call) => {
      raw.whoami = await call("whoami", {});
      opts.rawStore.write("whoami", raw.whoami, capturedAt);
      identity = normalizeWhoamiIdentity(raw.whoami);

      const picked = await resolveWorkspaceForSync({
        call,
        relayDataDir: opts.relayDataDir,
        whoamiPayload: raw.whoami,
      });
      if (!picked.ok) {
        throw new Error(picked.blocker);
      }

      try {
        raw.daily_checkin = await call("get_daily_checkin", {});
        opts.rawStore.write("get_daily_checkin", raw.daily_checkin, capturedAt);
      } catch {
        /* optional */
      }

      raw.client_connections = await call("list_client_connections", {});
      opts.rawStore.write(
        "list_client_connections",
        raw.client_connections,
        capturedAt,
      );

      try {
        raw.projects = await call("list_projects", projectArgs());
        opts.rawStore.write("list_projects", raw.projects, capturedAt);
      } catch {
        /* optional */
      }

      try {
        raw.tasks = await call("list_tasks", taskArgs());
        opts.rawStore.write("list_tasks", raw.tasks, capturedAt);
      } catch {
        /* optional */
      }

      parseListProjectsEnvelope(raw.projects);

      await appendClientScopedReads(
        (tool, args) => call(tool, args ?? {}),
        opts.rawStore,
        picked.clientId,
        capturedAt,
        raw,
      );
    });

    const snapshot = projectYg3SnapshotV1(identity, capturedAt, raw, {
      allowClientScopedMetrics: true,
    });

    try {
      const meta = Yg3SnapshotMetaStore.defaultPath(opts.relayDataDir);
      const cur = meta.load();
      if (!cur) meta.bindIdentity(identity);
      else if (
        cur.tenantKey === identity.tenantKey &&
        cur.userKey === identity.userKey
      ) {
        meta.touchWhoamiOk(identity);
      }
    } catch {
      /* snapshot still saved */
    }
    Yg3SnapshotFileStore.defaultPath(opts.relayDataDir).saveAtomic(snapshot);
    writeStatus("ok", null, capturedAt);
    return { ok: true, snapshot };
  } catch (err) {
    const code =
      err instanceof Error
        ? sanitizeSyncErrorCode(err.message) ?? "sync_failed"
        : "sync_failed";
    writeStatus("error", code, capturedAt);
    return { ok: false, errorCode: code ?? "sync_failed" };
  } finally {
    lock.release();
  }
}

export function resolveYg3SyncLogPath(relayDataDir: string, repoRoot: string): {
  out: string;
  err: string;
} {
  const logs = join(repoRoot, "logs");
  return {
    out: join(logs, "launchd-yg3-sync.out.log"),
    err: join(logs, "launchd-yg3-sync.err.log"),
  };
}
