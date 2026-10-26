import { YG3_LIST_CLIENTS_LIMIT, YG3_SYNC_WINDOW_DAYS } from "./constants.js";
import { parseListClientsEnvelope } from "./workspace-resolve.js";
import {
  displayNameFromSnapshot,
  selectOwnerAuthorizedClientWorkspace,
  selectOwnerClientBySlugAndYg3NameHeuristic,
} from "./workspace-owner-select.js";
import type { McpReadCall } from "./media-identity-resolve.js";

export type OwnerClientResolution =
  | {
      verified: true;
      clientId: string;
      selectionBasis: "client_type+exact_normalized_slug+yg3_name";
      prefetchedSnapshot: unknown;
      listClientsPayload: unknown;
    }
  | {
      verified: false;
      reason: string;
      narrowCandidateCount: number;
      candidateLabels: string[];
    };

function mergeClientRows(
  ...groups: ReturnType<typeof parseListClientsEnvelope>[]
): ReturnType<typeof parseListClientsEnvelope> {
  const out: ReturnType<typeof parseListClientsEnvelope> = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const row of group) {
      if (seen.has(row.clientId)) continue;
      seen.add(row.clientId);
      out.push(row);
    }
  }
  return out;
}

function narrowYg3MediaCandidates(
  clients: ReturnType<typeof parseListClientsEnvelope>,
): ReturnType<typeof parseListClientsEnvelope> {
  const out: ReturnType<typeof parseListClientsEnvelope> = [];
  const seen = new Set<string>();
  for (const row of clients) {
    const label = (row.name || "").toLowerCase();
    const slug = (row.slug || "").toLowerCase();
    if (!label.includes("yg3") && !slug.includes("media")) {
      continue;
    }
    if (seen.has(row.clientId)) continue;
    seen.add(row.clientId);
    out.push(row);
  }
  return out;
}

function candidateLabelsFromRows(
  clients: ReturnType<typeof parseListClientsEnvelope>,
  snapshotByClientId: Map<string, unknown>,
): string[] {
  const labels: string[] = [];
  for (const row of clients) {
    const snap = snapshotByClientId.get(row.clientId);
    const label = (snap ? displayNameFromSnapshot(snap) : null) ?? row.name;
    const t = (label || "").trim();
    if (!t) continue;
    const low = t.toLowerCase();
    if (!low.includes("yg3") && !low.includes("media")) continue;
    labels.push(t);
  }
  return [...new Set(labels)].sort();
}

export async function resolveOwnerAuthorizedClientWorkspace(
  call: McpReadCall,
): Promise<OwnerClientResolution> {
  const listPayload = await call("list_clients", {
    include_archived: true,
    limit: YG3_LIST_CLIENTS_LIMIT,
  });
  const allClients = parseListClientsEnvelope(listPayload);
  const yg3QueryPayload = await call("list_clients", {
    include_archived: true,
    limit: YG3_LIST_CLIENTS_LIMIT,
    query: "YG3",
  });
  const yg3QueryClients = parseListClientsEnvelope(yg3QueryPayload);
  const narrow = mergeClientRows(
    narrowYg3MediaCandidates(allClients),
    yg3QueryClients.filter((row) =>
      (row.name || "").toLowerCase().includes("yg3"),
    ),
  );

  const snapshotByClientId = new Map<string, unknown>();
  for (const row of narrow) {
    snapshotByClientId.set(
      row.clientId,
      await call("get_client_snapshot", {
        client_id: row.clientId,
        window: YG3_SYNC_WINDOW_DAYS,
      }),
    );
  }

  const exact = selectOwnerAuthorizedClientWorkspace({
    clients: narrow,
    snapshotByClientId,
    requireCorroboratingName: false,
  });
  let chosen = exact;
  if (!exact.verified) {
    chosen = selectOwnerClientBySlugAndYg3NameHeuristic({
      clients: narrow,
      snapshotByClientId,
    });
  }

  if (!chosen.verified) {
    return {
      verified: false,
      reason: chosen.reason,
      narrowCandidateCount: narrow.length,
      candidateLabels: candidateLabelsFromRows(narrow, snapshotByClientId),
    };
  }

  const prefetched = snapshotByClientId.get(chosen.clientId);
  return {
    verified: true,
    clientId: chosen.clientId,
    selectionBasis: chosen.selectionBasis,
    prefetchedSnapshot: prefetched,
    listClientsPayload: listPayload,
  };
}
