import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Yg3RawEnvelope } from "./raw-store.js";
import type { DiscoveryRawMap } from "./projector.js";

function toolKeyFromEnvelope(tool: string): keyof DiscoveryRawMap | null {
  const t = tool.toLowerCase();
  if (t === "whoami") return "whoami";
  if (t === "get_daily_checkin") return "daily_checkin";
  if (t === "list_client_connections") return "client_connections";
  if (t === "list_clients") return "clients_list";
  if (t === "list_projects") return "projects";
  if (t === "list_tasks") return "tasks";
  if (t.startsWith("get_client_snapshot")) return "client_snapshots";
  if (t.startsWith("show_traffic_breakdown")) return "traffic_breakdowns";
  if (t.startsWith("get_search_opportunities")) return "search_opportunities";
  if (t.startsWith("list_leads")) return "leads";
  return null;
}

/** Load latest envelope per tool from ignored raw cache (payloads only). */
export function loadDiscoveryRawMapFromDir(rawDir: string): DiscoveryRawMap {
  const map: DiscoveryRawMap = {
    client_snapshots: [],
    traffic_breakdowns: [],
    search_opportunities: [],
    leads: [],
  };
  if (!existsSync(rawDir)) return map;

  const files = readdirSync(rawDir)
    .filter((f) => f.endsWith(".json"))
    .sort();

  let clientsBroad: unknown | undefined;
  let clientsQuery: unknown | undefined;

  for (const file of files) {
    try {
      const env = JSON.parse(
        readFileSync(join(rawDir, file), "utf8"),
      ) as Yg3RawEnvelope;
      const key = toolKeyFromEnvelope(env.tool);
      if (!key) continue;
      if (key === "clients_list") {
        if (env.tool === "list_clients_query") {
          clientsQuery = env.payload;
        } else if (env.tool === "list_clients") {
          clientsBroad = env.payload;
        }
        continue;
      }
      if (
        key === "client_snapshots" ||
        key === "traffic_breakdowns" ||
        key === "search_opportunities" ||
        key === "leads"
      ) {
        map[key]!.push(env.payload);
      } else {
        map[key] = env.payload;
      }
    } catch {
      /* skip corrupt file */
    }
  }
  if (clientsBroad !== undefined) map.clients_list = clientsBroad;
  else if (clientsQuery !== undefined) map.clients_list = clientsQuery;
  return map;
}

/** Broad `list_clients` envelope only (ignores query-narrowed cache). */
export function loadBroadListClientsPayload(rawDir: string): unknown | undefined {
  if (!existsSync(rawDir)) return undefined;
  let latest: unknown | undefined;
  for (const file of readdirSync(rawDir).filter((f) => f.endsWith(".json")).sort()) {
    try {
      const env = JSON.parse(
        readFileSync(join(rawDir, file), "utf8"),
      ) as Yg3RawEnvelope;
      if (env.tool === "list_clients") latest = env.payload;
    } catch {
      /* skip */
    }
  }
  return latest;
}
