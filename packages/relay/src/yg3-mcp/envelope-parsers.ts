import { clampInt, clampString, pickNumber } from "./extract.js";
import {
  joinMcpText,
  parseEmbeddedJsonArray,
  parseEmbeddedJsonObject,
  parsePrettyJsonObjectSequence,
} from "./mcp-content.js";

export type ParsedWhoami = {
  agencyId: string | null;
  userId: string | null;
  role: string | null;
  principalType: string | null;
  scopeClientId: string | null;
  scopeClientDisplayName: string | null;
};

export type ParsedConnectionRollup = {
  clientsInScope: number | null;
  clientsNeedingAttention: number | null;
  statusCounts: Record<string, number>;
  lineCount: number;
};

export type ParsedProjectRow = {
  id: string;
  clientId: string | null;
  status: string | null;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isTrustedClientUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value.trim());
}

export function parseWhoamiEnvelope(payload: unknown): ParsedWhoami | null {
  const text = joinMcpText(payload);
  const obj = parseEmbeddedJsonObject(text);
  if (!obj) return null;
  const scopeClientId =
    typeof obj.scope_client_id === "string" ? obj.scope_client_id.trim() : null;
  const scopeName =
    typeof obj.scope_client_name === "string"
      ? obj.scope_client_name.trim()
      : null;
  return {
    agencyId:
      typeof obj.agency_id === "string" ? obj.agency_id.trim() : null,
    userId: typeof obj.user_id === "string" ? obj.user_id.trim() : null,
    role: typeof obj.role === "string" ? obj.role.trim() : null,
    principalType:
      typeof obj.principal_type === "string" ? obj.principal_type.trim() : null,
    scopeClientId: isTrustedClientUuid(scopeClientId) ? scopeClientId : null,
    scopeClientDisplayName:
      scopeName && !/@/.test(scopeName) ? clampString(scopeName, 64) : null,
  };
}

export function parseListProjectsEnvelope(
  payload: unknown,
): ParsedProjectRow[] {
  const text = joinMcpText(payload);
  const rows = parsePrettyJsonObjectSequence(text);
  const out: ParsedProjectRow[] = [];
  for (const o of rows) {
    const id = typeof o.id === "string" ? o.id.trim() : "";
    if (!id) continue;
    const projectId = id.slice(0, 64);
    const clientId =
      typeof o.client_id === "string" && isTrustedClientUuid(o.client_id)
        ? o.client_id.trim()
        : null;
    const status =
      typeof o.status === "string" ? o.status.trim().slice(0, 32) : null;
    out.push({ id: projectId, clientId, status });
  }
  return out;
}

export function parseListTasksEnvelope(payload: unknown): {
  total: number;
  open: number;
} {
  const text = joinMcpText(payload);
  const arr = parseEmbeddedJsonArray(text);
  if (!arr) return { total: 0, open: 0 };
  let open = 0;
  for (const row of arr) {
    if (!row || typeof row !== "object") continue;
    const status = String(
      (row as Record<string, unknown>).status ?? "",
    ).toLowerCase();
    if (!status || status.includes("open") || status.includes("active")) {
      open += 1;
    }
  }
  return { total: arr.length, open };
}

function normalizeConnectionStatusLabel(raw: string): string {
  const s = raw.toLowerCase();
  if (s.includes("all clear")) return "all_clear";
  if (s.includes("sync failing")) return "sync_failing";
  if (s.includes("disconnected")) return "disconnected";
  if (s.includes("connected")) return "connected";
  return clampString(s.replace(/[^a-z0-9_]+/g, "_"), 32);
}

/** Unique client names from connection lines that are not all_clear (plain-text envelope). */
export function extractSyncFailingClientName(payload: unknown): string | null {
  const names = extractAttentionClientNames(payload, (label) =>
    label.includes("sync_failing"),
  );
  const only = names[0];
  return names.length === 1 && only ? only : null;
}

export function extractSyncFailingClientSlug(payload: unknown): string | null {
  const text = joinMcpText(payload);
  const slugs: string[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!/sync failing/i.test(t)) continue;
    const m = t.match(/\[([a-z0-9][a-z0-9-]*)\]\s*\(id:/i);
    if (m?.[1]) slugs.push(m[1].toLowerCase());
  }
  const unique = [...new Set(slugs)];
  const only = unique[0];
  return unique.length === 1 && only ? only : null;
}

export function extractAttentionClientNames(
  payload: unknown,
  statusFilter?: (normalizedStatus: string) => boolean,
): string[] {
  const text = joinMcpText(payload);
  const names: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const t = line.trim();
    const dash = t.indexOf("—");
    if (dash < 0 || /clients in scope/i.test(t)) continue;
    const statusPart = t.slice(dash + 1).trim();
    const label = normalizeConnectionStatusLabel(statusPart);
    if (label === "all_clear") continue;
    if (statusFilter && !statusFilter(label)) continue;
    let namePart = t.startsWith("-") ? t.slice(1).trim() : t;
    namePart = namePart.slice(0, namePart.indexOf("—")).trim();
    if (!namePart || /@/.test(namePart)) continue;
    const key = namePart.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(clampString(namePart, 64));
  }
  return names;
}

export function parseListClientConnectionsEnvelope(
  payload: unknown,
): ParsedConnectionRollup {
  const text = joinMcpText(payload);
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const statusCounts: Record<string, number> = {};
  let clientsInScope: number | null = null;
  let clientsNeedingAttention: number | null = null;

  const header = lines.find((l) => /clients in scope/i.test(l));
  if (header) {
    const m = header.match(/(\d+)\s+clients in scope,\s*(\d+)\s+with/i);
    if (m) {
      clientsInScope = clampInt(pickNumber(m[1]));
      clientsNeedingAttention = clampInt(pickNumber(m[2]));
    }
  }

  for (const line of lines) {
    const dash = line.indexOf("—");
    if (dash < 0) continue;
    const statusPart = line.slice(dash + 1).trim();
    if (!statusPart) continue;
    const label = normalizeConnectionStatusLabel(statusPart);
    statusCounts[label] = (statusCounts[label] ?? 0) + 1;
  }

  return {
    clientsInScope,
    clientsNeedingAttention,
    statusCounts,
    lineCount: lines.length,
  };
}

const OPPORTUNITY_ARRAY_KEYS = [
  "opportunities",
  "items",
  "results",
  "strikeDistance",
  "lowCtr",
] as const;

export function parseSearchOpportunitiesEnvelope(payload: unknown): number | null {
  const labeled = sumLabeledCounts([payload], [
    "opportunities",
    "count",
    "total",
  ]);
  if (labeled !== null) return labeled;

  const text = joinMcpText(payload);
  if (!text) return null;
  const obj = parseEmbeddedJsonObject(text);
  if (!obj) return null;
  for (const key of OPPORTUNITY_ARRAY_KEYS) {
    const v = obj[key];
    if (Array.isArray(v)) return clampInt(v.length);
  }
  return null;
}

export type ParsedLeadsEnvelope =
  | { kind: "empty"; count: 0 }
  | { kind: "count"; count: number }
  | { kind: "unavailable" };

export function parseLeadsEnvelope(payload: unknown): ParsedLeadsEnvelope {
  const text = joinMcpText(payload).trim();
  if (!text) return { kind: "empty", count: 0 };
  if (/no\s+leads/i.test(text)) return { kind: "empty", count: 0 };
  const labeled = sumLabeledCounts([payload], ["leads", "count", "total"]);
  if (labeled !== null) {
    return labeled === 0
      ? { kind: "empty", count: 0 }
      : { kind: "count", count: labeled };
  }
  const arr = parseEmbeddedJsonArray(text);
  if (arr) {
    return arr.length === 0
      ? { kind: "empty", count: 0 }
      : { kind: "count", count: clampInt(arr.length) ?? 0 };
  }
  return { kind: "unavailable" };
}

export function parseDailyCheckinEnvelope(payload: unknown): {
  insightLines: string[];
} {
  const text = joinMcpText(payload);
  const insightLines: string[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (
      !t.startsWith("-") &&
      !t.startsWith("•") &&
      !/^\d+\./.test(t)
    ) {
      continue;
    }
    const cleaned = clampString(
      t.replace(/^[-•\d.]+\s*/, ""),
      120,
    );
    if (!cleaned || /@|mailto:/i.test(cleaned)) continue;
    if (/\b[A-Z][a-z]{2,}\s+[A-Z][a-z]{2,}\b/.test(cleaned) && cleaned.length > 40) {
      continue;
    }
    insightLines.push(cleaned);
    if (insightLines.length >= 3) break;
  }
  return { insightLines };
}

export function extractTrustedClientIds(
  whoami: ParsedWhoami | null,
  projects: ParsedProjectRow[],
  max: number,
): string[] {
  const ids: string[] = [];
  if (whoami?.scopeClientId && !ids.includes(whoami.scopeClientId)) {
    ids.push(whoami.scopeClientId);
  }
  for (const row of projects) {
    if (!row.clientId || ids.includes(row.clientId)) continue;
    ids.push(row.clientId);
    if (ids.length >= max) break;
  }
  return ids.slice(0, max);
}

/** Aggregate numeric `Label: 123` lines from MCP text blocks. */
export function parseLabeledCountsFromText(
  payload: unknown,
  labels: string[],
): Record<string, number> {
  const text = joinMcpText(payload);
  const out: Record<string, number> = {};
  for (const label of labels) {
    const re = new RegExp(`${label}\\s*[:=]\\s*(\\d+)`, "i");
    const m = text.match(re);
    if (m) {
      const n = clampInt(pickNumber(m[1]));
      if (n !== null) out[label.toLowerCase()] = n;
    }
  }
  return out;
}

export function sumLabeledCounts(
  payloads: unknown[],
  labels: string[],
): number | null {
  let sum = 0;
  let any = false;
  for (const p of payloads) {
    const counts = parseLabeledCountsFromText(p, labels);
    for (const v of Object.values(counts)) {
      sum += v;
      any = true;
    }
  }
  return any ? clampInt(sum) : null;
}
