import { joinMcpText, parseEmbeddedJsonObject } from "./mcp-content.js";
import { isTrustedClientUuid } from "./envelope-parsers.js";
import {
  normalizeWorkspaceSlug,
  type ParsedClientRow,
} from "./workspace-resolve.js";

/** Owner-provided client workspace slug (normalized form). */
export const OWNER_CLIENT_WORKSPACE_SLUG_NORMALIZED = "yugen media";

export function ownerSlugAuthorityMatch(
  apiSlugNormalized: string | null | undefined,
  ownerSlugNormalized: string = normalizeWorkspaceSlug(
    OWNER_CLIENT_WORKSPACE_SLUG_NORMALIZED,
  ),
): boolean {
  if (!apiSlugNormalized) return false;
  if (apiSlugNormalized === ownerSlugNormalized) return true;
  const yg3Alias = ownerSlugNormalized.replace(/^yugen\b/, "yg3");
  return apiSlugNormalized === yg3Alias;
}

/** Exclude bare agency org rows (YG3 label without media slug token). */
export function isLikelyAgencyClientAccount(
  displayName: string | null | undefined,
  slugNormalized: string | null | undefined,
): boolean {
  const name = normalizeCorroboratingDisplayName(displayName || "");
  const slug = slugNormalized || "";
  if (name === "yg3" && !slug.includes("media")) return true;
  return false;
}

const CORROBORATING_DISPLAY_NAMES = new Set(["yg3", "yg3 media"]);

export function normalizeCorroboratingDisplayName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function displayNameCorroborates(value: string | null | undefined): boolean {
  if (!value) return false;
  return CORROBORATING_DISPLAY_NAMES.has(normalizeCorroboratingDisplayName(value));
}

export function snapshotClientBlock(
  snapshotPayload: unknown,
): Record<string, unknown> | null {
  const obj = parseEmbeddedJsonObject(joinMcpText(snapshotPayload));
  if (!obj) return null;
  if (obj.client && typeof obj.client === "object" && !Array.isArray(obj.client)) {
    return obj.client as Record<string, unknown>;
  }
  return obj;
}

export function isAgencyWorkspaceSnapshot(snapshotPayload: unknown): boolean {
  const obj = parseEmbeddedJsonObject(joinMcpText(snapshotPayload));
  if (!obj) return false;
  const client = snapshotClientBlock(snapshotPayload);
  if (!client) return false;
  const agency =
    obj.agency && typeof obj.agency === "object" && !Array.isArray(obj.agency)
      ? (obj.agency as Record<string, unknown>)
      : null;
  const accountType = String(
    client.account_type ?? client.type ?? client.kind ?? "",
  ).toLowerCase();
  if (accountType.includes("agency")) return true;
  const clientId = typeof client.id === "string" ? client.id : null;
  const agencyId = agency && typeof agency.id === "string" ? agency.id : null;
  if (clientId && agencyId && clientId === agencyId) return true;
  return false;
}

export function slugFromSnapshot(snapshotPayload: unknown): string | null {
  const client = snapshotClientBlock(snapshotPayload);
  if (!client) return null;
  const raw =
    typeof client.slug === "string"
      ? client.slug
      : typeof client.client_slug === "string"
        ? client.client_slug
        : null;
  return raw ? normalizeWorkspaceSlug(raw) : null;
}

export function displayNameFromSnapshot(snapshotPayload: unknown): string | null {
  const client = snapshotClientBlock(snapshotPayload);
  if (!client) return null;
  const raw =
    typeof client.name === "string"
      ? client.name
      : typeof client.display_name === "string"
        ? client.display_name
        : null;
  return raw ? raw.trim() : null;
}

export function rowSlugNormalized(row: ParsedClientRow): string | null {
  if (!row.slug) return null;
  return normalizeWorkspaceSlug(row.slug);
}

export type OwnerClientSelection =
  | {
      verified: true;
      clientId: string;
      selectionBasis: "client_type+exact_normalized_slug+yg3_name";
    }
  | {
      verified: false;
      reason: "slug_not_found" | "ambiguous_slug" | "agency_only" | "name_mismatch";
      slugCandidateCount: number;
    };

export function selectOwnerAuthorizedClientWorkspace(opts: {
  clients: ParsedClientRow[];
  targetSlugNormalized?: string;
  snapshotByClientId?: Map<string, unknown>;
  requireCorroboratingName?: boolean;
}): OwnerClientSelection {
  const target =
    opts.targetSlugNormalized ??
    normalizeWorkspaceSlug(OWNER_CLIENT_WORKSPACE_SLUG_NORMALIZED);
  const slugHits: { clientId: string; corroborates: boolean; isAgency: boolean }[] =
    [];

  for (const row of opts.clients) {
    if (!isTrustedClientUuid(row.clientId)) continue;
    const snap = opts.snapshotByClientId?.get(row.clientId);
    const agency = snap ? isAgencyWorkspaceSnapshot(snap) : false;
    if (agency) continue;

    const slug =
      (snap ? slugFromSnapshot(snap) : null) ?? rowSlugNormalized(row);
    if (!slug || !ownerSlugAuthorityMatch(slug, target)) continue;

    const name =
      (snap ? displayNameFromSnapshot(snap) : null) ?? row.name ?? null;
    const corroborates = displayNameCorroborates(name);
    if (opts.requireCorroboratingName && !corroborates) continue;

    slugHits.push({
      clientId: row.clientId,
      corroborates,
      isAgency: false,
    });
  }

  if (!slugHits.length) {
    return {
      verified: false,
      reason: "slug_not_found",
      slugCandidateCount: 0,
    };
  }

  const withName = slugHits.filter((h) => h.corroborates);
  const pool = withName.length ? withName : slugHits;
  if (pool.length > 1) {
    return {
      verified: false,
      reason: "ambiguous_slug",
      slugCandidateCount: pool.length,
    };
  }

  const sole = pool[0];
  if (!sole) {
    return {
      verified: false,
      reason: "slug_not_found",
      slugCandidateCount: 0,
    };
  }

  if (!sole.corroborates && opts.requireCorroboratingName !== false) {
    return {
      verified: false,
      reason: "name_mismatch",
      slugCandidateCount: 1,
    };
  }

  return {
    verified: true,
    clientId: sole.clientId,
    selectionBasis: "client_type+exact_normalized_slug+yg3_name",
  };
}

export function selectOwnerClientBySlugAndYg3NameHeuristic(opts: {
  clients: ParsedClientRow[];
  snapshotByClientId: Map<string, unknown>;
}): OwnerClientSelection {
  const picks: string[] = [];
  for (const row of opts.clients) {
    if (!isTrustedClientUuid(row.clientId)) continue;
    const snap = opts.snapshotByClientId.get(row.clientId);
    const slug = (snap ? slugFromSnapshot(snap) : null) ?? rowSlugNormalized(row);
    const name = (snap ? displayNameFromSnapshot(snap) : null) ?? row.name;
    if (isLikelyAgencyClientAccount(name, slug)) continue;
    const nameLower = (name || "").toLowerCase();
    if (!nameLower.includes("yg3") && !displayNameCorroborates(name)) continue;
    if (!slug || !slug.includes("media")) continue;
    picks.push(row.clientId);
  }
  const sole = picks[0];
  if (picks.length === 1 && sole) {
    return {
      verified: true,
      clientId: sole,
      selectionBasis: "client_type+exact_normalized_slug+yg3_name",
    };
  }
  if (picks.length > 1) {
    return {
      verified: false,
      reason: "ambiguous_slug",
      slugCandidateCount: picks.length,
    };
  }
  return {
    verified: false,
    reason: "slug_not_found",
    slugCandidateCount: 0,
  };
}
