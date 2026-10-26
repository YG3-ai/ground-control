/** Default official YG3 MCP resource URL (override with YG3_MCP_URL only). */
export const DEFAULT_YG3_MCP_URL = "https://mcp.yg3.ai/mcp";

export const YG3_OAUTH_SCOPE = "mcp";

/** Verified public OAuth metadata (used when discovery is overridden in tests). */
export const YG3_AUTHORIZATION_SERVER = "https://mcp.yg3.ai";
export const YG3_AUTHORIZATION_ENDPOINT =
  "https://agency.yg3.ai/api/mcp/oauth/authorize";
export const YG3_TOKEN_ENDPOINT = "https://mcp.yg3.ai/api/mcp/oauth/token";
export const YG3_REGISTRATION_ENDPOINT =
  "https://mcp.yg3.ai/api/mcp/oauth/register";

/** Minimal read-only tool allowlist (exact names). */
export const YG3_READ_TOOL_ALLOWLIST: readonly string[] = [
  "whoami",
  "get_client_snapshot",
  "get_daily_checkin",
  "get_setup_health",
  "list_client_domains",
  "list_client_connections",
  "list_clients",
  "list_leads",
  "show_traffic_breakdown",
  "list_replies",
  "list_inbox_messages",
  "list_search_queries",
  "get_search_opportunities",
  "list_tasks",
  "list_projects",
] as const;

export const YG3_FORBIDDEN_ARG_KEYS = new Set([
  "confirm",
  "idempotency_key",
  "idempotencyKey",
]);

export const YG3_SNAPSHOT_META_VERSION = 1;
export const YG3_SNAPSHOT_V1_VERSION = 1;

export const YG3_SYNC_MAX_CLIENTS = 5;
export const YG3_LIST_CLIENTS_LIMIT = 200;
export const YG3_SYNC_PROJECT_LIMIT = 50;
export const YG3_SYNC_TASK_LIMIT = 50;
export const YG3_SYNC_LEAD_LIMIT = 50;
export const YG3_SYNC_OPPORTUNITY_LIMIT = 25;
export const YG3_SYNC_WINDOW_DAYS = 30;

/** Owner cache-on-read TTL (no background polling). */
export const YG3_SNAPSHOT_TTL_MS = 5 * 60 * 1000;
export const YG3_SNAPSHOT_SYNC_BACKOFF_MS = 60_000;
