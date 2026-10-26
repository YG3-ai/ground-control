import { joinMcpText, parseEmbeddedJsonObject } from "./mcp-content.js";
import { isTrustedClientUuid } from "./envelope-parsers.js";
import type { ParsedClientRow } from "./workspace-resolve.js";

export const YG3_MEDIA_WORKSPACE_DISPLAY_NAME = "YG3 Media";

const PLAIN_CLIENT_ID_RE =
  /\(id:\s*([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\)/gi;

export type Yg3MediaSelectionBasis =
  | "exact_display_name_cached_broad_list"
  | "exact_display_name_live_list_clients_query"
  | "exact_display_name_plus_company_website_domain"
  | "list_clients_query_singleton_plus_company_website_snapshot"
  | "company_website_linkage_authoritative"
  | "env_workspace_name"
  | "none";

export type Yg3MediaWorkspaceSelection =
  | {
      verified: true;
      clientId: string;
      basis: Yg3MediaSelectionBasis;
    }
  | {
      verified: false;
      reason: "not_found" | "ambiguous" | "no_domain_anchor";
      candidateCount: number;
    };

export function normalizeWorkspaceDisplayName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function filterExactDisplayName(
  clients: ParsedClientRow[],
  displayName: string,
): ParsedClientRow[] {
  const target = normalizeWorkspaceDisplayName(displayName);
  return clients.filter(
    (c) => c.name && normalizeWorkspaceDisplayName(c.name) === target,
  );
}

function companyWebsiteHost(env: NodeJS.ProcessEnv = process.env): string {
  const raw =
    env.YG3_COMPANY_WEBSITE_HOST?.trim() ||
    env.YG3_SYNC_WORKSPACE_WEBSITE_HOST?.trim() ||
    "yg3.ai";
  return raw.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}

function connectionLineForClient(
  clientConnectionsPayload: unknown,
  clientId: string,
): string | null {
  const text = joinMcpText(clientConnectionsPayload);
  for (const line of text.split("\n")) {
    PLAIN_CLIENT_ID_RE.lastIndex = 0;
    const m = PLAIN_CLIENT_ID_RE.exec(line);
    if (m?.[1]?.trim() === clientId) return line;
  }
  return null;
}

function lineReferencesCompanyWebsite(
  line: string,
  host: string,
): boolean {
  return line.toLowerCase().includes(host.toLowerCase());
}

function snapshotReferencesCompanyWebsite(
  snapshotPayload: unknown,
  host: string,
): boolean {
  const obj = parseEmbeddedJsonObject(joinMcpText(snapshotPayload));
  if (!obj) return false;
  const needle = host.toLowerCase();
  const stack: unknown[] = [obj];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    if (Array.isArray(cur)) {
      for (const v of cur) stack.push(v);
      continue;
    }
    for (const v of Object.values(cur as Record<string, unknown>)) {
      if (typeof v === "string" && v.toLowerCase().includes(needle)) return true;
      if (v && typeof v === "object") stack.push(v);
    }
  }
  return false;
}

export function selectYg3MediaWorkspaceFromQuerySingleton(opts: {
  query: string;
  clients: ParsedClientRow[];
  clientSnapshot?: unknown;
  clientConnections?: unknown;
  env?: NodeJS.ProcessEnv;
}): Yg3MediaWorkspaceSelection {
  const env = opts.env ?? process.env;
  const host = companyWebsiteHost(env);
  const exact = filterExactDisplayName(
    opts.clients,
    YG3_MEDIA_WORKSPACE_DISPLAY_NAME,
  );
  const exactSole = exact[0];
  if (exact.length === 1 && exactSole) {
    return {
      verified: true,
      clientId: exactSole.clientId,
      basis: "exact_display_name_live_list_clients_query",
    };
  }

  const sole = opts.clients[0];
  if (
    opts.clients.length !== 1 ||
    !sole ||
    !isTrustedClientUuid(sole.clientId)
  ) {
    return {
      verified: false,
      reason: "not_found",
      candidateCount: opts.clients.length,
    };
  }

  if (opts.clientConnections) {
    const line = connectionLineForClient(opts.clientConnections, sole.clientId);
    if (line && lineReferencesCompanyWebsite(line, host)) {
      return {
        verified: true,
        clientId: sole.clientId,
        basis: "list_clients_query_singleton_plus_company_website_snapshot",
      };
    }
  }

  if (
    opts.clientSnapshot &&
    snapshotReferencesCompanyWebsite(opts.clientSnapshot, host)
  ) {
    return {
      verified: true,
      clientId: sole.clientId,
      basis: "list_clients_query_singleton_plus_company_website_snapshot",
    };
  }

  return {
    verified: false,
    reason: "no_domain_anchor",
    candidateCount: 1,
  };
}

export function selectYg3MediaWorkspaceFromCache(opts: {
  clients: ParsedClientRow[];
  clientConnections?: unknown;
  displayName?: string;
  env?: NodeJS.ProcessEnv;
}): Yg3MediaWorkspaceSelection {
  const env = opts.env ?? process.env;
  const displayName =
    env.YG3_SYNC_WORKSPACE_NAME?.trim() ||
    opts.displayName ||
    YG3_MEDIA_WORKSPACE_DISPLAY_NAME;

  if (env.YG3_SYNC_WORKSPACE_NAME?.trim()) {
    const envHits = filterExactDisplayName(opts.clients, displayName);
    const sole = envHits[0];
    if (envHits.length === 1 && sole && isTrustedClientUuid(sole.clientId)) {
      return {
        verified: true,
        clientId: sole.clientId,
        basis: "env_workspace_name",
      };
    }
  }

  const candidates = filterExactDisplayName(opts.clients, displayName);
  if (!candidates.length) {
    return { verified: false, reason: "not_found", candidateCount: 0 };
  }
  if (candidates.length === 1) {
    const only = candidates[0];
    if (!only || !isTrustedClientUuid(only.clientId)) {
      return { verified: false, reason: "not_found", candidateCount: 0 };
    }
    return {
      verified: true,
      clientId: only.clientId,
      basis: "exact_display_name_cached_broad_list",
    };
  }

  if (!opts.clientConnections) {
    return {
      verified: false,
      reason: "ambiguous",
      candidateCount: candidates.length,
    };
  }

  const host = companyWebsiteHost(env);
  const domainHits = candidates.filter((c) => {
    const line = connectionLineForClient(opts.clientConnections, c.clientId);
    return line ? lineReferencesCompanyWebsite(line, host) : false;
  });
  const sole = domainHits[0];
  if (domainHits.length === 1 && sole) {
    return {
      verified: true,
      clientId: sole.clientId,
      basis: "exact_display_name_plus_company_website_domain",
    };
  }

  return {
    verified: false,
    reason: domainHits.length > 1 ? "ambiguous" : "no_domain_anchor",
    candidateCount: candidates.length,
  };
}
