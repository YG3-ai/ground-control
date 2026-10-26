import { YG3_LIST_CLIENTS_LIMIT, YG3_SYNC_WINDOW_DAYS } from "./constants.js";
import { parseWhoamiEnvelope } from "./envelope-parsers.js";
import { isTrustedClientUuid } from "./envelope-parsers.js";
import type { McpReadCall } from "./media-identity-resolve.js";
import { normalizeWhoamiIdentity } from "./sanitize.js";
import { classifyWorkspaceAccountKind } from "./workspace-account-kind.js";
import { findClientRowBySlug } from "./workspace-catalog.js";
import {
  OWNER_CLIENT_WORKSPACE_SLUG_NORMALIZED,
  ownerSlugAuthorityMatch,
  selectOwnerClientBySlugAndYg3NameHeuristic,
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
  WorkspaceSelectionStore,
  type WorkspaceSelectionV1,
} from "./workspace-selection-store.js";

export type SelectorStatus =
  | "stored_selection_valid"
  | "auto_client_scope"
  | "agency_explicit_selection"
  | "super_admin_explicit_selection"
  | "selection_required"
  | "selection_invalid";

export type WorkspaceSyncSelection =
  | {
      ok: true;
      clientId: string;
      selectionBasis: string;
      selectorStatus: SelectorStatus;
      principalTier: Yg3PrincipalTier;
      prefetchedSnapshot?: unknown;
    }
  | {
      ok: false;
      selectorStatus: SelectorStatus;
      principalTier: Yg3PrincipalTier;
      blocker: string;
    };

/** Merges default list_clients with query hints (API often omits rows from unfiltered pages). */
async function gatherScopeRosterRows(
  call: McpReadCall,
  hints?: {
    normalizedSlug?: string | null;
    displayNameCorroborated?: boolean;
  },
): Promise<ParsedClientRow[]> {
  const seen = new Set<string>();
  const rows: ParsedClientRow[] = [];
  const ingest = (payload: unknown) => {
    for (const row of parseListClientsEnvelope(payload)) {
      if (!isTrustedClientUuid(row.clientId) || seen.has(row.clientId)) continue;
      seen.add(row.clientId);
      rows.push(row);
    }
  };
  ingest(
    await call("list_clients", {
      include_archived: true,
      limit: YG3_LIST_CLIENTS_LIMIT,
    }),
  );
  const queries = new Set<string>();
  if (hints?.displayNameCorroborated) queries.add("YG3");
  if (hints?.normalizedSlug) {
    for (const token of hints.normalizedSlug.split(/\s+/)) {
      if (token.length >= 3) queries.add(token);
    }
  }
  for (const query of queries) {
    ingest(
      await call("list_clients", {
        include_archived: true,
        limit: YG3_LIST_CLIENTS_LIMIT,
        query,
      }),
    );
  }
  return rows;
}

function selectionMatchesPrincipal(
  stored: WorkspaceSelectionV1,
  identity: ReturnType<typeof normalizeWhoamiIdentity>,
  tier: Yg3PrincipalTier,
): boolean {
  return (
    stored.tenantKey === identity.tenantKey &&
    stored.userKey === identity.userKey &&
    stored.principalTier === tier
  );
}

export async function revalidateStoredSelection(
  call: McpReadCall,
  stored: WorkspaceSelectionV1,
  opts?: { principalTier?: Yg3PrincipalTier },
): Promise<{ valid: boolean; snapshot?: unknown }> {
  let snap: unknown;
  try {
    snap = await call("get_client_snapshot", {
      client_id: stored.clientId,
      window: YG3_SYNC_WINDOW_DAYS,
    });
  } catch {
    return { valid: false };
  }
  const roster = await gatherScopeRosterRows(call, {
    normalizedSlug: stored.normalizedSlug,
    displayNameCorroborated: stored.displayNameCorroborated,
  });
  const row = roster.find((c) => c.clientId === stored.clientId);
  const tier = opts?.principalTier;
  if (tier === "agency" && !row) {
    return { valid: false };
  }
  const kindRow =
    row ?? { clientId: stored.clientId, name: null, slug: stored.normalizedSlug };
  if (classifyWorkspaceAccountKind(kindRow, snap) !== "client") {
    return { valid: false };
  }
  if (stored.normalizedSlug) {
    const liveSlug = slugFromSnapshot(snap);
    if (
      liveSlug !== stored.normalizedSlug &&
      !ownerSlugAuthorityMatch(liveSlug, stored.normalizedSlug)
    ) {
      return { valid: false };
    }
  }
  return { valid: true, snapshot: snap };
}

export function buildSelectionRecord(opts: {
  identity: ReturnType<typeof normalizeWhoamiIdentity>;
  tier: Yg3PrincipalTier;
  clientId: string;
  selectionBasis: string;
  normalizedSlug: string | null;
  displayNameCorroborated: boolean;
}): WorkspaceSelectionV1 {
  return {
    version: 1,
    tenantKey: opts.identity.tenantKey,
    userKey: opts.identity.userKey,
    principalTier: opts.tier,
    clientId: opts.clientId,
    selectionBasis: opts.selectionBasis,
    normalizedSlug: opts.normalizedSlug,
    displayNameCorroborated: opts.displayNameCorroborated,
    accountKind: "client",
    selectedAt: new Date().toISOString(),
  };
}

export async function resolveWorkspaceForSync(opts: {
  call: McpReadCall;
  relayDataDir: string;
  whoamiPayload: unknown;
}): Promise<WorkspaceSyncSelection> {
  const whoami = parseWhoamiEnvelope(opts.whoamiPayload);
  const identity = normalizeWhoamiIdentity(opts.whoamiPayload);
  const tier = principalTierFromWhoami(whoami);
  const store = WorkspaceSelectionStore.defaultPath(opts.relayDataDir);
  const stored = store.load();

  if (tier === "client_scoped" && whoami?.scopeClientId) {
    const clientId = whoami.scopeClientId;
    if (!isTrustedClientUuid(clientId)) {
      return {
        ok: false,
        selectorStatus: "selection_invalid",
        principalTier: tier,
        blocker: "invalid_scope_client_id",
      };
    }
    const snap = await opts.call("get_client_snapshot", {
      client_id: clientId,
      window: YG3_SYNC_WINDOW_DAYS,
    });
    const row: ParsedClientRow = { clientId, name: whoami.scopeClientDisplayName, slug: null };
    if (classifyWorkspaceAccountKind(row, snap) !== "client") {
      return {
        ok: false,
        selectorStatus: "selection_invalid",
        principalTier: tier,
        blocker: "scope_is_agency_not_client",
      };
    }
    store.save(
      buildSelectionRecord({
        identity,
        tier,
        clientId,
        selectionBasis: "auto_scope_client_id",
        normalizedSlug: slugFromSnapshot(snap),
        displayNameCorroborated: true,
      }),
    );
    return {
      ok: true,
      clientId,
      selectionBasis: "auto_scope_client_id",
      selectorStatus: "auto_client_scope",
      principalTier: tier,
      prefetchedSnapshot: snap,
    };
  }

  if (stored && selectionMatchesPrincipal(stored, identity, tier)) {
    const check = await revalidateStoredSelection(opts.call, stored, {
      principalTier: tier,
    });
    if (check.valid) {
      return {
        ok: true,
        clientId: stored.clientId,
        selectionBasis: stored.selectionBasis,
        selectorStatus: "stored_selection_valid",
        principalTier: tier,
        prefetchedSnapshot: check.snapshot,
      };
    }
  }

  return {
    ok: false,
    selectorStatus: "selection_required",
    principalTier: tier,
    blocker: "workspace_selection_required",
  };
}

export async function selectWorkspaceBySlug(opts: {
  call: McpReadCall;
  relayDataDir: string;
  whoamiPayload: unknown;
  slugInput: string;
  requireCorroboratingName?: boolean;
}): Promise<WorkspaceSyncSelection> {
  const whoami = parseWhoamiEnvelope(opts.whoamiPayload);
  const identity = normalizeWhoamiIdentity(opts.whoamiPayload);
  const tier = principalTierFromWhoami(whoami);
  const slugNormalized = normalizeWorkspaceSlug(opts.slugInput);
  const yg3Query = parseListClientsEnvelope(
    await opts.call("list_clients", {
      include_archived: true,
      limit: YG3_LIST_CLIENTS_LIMIT,
      query: "YG3",
    }),
  );
  const candidates = yg3Query.filter((row) =>
    (row.name || "").toLowerCase().includes("yg3"),
  );
  const snapshotByClientId = new Map<string, unknown>();
  for (const row of candidates) {
    snapshotByClientId.set(
      row.clientId,
      await opts.call("get_client_snapshot", {
        client_id: row.clientId,
        window: YG3_SYNC_WINDOW_DAYS,
      }),
    );
  }
  let picked = findClientRowBySlug(
    candidates,
    snapshotByClientId,
    slugNormalized,
    opts.requireCorroboratingName ?? true,
  );
  if (
    !picked &&
    slugNormalized === normalizeWorkspaceSlug(OWNER_CLIENT_WORKSPACE_SLUG_NORMALIZED)
  ) {
    const heuristic = selectOwnerClientBySlugAndYg3NameHeuristic({
      clients: candidates.filter(
        (row) => classifyWorkspaceAccountKind(row, snapshotByClientId.get(row.clientId)) === "client",
      ),
      snapshotByClientId,
    });
    if (heuristic.verified) {
      picked =
        candidates.find((r) => r.clientId === heuristic.clientId) ?? null;
    }
  }
  if (!picked) {
    return {
      ok: false,
      selectorStatus: "selection_invalid",
      principalTier: tier,
      blocker: "slug_selection_not_unique",
    };
  }
  const snap = snapshotByClientId.get(picked.clientId);
  const basis = "client_type+exact_normalized_slug+yg3_name";
  WorkspaceSelectionStore.defaultPath(opts.relayDataDir).save(
    buildSelectionRecord({
      identity,
      tier,
      clientId: picked.clientId,
      selectionBasis: basis,
      normalizedSlug: slugFromSnapshot(snap) ?? slugNormalized,
      displayNameCorroborated: true,
    }),
  );
  return {
    ok: true,
    clientId: picked.clientId,
    selectionBasis: basis,
    selectorStatus: "super_admin_explicit_selection",
    principalTier: tier,
    prefetchedSnapshot: snap,
  };
}
