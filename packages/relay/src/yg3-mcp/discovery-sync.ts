import {
  YG3_SYNC_LEAD_LIMIT,
  YG3_SYNC_MAX_CLIENTS,
  YG3_SYNC_OPPORTUNITY_LIMIT,
  YG3_SYNC_PROJECT_LIMIT,
  YG3_SYNC_TASK_LIMIT,
  YG3_SYNC_WINDOW_DAYS,
} from "./constants.js";
import type { Yg3ReadonlyMcpClient } from "./client.js";
import {
  extractTrustedClientIds,
  parseListProjectsEnvelope,
  parseWhoamiEnvelope,
} from "./envelope-parsers.js";
import { projectYg3SnapshotV1, type DiscoveryRawMap } from "./projector.js";
import type { Yg3RawResponseStore } from "./raw-store.js";
import { normalizeWhoamiIdentity } from "./sanitize.js";
import type { Yg3SnapshotV1 } from "./snapshot-v1.js";

export type SyncResult =
  | { ok: true; snapshot: Yg3SnapshotV1 }
  | { ok: false; error: string };

function projectArgs(): Record<string, unknown> {
  return { limit: YG3_SYNC_PROJECT_LIMIT, archived: false };
}

function taskArgs(): Record<string, unknown> {
  return { limit: YG3_SYNC_TASK_LIMIT, archived: false };
}

export async function runBoundedYg3DiscoverySync(opts: {
  client: Yg3ReadonlyMcpClient;
  rawStore: Yg3RawResponseStore;
}): Promise<SyncResult> {
  const capturedAt = new Date().toISOString();
  const raw: DiscoveryRawMap = {};

  try {
    await opts.client.runReadSession(async (call) => {
      raw.whoami = await call("whoami", {});
      opts.rawStore.write("whoami", raw.whoami, capturedAt);

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
        /* shape unclear */
      }

      try {
        raw.tasks = await call("list_tasks", taskArgs());
        opts.rawStore.write("list_tasks", raw.tasks, capturedAt);
      } catch {
        /* shape unclear */
      }

      const clientIds = extractTrustedClientIds(
        parseWhoamiEnvelope(raw.whoami),
        parseListProjectsEnvelope(raw.projects),
        YG3_SYNC_MAX_CLIENTS,
      );
      raw.client_snapshots = [];
      raw.traffic_breakdowns = [];
      raw.search_opportunities = [];
      raw.leads = [];

      for (const clientId of clientIds) {
        const idArg = { client_id: clientId };
        try {
          const snap = await call("get_client_snapshot", {
            ...idArg,
            window: YG3_SYNC_WINDOW_DAYS,
          });
          raw.client_snapshots!.push(snap);
          opts.rawStore.write(
            `get_client_snapshot_${clientIds.indexOf(clientId)}`,
            snap,
            capturedAt,
          );
        } catch {
          /* skip client */
        }
        try {
          const traffic = await call("show_traffic_breakdown", {
            ...idArg,
            window: YG3_SYNC_WINDOW_DAYS,
          });
          raw.traffic_breakdowns!.push(traffic);
          opts.rawStore.write(
            `show_traffic_breakdown_${clientIds.indexOf(clientId)}`,
            traffic,
            capturedAt,
          );
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
          opts.rawStore.write(
            `get_search_opportunities_${clientIds.indexOf(clientId)}`,
            opps,
            capturedAt,
          );
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
          opts.rawStore.write(
            `list_leads_${clientIds.indexOf(clientId)}`,
            leads,
            capturedAt,
          );
        } catch {
          /* skip */
        }
      }
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "discovery_failed",
    };
  }

  const identity = normalizeWhoamiIdentity(raw.whoami);
  const snapshot = projectYg3SnapshotV1(identity, capturedAt, raw);
  return { ok: true, snapshot };
}
