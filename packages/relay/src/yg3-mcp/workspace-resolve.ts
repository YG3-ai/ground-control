import type { ParsedWhoami } from "./envelope-parsers.js";
import { isTrustedClientUuid } from "./envelope-parsers.js";
import {
  joinMcpText,
  parseEmbeddedJsonArray,
  parsePrettyJsonObjectSequence,
} from "./mcp-content.js";
import { clampString } from "./extract.js";

export type ParsedClientRow = {
  clientId: string;
  name: string | null;
  slug: string | null;
};

export type WorkspaceResolution =
  | {
      ok: true;
      clientId: string;
      privateDisplayName: string | null;
    }
  | {
      ok: false;
      reason: "ambiguous" | "none";
      candidateCount: number;
    };

function clientIdFromObject(o: Record<string, unknown>): string | null {
  for (const key of ["client_id", "clientId", "id"]) {
    const v = o[key];
    if (typeof v === "string" && isTrustedClientUuid(v)) return v.trim();
  }
  return null;
}

function nameFromObject(o: Record<string, unknown>): string | null {
  for (const key of ["name", "client_name", "clientName", "display_name"]) {
    const v = o[key];
    if (typeof v === "string" && v.trim() && !/@/.test(v)) {
      return clampString(v.trim(), 64);
    }
  }
  return null;
}

const PLAIN_CLIENT_ID_RE =
  /\(id:\s*([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\)/gi;

export function normalizeWorkspaceSlug(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase()
    .replace(/[_\-–—/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function slugFromPlainLine(line: string): string | null {
  const m = line.match(/\[([^\]]+)\]\s*\(id:/i);
  return m?.[1] ? m[1].trim() : null;
}

function parseListClientsPlainText(text: string): ParsedClientRow[] {
  const out: ParsedClientRow[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("-")) continue;
    PLAIN_CLIENT_ID_RE.lastIndex = 0;
    const m = PLAIN_CLIENT_ID_RE.exec(t);
    if (!m?.[1] || !isTrustedClientUuid(m[1])) continue;
    const clientId = m[1].trim();
    if (seen.has(clientId)) continue;
    seen.add(clientId);
    const afterDash = t.slice(1).trim();
    const bracket = afterDash.match(/^(.+?)\s+\[([^\]]+)\]\s+\(id:/i);
    let name: string | null = null;
    if (bracket?.[1]) {
      name = clampString(bracket[1].trim(), 64);
    } else {
      const nameEnd = afterDash.indexOf("—");
      name =
        nameEnd > 0 ? clampString(afterDash.slice(0, nameEnd).trim(), 64) : null;
    }
    out.push({
      clientId,
      name: name && !/@/.test(name) ? name : null,
      slug: (() => {
        const raw = slugFromPlainLine(t);
        return raw ? normalizeWorkspaceSlug(raw) : null;
      })(),
    });
  }
  return out;
}

export function parseListClientsEnvelope(payload: unknown): ParsedClientRow[] {
  const text = joinMcpText(payload);
  const out: ParsedClientRow[] = [];
  const seen = new Set<string>();

  for (const row of parseListClientsPlainText(text)) {
    if (seen.has(row.clientId)) continue;
    seen.add(row.clientId);
    out.push(row);
  }

  const arr = parseEmbeddedJsonArray(text);
  if (arr) {
    for (const row of arr) {
      if (!row || typeof row !== "object") continue;
      const o = row as Record<string, unknown>;
      const clientId = clientIdFromObject(o);
      if (!clientId || seen.has(clientId)) continue;
      seen.add(clientId);
      out.push({ clientId, name: nameFromObject(o), slug: null });
    }
  }

  for (const o of parsePrettyJsonObjectSequence(text)) {
    const clientId = clientIdFromObject(o);
    if (!clientId || seen.has(clientId)) continue;
    seen.add(clientId);
    out.push({ clientId, name: nameFromObject(o), slug: null });
  }

  return out;
}

function normalizeName(s: string): string {
  return s.trim().toLowerCase();
}

export function resolveExactWorkspace(
  whoami: ParsedWhoami | null,
  clients: ParsedClientRow[],
  env: NodeJS.ProcessEnv = process.env,
): WorkspaceResolution {
  if (!clients.length) {
    return { ok: false, reason: "none", candidateCount: 0 };
  }

  const envId = env.YG3_SYNC_WORKSPACE_CLIENT_ID?.trim();
  if (envId && isTrustedClientUuid(envId)) {
    const hit = clients.filter((c) => c.clientId === envId);
    const sole = hit[0];
    if (hit.length === 1 && sole) {
      return {
        ok: true,
        clientId: sole.clientId,
        privateDisplayName: sole.name,
      };
    }
  }

  const envName = env.YG3_SYNC_WORKSPACE_NAME?.trim();
  if (envName) {
    const target = normalizeName(envName);
    const hits = clients.filter(
      (c) => c.name && normalizeName(c.name) === target,
    );
    const sole = hits[0];
    if (hits.length === 1 && sole) {
      return {
        ok: true,
        clientId: sole.clientId,
        privateDisplayName: sole.name,
      };
    }
  }

  if (whoami?.scopeClientId) {
    const matches = clients.filter((c) => c.clientId === whoami.scopeClientId);
    const sole = matches[0];
    if (matches.length === 1 && sole) {
      return {
        ok: true,
        clientId: sole.clientId,
        privateDisplayName:
          whoami.scopeClientDisplayName ?? sole.name ?? null,
      };
    }
    if (matches.length > 1) {
      return { ok: false, reason: "ambiguous", candidateCount: matches.length };
    }
  }

  const slugHint = env.YG3_SYNC_WORKSPACE_SLUG?.trim();
  if (slugHint) {
    const normalizedHint = normalizeWorkspaceSlug(slugHint);
    const hits = clients.filter(
      (c) => c.slug && normalizeWorkspaceSlug(c.slug) === normalizedHint,
    );
    const sole = hits[0];
    if (hits.length === 1 && sole) {
      return {
        ok: true,
        clientId: sole.clientId,
        privateDisplayName: sole.name,
      };
    }
  }

  if (whoami?.scopeClientDisplayName) {
    const target = normalizeName(whoami.scopeClientDisplayName);
    const matches = clients.filter((c) => {
      if (!c.name) return false;
      const n = normalizeName(c.name);
      return n === target || n.startsWith(target) || target.startsWith(n);
    });
    const sole = matches[0];
    if (matches.length === 1 && sole) {
      return {
        ok: true,
        clientId: sole.clientId,
        privateDisplayName: sole.name,
      };
    }
    if (matches.length > 1) {
      return { ok: false, reason: "ambiguous", candidateCount: matches.length };
    }
  }

  const only = clients[0];
  if (clients.length === 1 && only) {
    return {
      ok: true,
      clientId: only.clientId,
      privateDisplayName: only.name,
    };
  }

  return { ok: false, reason: "ambiguous", candidateCount: clients.length };
}
