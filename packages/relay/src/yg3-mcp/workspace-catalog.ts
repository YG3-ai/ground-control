import { YG3_LIST_CLIENTS_LIMIT, YG3_SYNC_WINDOW_DAYS } from "./constants.js";
import { isTrustedClientUuid } from "./envelope-parsers.js";
import {
  displayNameCorroborates,
  displayNameFromSnapshot,
  ownerSlugAuthorityMatch,
  slugFromSnapshot,
} from "./workspace-owner-select.js";
import {
  normalizeWorkspaceSlug,
  parseListClientsEnvelope,
  type ParsedClientRow,
} from "./workspace-resolve.js";
import { classifyWorkspaceAccountKind } from "./workspace-account-kind.js";
import type { McpReadCall } from "./media-identity-resolve.js";

export type WorkspaceSearchHit = {
  ref: number;
  displayName: string;
  slugNormalized: string | null;
  accountKind: "client" | "agency";
};

function queryTokens(query: string): string[] {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function rowMatchesQuery(
  row: ParsedClientRow,
  slug: string | null,
  tokens: string[],
): boolean {
  const name = (row.name || "").toLowerCase();
  const slugNorm = (slug || row.slug || "").toLowerCase();
  const blob = `${name} ${slugNorm}`;
  return tokens.every((t) => blob.includes(t) || slugNorm.includes(t.replace(/\s+/g, "-")));
}

export type WorkspaceSearchBundle = {
  hits: WorkspaceSearchHit[];
  clientIdByRef: Map<number, string>;
};

export async function searchWorkspaceClients(
  call: McpReadCall,
  query: string,
  opts?: { includeSnapshots?: boolean; maxResults?: number },
): Promise<WorkspaceSearchHit[]> {
  return (await searchWorkspaceClientsBundle(call, query, opts)).hits;
}

export async function searchWorkspaceClientsBundle(
  call: McpReadCall,
  query: string,
  opts?: { includeSnapshots?: boolean; maxResults?: number },
): Promise<WorkspaceSearchBundle> {
  const tokens = queryTokens(query);
  if (!tokens.length) return { hits: [], clientIdByRef: new Map() };

  const max = opts?.maxResults ?? 25;
  const payloads = [
    await call("list_clients", {
      include_archived: true,
      limit: YG3_LIST_CLIENTS_LIMIT,
      query,
    }),
  ];
  if (query.toLowerCase().includes("yg3")) {
    payloads.push(
      await call("list_clients", {
        include_archived: true,
        limit: YG3_LIST_CLIENTS_LIMIT,
        query: "YG3",
      }),
    );
  }

  const rows: ParsedClientRow[] = [];
  const seen = new Set<string>();
  for (const p of payloads) {
    for (const row of parseListClientsEnvelope(p)) {
      if (!isTrustedClientUuid(row.clientId) || seen.has(row.clientId)) continue;
      seen.add(row.clientId);
      rows.push(row);
    }
  }

  const hits: WorkspaceSearchHit[] = [];
  const clientIdByRef = new Map<number, string>();
  let ref = 1;
  for (const row of rows) {
    let snap: unknown | undefined;
    if (opts?.includeSnapshots !== false) {
      snap = await call("get_client_snapshot", {
        client_id: row.clientId,
        window: YG3_SYNC_WINDOW_DAYS,
      });
    }
    const slug =
      (snap ? slugFromSnapshot(snap) : null) ??
      (row.slug ? normalizeWorkspaceSlug(row.slug) : null);
    if (!rowMatchesQuery(row, slug, tokens)) continue;
    const accountKind = classifyWorkspaceAccountKind(row, snap);
    const displayName =
      (snap ? displayNameFromSnapshot(snap) : null) ?? row.name ?? "Workspace";
    hits.push({
      ref,
      displayName,
      slugNormalized: slug,
      accountKind,
    });
    clientIdByRef.set(ref, row.clientId);
    ref += 1;
    if (hits.length >= max) break;
  }
  return { hits, clientIdByRef };
}

export function pickClientOnlySearchHits(
  hits: WorkspaceSearchHit[],
): WorkspaceSearchHit[] {
  return hits.filter((h) => h.accountKind === "client");
}

export function findClientRowBySlug(
  rows: ParsedClientRow[],
  snapshotByClientId: Map<string, unknown>,
  slugNormalized: string,
  requireCorroboratingName: boolean,
): ParsedClientRow | null {
  const matches: ParsedClientRow[] = [];
  for (const row of rows) {
    const snap = snapshotByClientId.get(row.clientId);
    if (classifyWorkspaceAccountKind(row, snap) !== "client") continue;
    const slug =
      (snap ? slugFromSnapshot(snap) : null) ??
      (row.slug ? normalizeWorkspaceSlug(row.slug) : null);
    if (!slug || !ownerSlugAuthorityMatch(slug, slugNormalized)) continue;
    const name =
      (snap ? displayNameFromSnapshot(snap) : null) ?? row.name ?? null;
    if (
      requireCorroboratingName &&
      !displayNameCorroborates(name) &&
      !(name || "").toLowerCase().includes("yg3")
    ) {
      continue;
    }
    matches.push(row);
  }
  const sole = matches[0];
  return matches.length === 1 && sole ? sole : null;
}
