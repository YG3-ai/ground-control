import { YG3_SNAPSHOT_V1_VERSION, YG3_SYNC_WINDOW_DAYS } from "./constants.js";
import { clampInt } from "./extract.js";
import {
  parseDailyCheckinEnvelope,
  parseListClientConnectionsEnvelope,
  parseListProjectsEnvelope,
  parseListTasksEnvelope,
  parseWhoamiEnvelope,
  parseLeadsEnvelope,
  parseLabeledCountsFromText,
  parseSearchOpportunitiesEnvelope,
  sumLabeledCounts,
} from "./envelope-parsers.js";
import { joinMcpText, parseEmbeddedJsonObject } from "./mcp-content.js";
import { parseListClientsEnvelope } from "./workspace-resolve.js";
import type { Yg3SnapshotV1 } from "./snapshot-v1.js";
import { emptyMetricAvailability } from "./snapshot-v1.js";
import {
  normalizeWhoamiIdentity,
  roleCategoryFromWhoami,
} from "./sanitize.js";

export type DiscoveryRawMap = {
  whoami?: unknown;
  daily_checkin?: unknown;
  client_connections?: unknown;
  clients_list?: unknown;
  projects?: unknown;
  tasks?: unknown;
  client_snapshots?: unknown[];
  traffic_breakdowns?: unknown[];
  search_opportunities?: unknown[];
  leads?: unknown[];
};

export type ProjectYg3SnapshotOptions = {
  /** When false, client-scoped raw envelopes are not mapped into growth metrics. */
  allowClientScopedMetrics?: boolean;
};

function trafficRowsFromTextPayloads(payloads: unknown[]): Yg3SnapshotV1["growth"]["trafficRows"] {
  const rows: Yg3SnapshotV1["growth"]["trafficRows"] = [];
  for (const p of payloads) {
    const counts = parseLabeledCountsFromText(p, [
      "Organic",
      "Direct",
      "Paid",
      "Social",
      "Referral",
      "Email",
      "Unique visitors",
      "Repeat visits",
    ]);
    for (const [label, count] of Object.entries(counts)) {
      rows.push({
        key: label.replace(/\s+/g, "_"),
        label: label.charAt(0).toUpperCase() + label.slice(1),
        count,
      });
      if (rows.length >= 8) return rows;
    }
  }
  return rows;
}

export function projectYg3SnapshotV1(
  identity: ReturnType<typeof normalizeWhoamiIdentity>,
  syncedAt: string,
  raw: DiscoveryRawMap,
  options: ProjectYg3SnapshotOptions = {},
): Yg3SnapshotV1 {
  const allowClient = options.allowClientScopedMetrics !== false;
  const metrics = emptyMetricAvailability();
  const whoamiParsed = raw.whoami
    ? parseWhoamiEnvelope(raw.whoami)
    : null;
  const connectionsParsed = raw.client_connections
    ? parseListClientConnectionsEnvelope(raw.client_connections)
    : null;
  const projectsParsed = raw.projects
    ? parseListProjectsEnvelope(raw.projects)
    : [];
  const tasksParsed = raw.tasks
    ? parseListTasksEnvelope(raw.tasks)
    : { total: 0, open: 0 };
  const checkinParsed = raw.daily_checkin
    ? parseDailyCheckinEnvelope(raw.daily_checkin)
    : { insightLines: [] };
  const clientsListed = raw.clients_list
    ? parseListClientsEnvelope(raw.clients_list)
    : [];

  if (raw.whoami !== undefined) metrics.whoami = whoamiParsed ? "mapped" : "skipped";
  if (raw.clients_list !== undefined) {
    metrics.list_clients = clientsListed.length ? "mapped" : "skipped";
  }
  if (raw.daily_checkin !== undefined) {
    const checkinText = joinMcpText(raw.daily_checkin);
    if (!checkinText) {
      metrics.daily_checkin = "unavailable";
    } else if (checkinParsed.insightLines.length) {
      metrics.daily_checkin = "mapped";
    } else {
      metrics.daily_checkin = "empty";
    }
  }
  if (raw.client_connections !== undefined) {
    metrics.client_connections = connectionsParsed ? "mapped" : "skipped";
  }
  if (raw.projects !== undefined) {
    metrics.projects = projectsParsed.length ? "mapped" : "skipped";
  }
  if (raw.tasks !== undefined) metrics.tasks = "mapped";

  const statusCounts = connectionsParsed?.statusCounts ?? {};
  const allClear = statusCounts.all_clear ?? 0;
  const statusLineCount = Object.values(statusCounts).reduce((a, b) => a + b, 0);
  const clientCount =
    clientsListed.length ||
    connectionsParsed?.clientsInScope ||
    statusLineCount;
  const connectedCount = allClear;

  const projectStatusCounts: Record<string, number> = {};
  for (const row of projectsParsed) {
    const s = row.status ?? "unknown";
    projectStatusCounts[s] = (projectStatusCounts[s] ?? 0) + 1;
  }

  let visits: number | null = null;
  let leads: number | null = null;
  let opportunities: number | null = null;
  let trafficRows: Yg3SnapshotV1["growth"]["trafficRows"] = [];

  const clientSnapshots = allowClient ? raw.client_snapshots : undefined;
  const trafficPayloads = allowClient ? raw.traffic_breakdowns : undefined;
  const opportunityPayloads = allowClient ? raw.search_opportunities : undefined;
  const leadPayloads = allowClient ? raw.leads : undefined;

  if (!allowClient) {
    if (raw.client_snapshots?.length) metrics.client_snapshot = "unavailable";
    if (raw.traffic_breakdowns?.length) metrics.traffic_breakdown = "unavailable";
    if (raw.search_opportunities?.length) {
      metrics.search_opportunities = "unavailable";
    }
    if (raw.leads?.length) metrics.leads = "unavailable";
  }

  if (clientSnapshots?.length) {
    const hasJson = clientSnapshots.some(
      (p) => parseEmbeddedJsonObject(joinMcpText(p)) !== null,
    );
    const labeled =
      sumLabeledCounts(clientSnapshots, ["Visits", "visits"]) ??
      sumLabeledCounts(clientSnapshots, ["sessions", "Sessions"]) ??
      sumLabeledCounts(clientSnapshots, ["pageviews", "traffic"]);
    visits = labeled;
    if (labeled !== null) {
      metrics.client_snapshot = "mapped";
    } else if (hasJson) {
      metrics.client_snapshot = "empty";
    } else {
      metrics.client_snapshot = "unavailable";
    }
  } else if (clientSnapshots) {
    metrics.client_snapshot = "skipped";
  }

  if (trafficPayloads?.length) {
    trafficRows = trafficRowsFromTextPayloads(trafficPayloads);
    const trafficText = trafficPayloads.some((p) => joinMcpText(p));
    if (trafficRows.length) {
      metrics.traffic_breakdown = "mapped";
      if (visits === null) {
        visits =
          sumLabeledCounts(trafficPayloads, [
            "Unique visitors",
            "unique visitors",
          ]) ?? visits;
      }
    } else if (trafficText) {
      metrics.traffic_breakdown = "empty";
    } else {
      metrics.traffic_breakdown = "unavailable";
    }
  }

  if (opportunityPayloads?.length) {
    let oppTotal = 0;
    let oppState: "unavailable" | "empty" | "mapped" = "unavailable";
    for (const p of opportunityPayloads) {
      const n = parseSearchOpportunitiesEnvelope(p);
      if (n === null) continue;
      oppTotal += n;
      oppState = n === 0 ? "empty" : "mapped";
    }
    if (oppState !== "unavailable") {
      opportunities = clampInt(oppTotal);
      metrics.search_opportunities = oppState;
    } else if (joinMcpText(opportunityPayloads[0])) {
      metrics.search_opportunities = "unavailable";
    }
  }

  if (leadPayloads?.length) {
    let leadTotal = 0;
    let leadMetric: "unavailable" | "empty" | "mapped" = "unavailable";
    for (const p of leadPayloads) {
      const parsed = parseLeadsEnvelope(p);
      if (parsed.kind === "unavailable") continue;
      if (parsed.kind === "empty") {
        leadMetric = "empty";
        leadTotal = 0;
      } else {
        leadTotal += parsed.count;
        leadMetric = parsed.count === 0 ? "empty" : "mapped";
      }
    }
    if (leadMetric !== "unavailable") {
      leads = clampInt(leadTotal);
      metrics.leads = leadMetric;
    }
  }

  const insights = checkinParsed.insightLines.map((body, idx) => ({
    id: `checkin-${idx}`,
    kicker: "Check-in",
    body,
    tone: "neutral",
  }));

  const recommendations = insights.slice(0, 3).map((i, idx) => ({
    id: `checkin-${idx}`,
    title: i.body.length > 96 ? `${i.body.slice(0, 93)}…` : i.body,
    metric: "daily check-in",
    kind: "proof" as const,
    detail: { kicker: i.kicker, body: i.body },
  }));

  const roleCategory = raw.whoami
    ? roleCategoryFromWhoami(parseWhoamiEnvelope(raw.whoami) ?? {})
    : "unknown";

  let health: Yg3SnapshotV1["connection"]["health"] = "ok";
  if (!whoamiParsed) health = "unavailable";
  else if (!connectionsParsed) health = "degraded";

  const activeProjects = projectsParsed.filter(
    (p) => (p.status ?? "").toLowerCase() === "active",
  ).length;

  return {
    version: YG3_SNAPSHOT_V1_VERSION,
    tenantKey: identity.tenantKey,
    userKey: identity.userKey,
    syncedAt,
    roleCategory,
    connection: {
      health,
      checkinPresent: Boolean(raw.daily_checkin),
    },
    workspace: {
      clientCount,
      connectedCount,
      clientsInScope: connectionsParsed?.clientsInScope ?? null,
      clientsNeedingAttention:
        connectionsParsed?.clientsNeedingAttention ?? null,
      statusCounts,
      projectStatusCounts,
      privateScopedDisplayName: whoamiParsed?.scopeClientDisplayName ?? null,
    },
    growth: {
      windowDays: YG3_SYNC_WINDOW_DAYS,
      visits,
      leads,
      opportunities,
      trafficRows,
    },
    projects: { total: projectsParsed.length, active: activeProjects },
    tasks: { total: tasksParsed.total, open: tasksParsed.open },
    insights: insights.slice(0, 3),
    recommendations,
    metricAvailability: metrics,
  };
}
