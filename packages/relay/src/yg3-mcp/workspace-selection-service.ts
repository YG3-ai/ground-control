import { YG3_LIST_CLIENTS_LIMIT, YG3_SYNC_WINDOW_DAYS } from "./constants.js";
import { parseWhoamiEnvelope } from "./envelope-parsers.js";
import type { McpReadCall } from "./media-identity-resolve.js";
import { normalizeWhoamiIdentity } from "./sanitize.js";
import { classifyWorkspaceAccountKind } from "./workspace-account-kind.js";
import {
  pickClientOnlySearchHits,
  searchWorkspaceClientsBundle,
  type WorkspaceSearchHit,
} from "./workspace-catalog.js";
import {
  displayNameFromSnapshot,
  normalizeCorroboratingDisplayName,
  slugFromSnapshot,
} from "./workspace-owner-select.js";
import {
  principalTierFromWhoami,
  type Yg3PrincipalTier,
} from "./workspace-principal.js";
import {
  normalizeWorkspaceSlug,
  parseListClientsEnvelope,
  type ParsedClientRow,
} from "./workspace-resolve.js";
import {
  WorkspaceSearchSessionStore,
  WORKSPACE_SEARCH_SESSION_VERSION,
} from "./workspace-search-session.js";
import {
  buildSelectionRecord,
  type SelectorStatus,
  type WorkspaceSyncSelection,
} from "./workspace-selector.js";
import { WorkspaceSelectionStore } from "./workspace-selection-store.js";

export type SelectorPath =
  | "client_auto"
  | "agency_search"
  | "superadmin_explicit";

export type WorkspaceSearchPublicResult = {
  ok: true;
  principalTier: Yg3PrincipalTier;
  selectorPath: SelectorPath;
  query: string;
  results: WorkspaceSearchHit[];
  hint?: string;
};

export type WorkspaceSearchBlocked = {
  ok: false;
  principalTier: Yg3PrincipalTier;
  selectorPath: SelectorPath;
  blocker: string;
};

export type WorkspaceSelectInput =
  | { kind: "ref"; ref: number }
  | { kind: "slug"; slug: string }
  | { kind: "name"; name: string };

export function selectorPathForTier(tier: Yg3PrincipalTier): SelectorPath {
  if (tier === "client_scoped") return "client_auto";
  if (tier === "agency") return "agency_search";
  return "superadmin_explicit";
}

export function exactNormalizedSlugMatch(
  candidate: string | null | undefined,
  input: string,
): boolean {
  if (!candidate) return false;
  return normalizeWorkspaceSlug(candidate) === normalizeWorkspaceSlug(input);
}

export function exactDisplayNameMatch(
  candidate: string | null | undefined,
  input: string,
): boolean {
  if (!candidate) return false;
  return (
    normalizeCorroboratingDisplayName(candidate) ===
    normalizeCorroboratingDisplayName(input)
  );
}

function publicHitsForTier(
  tier: Yg3PrincipalTier,
  hits: WorkspaceSearchHit[],
): WorkspaceSearchHit[] {
  if (tier === "super_admin") return hits;
  return pickClientOnlySearchHits(hits);
}

function persistSearchSession(opts: {
  relayDataDir: string;
  identity: ReturnType<typeof normalizeWhoamiIdentity>;
  tier: Yg3PrincipalTier;
  query: string;
  hits: WorkspaceSearchHit[];
  clientIdByRef: Map<number, string>;
}): void {
  const entries = opts.hits.map((h) => ({
    ref: h.ref,
    clientId: opts.clientIdByRef.get(h.ref) ?? "",
    accountKind: h.accountKind,
  }));
  WorkspaceSearchSessionStore.defaultPath(opts.relayDataDir).save({
    version: WORKSPACE_SEARCH_SESSION_VERSION,
    tenantKey: opts.identity.tenantKey,
    userKey: opts.identity.userKey,
    principalTier: opts.tier,
    query: opts.query,
    createdAt: new Date().toISOString(),
    entries: entries.filter((e) => e.clientId),
  });
}

export async function searchWorkspacesForPrincipal(opts: {
  call: McpReadCall;
  relayDataDir: string;
  whoamiPayload: unknown;
  query: string;
}): Promise<WorkspaceSearchPublicResult | WorkspaceSearchBlocked> {
  const whoami = parseWhoamiEnvelope(opts.whoamiPayload);
  const tier = principalTierFromWhoami(whoami);
  const path = selectorPathForTier(tier);
  const identity = normalizeWhoamiIdentity(opts.whoamiPayload);

  if (tier === "client_scoped") {
    return {
      ok: false,
      principalTier: tier,
      selectorPath: path,
      blocker: "client_scope_auto_no_search",
    };
  }

  const query = opts.query.trim();
  if (!query) {
    return {
      ok: false,
      principalTier: tier,
      selectorPath: path,
      blocker: "missing_query",
    };
  }

  const bundle = await searchWorkspaceClientsBundle(opts.call, query);
  const rawHits = bundle.hits;
  const hits = publicHitsForTier(tier, rawHits);
  const clientIdByRef = new Map<number, string>();
  const sessionHits = tier === "super_admin" ? rawHits : hits;
  for (const h of sessionHits) {
    const id = bundle.clientIdByRef.get(h.ref);
    if (id) clientIdByRef.set(h.ref, id);
  }
  persistSearchSession({
    relayDataDir: opts.relayDataDir,
    identity,
    tier,
    query,
    hits: sessionHits,
    clientIdByRef,
  });

  return {
    ok: true,
    principalTier: tier,
    selectorPath: path,
    query,
    results: tier === "super_admin" ? rawHits : hits,
    hint:
      tier === "super_admin"
        ? "Use accountKind and slugNormalized to disambiguate; select with --ref on a client row only."
        : "Client accounts only; select with --ref.",
  };
}

async function resolveClientIdForRef(opts: {
  relayDataDir: string;
  identity: ReturnType<typeof normalizeWhoamiIdentity>;
  tier: Yg3PrincipalTier;
  ref: number;
}): Promise<
  | { ok: true; clientId: string; accountKind: "client" | "agency" }
  | { ok: false; blocker: string }
> {
  const session = WorkspaceSearchSessionStore.defaultPath(
    opts.relayDataDir,
  ).load();
  if (
    !session ||
    session.tenantKey !== opts.identity.tenantKey ||
    session.userKey !== opts.identity.userKey ||
    session.principalTier !== opts.tier
  ) {
    return { ok: false, blocker: "search_session_stale" };
  }
  const entry = session.entries.find((e) => e.ref === opts.ref);
  if (!entry) return { ok: false, blocker: "ref_not_found" };
  if (opts.tier === "agency" && entry.accountKind !== "client") {
    return { ok: false, blocker: "agency_account_not_selectable" };
  }
  if (opts.tier === "super_admin" && entry.accountKind !== "client") {
    return { ok: false, blocker: "agency_account_not_selectable" };
  }
  return {
    ok: true,
    clientId: entry.clientId,
    accountKind: entry.accountKind,
  };
}

async function selectByExactSlugOrName(opts: {
  call: McpReadCall;
  tier: Yg3PrincipalTier;
  slug?: string;
  name?: string;
}): Promise<
  | { ok: true; clientId: string; normalizedSlug: string | null }
  | { ok: false; blocker: string }
> {
  if (opts.tier !== "super_admin") {
    return { ok: false, blocker: "exact_match_super_admin_only" };
  }
  const query = (opts.slug ?? opts.name ?? "").trim();
  if (!query) return { ok: false, blocker: "missing_slug_or_name" };

  const rows = parseListClientsEnvelope(
    await opts.call("list_clients", {
      include_archived: true,
      limit: YG3_LIST_CLIENTS_LIMIT,
      query,
    }),
  );

  const matches: { clientId: string; slug: string | null; name: string | null }[] =
    [];
  for (const row of rows) {
    const snap = await opts.call("get_client_snapshot", {
      client_id: row.clientId,
      window: YG3_SYNC_WINDOW_DAYS,
    });
    if (classifyWorkspaceAccountKind(row, snap) !== "client") continue;
    const slug = slugFromSnapshot(snap) ?? (row.slug ? normalizeWorkspaceSlug(row.slug) : null);
    const name = displayNameFromSnapshot(snap) ?? row.name ?? null;
    const slugOk = opts.slug
      ? exactNormalizedSlugMatch(slug, opts.slug)
      : false;
    const nameOk = opts.name ? exactDisplayNameMatch(name, opts.name) : false;
    if (slugOk || nameOk) {
      matches.push({ clientId: row.clientId, slug, name });
    }
  }
  if (matches.length !== 1) {
    return {
      ok: false,
      blocker: matches.length > 1 ? "ambiguous_exact_match" : "exact_match_not_found",
    };
  }
  const sole = matches[0]!;
  return { ok: true, clientId: sole.clientId, normalizedSlug: sole.slug };
}

function selectionStatusForTier(tier: Yg3PrincipalTier): SelectorStatus {
  if (tier === "agency") return "agency_explicit_selection";
  return "super_admin_explicit_selection";
}

export async function selectWorkspaceForPrincipal(opts: {
  call: McpReadCall;
  relayDataDir: string;
  whoamiPayload: unknown;
  input: WorkspaceSelectInput;
}): Promise<WorkspaceSyncSelection> {
  const whoami = parseWhoamiEnvelope(opts.whoamiPayload);
  const identity = normalizeWhoamiIdentity(opts.whoamiPayload);
  const tier = principalTierFromWhoami(whoami);

  if (tier === "client_scoped") {
    return {
      ok: false,
      selectorStatus: "selection_invalid",
      principalTier: tier,
      blocker: "client_scope_auto_no_manual_select",
    };
  }

  let clientId: string | null = null;
  let normalizedSlug: string | null = null;
  let selectionBasis = "explicit_selection";

  if (opts.input.kind === "ref") {
    const resolved = await resolveClientIdForRef({
      relayDataDir: opts.relayDataDir,
      identity,
      tier,
      ref: opts.input.ref,
    });
    if (!resolved.ok) {
      return {
        ok: false,
        selectorStatus: "selection_invalid",
        principalTier: tier,
        blocker: resolved.blocker,
      };
    }
    clientId = resolved.clientId;
    selectionBasis = "search_ref_client_only";
  } else if (opts.input.kind === "slug") {
    const resolved = await selectByExactSlugOrName({
      call: opts.call,
      tier,
      slug: opts.input.slug,
    });
    if (!resolved.ok) {
      return {
        ok: false,
        selectorStatus: "selection_invalid",
        principalTier: tier,
        blocker: resolved.blocker,
      };
    }
    clientId = resolved.clientId;
    normalizedSlug = resolved.normalizedSlug;
    selectionBasis = "exact_normalized_slug";
  } else {
    const resolved = await selectByExactSlugOrName({
      call: opts.call,
      tier,
      name: opts.input.name,
    });
    if (!resolved.ok) {
      return {
        ok: false,
        selectorStatus: "selection_invalid",
        principalTier: tier,
        blocker: resolved.blocker,
      };
    }
    clientId = resolved.clientId;
    normalizedSlug = resolved.normalizedSlug;
    selectionBasis = "exact_display_name";
  }

  const snap = await opts.call("get_client_snapshot", {
    client_id: clientId,
    window: YG3_SYNC_WINDOW_DAYS,
  });
  const row: ParsedClientRow = { clientId, name: null, slug: normalizedSlug };
  if (classifyWorkspaceAccountKind(row, snap) !== "client") {
    return {
      ok: false,
      selectorStatus: "selection_invalid",
      principalTier: tier,
      blocker: "agency_account_not_selectable",
    };
  }
  const liveSlug = slugFromSnapshot(snap) ?? normalizedSlug;
  WorkspaceSelectionStore.defaultPath(opts.relayDataDir).save(
    buildSelectionRecord({
      identity,
      tier,
      clientId,
      selectionBasis,
      normalizedSlug: liveSlug,
      displayNameCorroborated: Boolean(
        displayNameFromSnapshot(snap) ?? opts.input.kind === "name",
      ),
    }),
  );

  return {
    ok: true,
    clientId,
    selectionBasis,
    selectorStatus: selectionStatusForTier(tier),
    principalTier: tier,
    prefetchedSnapshot: snap,
  };
}

export function readStoredSelectionSummary(opts: {
  relayDataDir: string;
  whoamiPayload: unknown;
}): {
  principalTier: Yg3PrincipalTier;
  selectorPath: SelectorPath;
  hasStoredSelection: boolean;
  selectionBasis: string | null;
  normalizedSlug: string | null;
  accountKind: "client" | null;
  boundToPrincipal: boolean;
} {
  const whoami = parseWhoamiEnvelope(opts.whoamiPayload);
  const tier = principalTierFromWhoami(whoami);
  const identity = normalizeWhoamiIdentity(opts.whoamiPayload);
  const stored = WorkspaceSelectionStore.defaultPath(opts.relayDataDir).load();
  const bound =
    Boolean(stored) &&
    stored!.tenantKey === identity.tenantKey &&
    stored!.userKey === identity.userKey &&
    stored!.principalTier === tier;
  return {
    principalTier: tier,
    selectorPath: selectorPathForTier(tier),
    hasStoredSelection: bound,
    selectionBasis: bound ? stored!.selectionBasis : null,
    normalizedSlug: bound ? stored!.normalizedSlug : null,
    accountKind: bound ? stored!.accountKind : null,
    boundToPrincipal: bound,
  };
}
