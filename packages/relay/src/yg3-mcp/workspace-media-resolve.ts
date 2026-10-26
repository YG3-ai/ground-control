import { joinMcpText, parseEmbeddedJsonArray, parseEmbeddedJsonObject } from "./mcp-content.js";
import { isTrustedClientUuid } from "./envelope-parsers.js";
import type { ParsedClientRow } from "./workspace-resolve.js";
import type { Yg3MediaSelectionBasis, Yg3MediaWorkspaceSelection } from "./workspace-media-select.js";

export type NarrowCandidate = ParsedClientRow & { label: string };

export type WebsiteLinkageEvidence =
  | "list_client_domains"
  | "client_snapshot"
  | "setup_health"
  | "list_clients_metadata";

export type WebsiteLinkageResult = {
  clientId: string;
  label: string;
  evidence: WebsiteLinkageEvidence[];
};

export function companyWebsiteHost(env: NodeJS.ProcessEnv = process.env): string {
  const raw =
    env.YG3_COMPANY_WEBSITE_HOST?.trim() ||
    env.YG3_SYNC_WORKSPACE_WEBSITE_HOST?.trim() ||
    "yg3.ai";
  return raw.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}

export function normalizeWorkspaceDisplayName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Narrow roster: normalized display name contains `yg3` or `media`. */
export function filterNarrowNameCandidates(
  clients: ParsedClientRow[],
): NarrowCandidate[] {
  const out: NarrowCandidate[] = [];
  const seen = new Set<string>();
  for (const c of clients) {
    if (!c.name || !isTrustedClientUuid(c.clientId)) continue;
    const n = normalizeWorkspaceDisplayName(c.name);
    if (!n.includes("yg3") && !n.includes("media")) continue;
    if (seen.has(c.clientId)) continue;
    seen.add(c.clientId);
    out.push({ ...c, label: c.name.trim() });
  }
  return out;
}

function hostMatchesCompanyWebsite(value: string, host: string): boolean {
  const v = value.toLowerCase();
  const h = host.toLowerCase();
  if (v === h || v.endsWith(`.${h}`)) return true;
  try {
    const u = v.includes("://") ? new URL(v) : new URL(`https://${v}`);
    const hn = u.hostname.toLowerCase();
    return hn === h || hn.endsWith(`.${h}`);
  } catch {
    return v.includes(h);
  }
}

export function payloadReferencesCompanyWebsite(
  payload: unknown,
  host: string,
): boolean {
  const text = joinMcpText(payload);
  if (text && hostMatchesCompanyWebsite(text, host)) return true;
  const obj = parseEmbeddedJsonObject(text);
  const arr = parseEmbeddedJsonArray(text);
  const stack: unknown[] = [];
  if (obj) stack.push(obj);
  if (arr) stack.push(...arr);
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    if (Array.isArray(cur)) {
      for (const v of cur) stack.push(v);
      continue;
    }
    for (const [k, v] of Object.entries(cur as Record<string, unknown>)) {
      const key = k.toLowerCase();
      if (
        typeof v === "string" &&
        (key.includes("domain") ||
          key.includes("website") ||
          key.includes("url") ||
          key.includes("site") ||
          key.includes("host")) &&
        hostMatchesCompanyWebsite(v, host)
      ) {
        return true;
      }
      if (typeof v === "string" && hostMatchesCompanyWebsite(v, host)) {
        return true;
      }
      if (v && typeof v === "object") stack.push(v);
    }
  }
  return false;
}

export function parseListClientsRowMetadata(
  listClientsPayload: unknown,
  clientId: string,
  host: string,
): boolean {
  const text = joinMcpText(listClientsPayload);
  const idNeedle = clientId.toLowerCase();
  if (!text.toLowerCase().includes(idNeedle)) return false;
  for (const line of text.split("\n")) {
    if (!line.toLowerCase().includes(idNeedle)) continue;
    if (hostMatchesCompanyWebsite(line, host)) return true;
  }
  return false;
}

export type ResolveByWebsiteInput = {
  candidates: NarrowCandidate[];
  host: string;
  domainsByClientId: Map<string, unknown>;
  snapshotByClientId: Map<string, unknown>;
  setupHealthByClientId: Map<string, unknown>;
  listClientsPayload?: unknown;
};

export function resolveUniqueWebsiteLinkage(
  input: ResolveByWebsiteInput,
): { ok: true; clientId: string; label: string; evidence: WebsiteLinkageEvidence[] } | { ok: false; matches: WebsiteLinkageResult[] } {
  const matches: WebsiteLinkageResult[] = [];
  for (const c of input.candidates) {
    const evidence: WebsiteLinkageEvidence[] = [];
    const domains = input.domainsByClientId.get(c.clientId);
    if (domains && payloadReferencesCompanyWebsite(domains, input.host)) {
      evidence.push("list_client_domains");
    }
    const snap = input.snapshotByClientId.get(c.clientId);
    if (snap && payloadReferencesCompanyWebsite(snap, input.host)) {
      evidence.push("client_snapshot");
    }
    const health = input.setupHealthByClientId.get(c.clientId);
    if (health && payloadReferencesCompanyWebsite(health, input.host)) {
      evidence.push("setup_health");
    }
    if (
      input.listClientsPayload &&
      parseListClientsRowMetadata(input.listClientsPayload, c.clientId, input.host)
    ) {
      evidence.push("list_clients_metadata");
    }
    if (evidence.length) {
      matches.push({ clientId: c.clientId, label: c.label, evidence });
    }
  }
  const sole = matches[0];
  if (matches.length === 1 && sole) {
    return {
      ok: true,
      clientId: sole.clientId,
      label: sole.label,
      evidence: sole.evidence,
    };
  }
  return { ok: false, matches };
}

export function toVerifiedSelection(
  clientId: string,
): Yg3MediaWorkspaceSelection {
  if (!isTrustedClientUuid(clientId)) {
    return { verified: false, reason: "not_found", candidateCount: 0 };
  }
  return {
    verified: true,
    clientId,
    basis: "company_website_linkage_authoritative" as Yg3MediaSelectionBasis,
  };
}
