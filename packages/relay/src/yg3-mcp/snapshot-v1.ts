import { YG3_SNAPSHOT_V1_VERSION } from "./constants.js";

export type MetricAvailability =
  | "mapped"
  | "empty"
  | "unavailable"
  | "skipped";

export type Yg3SnapshotV1 = {
  version: typeof YG3_SNAPSHOT_V1_VERSION;
  tenantKey: string;
  userKey: string;
  syncedAt: string;
  roleCategory: string;
  connection: {
    health: "ok" | "degraded" | "unavailable";
    checkinPresent: boolean;
  };
  workspace: {
    clientCount: number;
    connectedCount: number;
    clientsInScope: number | null;
    clientsNeedingAttention: number | null;
    statusCounts: Record<string, number>;
    projectStatusCounts: Record<string, number>;
    /** Private-only; from whoami scope_client_name when explicitly scoped. */
    privateScopedDisplayName: string | null;
  };
  growth: {
    windowDays: number;
    visits: number | null;
    leads: number | null;
    opportunities: number | null;
    trafficRows: { key: string; label: string; count: number }[];
  };
  projects: { total: number; active: number };
  tasks: { total: number; open: number };
  insights: { id: string; kicker: string; body: string; tone: string }[];
  recommendations: {
    id: string;
    title: string;
    metric: string;
    kind: "decision" | "build" | "proof";
    detail: Record<string, unknown>;
  }[];
  metricAvailability: Record<string, MetricAvailability>;
};

export function emptyMetricAvailability(): Record<string, MetricAvailability> {
  return {
    whoami: "unavailable",
    daily_checkin: "unavailable",
    client_connections: "unavailable",
    projects: "unavailable",
    tasks: "unavailable",
    list_clients: "unavailable",
    client_snapshot: "unavailable",
    traffic_breakdown: "unavailable",
    search_opportunities: "unavailable",
    leads: "unavailable",
  };
}
