import { parseWhoamiEnvelope } from "./envelope-parsers.js";

const MAX_STRING = 8_192;
const MAX_DEPTH = 8;
const MAX_KEYS = 200;

export function sanitizeUntrustedMcpValue(
  value: unknown,
  depth = 0,
): unknown {
  if (depth > MAX_DEPTH) return "[truncated_depth]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value.length > MAX_STRING
      ? value.slice(0, MAX_STRING) + "…"
      : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_KEYS).map((v) => sanitizeUntrustedMcpValue(v, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>).slice(
      0,
      MAX_KEYS,
    );
    for (const [k, v] of entries) {
      out[k] = sanitizeUntrustedMcpValue(v, depth + 1);
    }
    return out;
  }
  return String(value).slice(0, MAX_STRING);
}

export function normalizeWhoamiIdentity(payload: unknown): {
  tenantKey: string;
  userKey: string;
} {
  const parsed = parseWhoamiEnvelope(payload);
  if (parsed) {
    return {
      tenantKey: (parsed.agencyId || "unknown-tenant").slice(0, 128),
      userKey: (parsed.userId || "unknown-user").slice(0, 128),
    };
  }
  const obj =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const tenant =
    pickString(obj, ["tenant_id", "tenantId", "tenant", "org_id", "orgId"]) ||
    "unknown-tenant";
  const user =
    pickString(obj, ["user_id", "userId", "sub", "id"]) || "unknown-user";
  return {
    tenantKey: tenant.slice(0, 128),
    userKey: user.slice(0, 128),
  };
}

function pickString(
  obj: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

const ROLE_HINTS = [
  "role",
  "account_role",
  "user_role",
  "membership_role",
  "access_level",
] as const;

/** Sanitized role category for status reports (no IDs, names, or emails). */
export function roleCategoryFromWhoami(payload: unknown): string {
  const obj =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  for (const key of ROLE_HINTS) {
    const v = obj[key];
    if (typeof v === "string") return bucketRoleCategory(v);
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const nested = roleCategoryFromWhoami(v);
      if (nested !== "unknown") return nested;
    }
  }
  return "unknown";
}

function bucketRoleCategory(raw: string): string {
  const s = raw.toLowerCase();
  if (s.includes("owner")) return "owner";
  if (s.includes("admin")) return "admin";
  if (s.includes("agency")) return "agency";
  if (s.includes("member") || s.includes("staff")) return "member";
  if (s.includes("viewer") || s.includes("read")) return "viewer";
  return "other";
}
