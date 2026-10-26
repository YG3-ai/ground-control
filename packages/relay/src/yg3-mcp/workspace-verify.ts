import type { ParsedWhoami } from "./envelope-parsers.js";
import { isTrustedClientUuid } from "./envelope-parsers.js";
import type { ParsedClientRow } from "./workspace-resolve.js";

export type WorkspaceAuthority =
  | "env_client_id"
  | "env_name"
  | "env_slug"
  | "whoami_scope_client_id"
  | "whoami_scope_name_exact"
  | "single_agency_client";

export type VerifiedWorkspaceSelection =
  | {
      verified: true;
      clientId: string;
      authority: WorkspaceAuthority;
    }
  | {
      verified: false;
      reason: "ambiguous" | "none";
      candidateCount: number;
    };

function normalizeName(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Authoritative workspace selection for cached sync. Does not use sync-failing
 * connection hints, query-narrowed client lists, or fuzzy name prefix matching.
 */
export function verifyExactWorkspaceAuthority(
  whoami: ParsedWhoami | null,
  clients: ParsedClientRow[],
  env: NodeJS.ProcessEnv = process.env,
): VerifiedWorkspaceSelection {
  if (!clients.length) {
    return { verified: false, reason: "none", candidateCount: 0 };
  }

  const envId = env.YG3_SYNC_WORKSPACE_CLIENT_ID?.trim();
  if (envId && isTrustedClientUuid(envId)) {
    const hit = clients.filter((c) => c.clientId === envId);
    const envHit = hit[0];
    if (hit.length === 1 && envHit) {
      return {
        verified: true,
        clientId: envHit.clientId,
        authority: "env_client_id",
      };
    }
  }

  const envName = env.YG3_SYNC_WORKSPACE_NAME?.trim();
  if (envName) {
    const target = normalizeName(envName);
    const hits = clients.filter(
      (c) => c.name && normalizeName(c.name) === target,
    );
    const nameHit = hits[0];
    if (hits.length === 1 && nameHit) {
      return {
        verified: true,
        clientId: nameHit.clientId,
        authority: "env_name",
      };
    }
  }

  if (whoami?.scopeClientId) {
    const matches = clients.filter((c) => c.clientId === whoami.scopeClientId);
    const scopeHit = matches[0];
    if (matches.length === 1 && scopeHit) {
      return {
        verified: true,
        clientId: scopeHit.clientId,
        authority: "whoami_scope_client_id",
      };
    }
    if (matches.length > 1) {
      return {
        verified: false,
        reason: "ambiguous",
        candidateCount: matches.length,
      };
    }
  }

  const slugHint = env.YG3_SYNC_WORKSPACE_SLUG?.trim().toLowerCase();
  if (slugHint) {
    const hits = clients.filter((c) => c.slug === slugHint);
    const slugHit = hits[0];
    if (hits.length === 1 && slugHit) {
      return {
        verified: true,
        clientId: slugHit.clientId,
        authority: "env_slug",
      };
    }
  }

  if (whoami?.scopeClientDisplayName) {
    const target = normalizeName(whoami.scopeClientDisplayName);
    const matches = clients.filter(
      (c) => c.name && normalizeName(c.name) === target,
    );
    const sole = matches[0];
    if (matches.length === 1 && sole) {
      return {
        verified: true,
        clientId: sole.clientId,
        authority: "whoami_scope_name_exact",
      };
    }
    if (matches.length > 1) {
      return {
        verified: false,
        reason: "ambiguous",
        candidateCount: matches.length,
      };
    }
  }

  const only = clients[0];
  if (clients.length === 1 && only) {
    return {
      verified: true,
      clientId: only.clientId,
      authority: "single_agency_client",
    };
  }

  return {
    verified: false,
    reason: "ambiguous",
    candidateCount: clients.length,
  };
}
