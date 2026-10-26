import { YG3_LIST_CLIENTS_LIMIT, YG3_SYNC_WINDOW_DAYS } from "./constants.js";
import { parseListClientsEnvelope } from "./workspace-resolve.js";
import {
  companyWebsiteHost,
  filterNarrowNameCandidates,
  resolveUniqueWebsiteLinkage,
  type NarrowCandidate,
} from "./workspace-media-resolve.js";
import type { Yg3MediaWorkspaceSelection } from "./workspace-media-select.js";

export type McpReadCall = (
  tool: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

export type MediaIdentityResolution =
  | {
      verified: true;
      selection: Yg3MediaWorkspaceSelection & { verified: true };
      prefetchedSnapshot?: unknown;
      listClientsPayload: unknown;
      narrowCandidates: NarrowCandidate[];
    }
  | {
      verified: false;
      narrowCount: number;
      candidateLabels: string[];
      reason: "ambiguous" | "no_website_linkage" | "no_narrow_candidates";
    };

export async function resolveYg3MediaIdentityByWebsite(
  call: McpReadCall,
  opts?: { env?: NodeJS.ProcessEnv },
): Promise<MediaIdentityResolution> {
  const env = opts?.env ?? process.env;
  const host = companyWebsiteHost(env);

  const listPayload = await call("list_clients", {
    include_archived: true,
    limit: YG3_LIST_CLIENTS_LIMIT,
  });
  const narrow = filterNarrowNameCandidates(
    parseListClientsEnvelope(listPayload),
  );
  if (!narrow.length) {
    return {
      verified: false,
      narrowCount: 0,
      candidateLabels: [],
      reason: "no_narrow_candidates",
    };
  }

  const domainsByClientId = new Map<string, unknown>();
  const snapshotByClientId = new Map<string, unknown>();
  const setupHealthByClientId = new Map<string, unknown>();
  let prefetchedSnapshot: unknown | undefined;

  for (const c of narrow) {
    domainsByClientId.set(
      c.clientId,
      await call("list_client_domains", {
        client_id: c.clientId,
        domain_type: "website",
      }),
    );
    const snap = await call("get_client_snapshot", {
      client_id: c.clientId,
      window: YG3_SYNC_WINDOW_DAYS,
    });
    snapshotByClientId.set(c.clientId, snap);
    try {
      setupHealthByClientId.set(
        c.clientId,
        await call("get_setup_health", { client_id: c.clientId }),
      );
    } catch {
      setupHealthByClientId.set(c.clientId, await call("get_setup_health", {}));
    }
  }

  const resolved = resolveUniqueWebsiteLinkage({
    candidates: narrow,
    host,
    domainsByClientId,
    snapshotByClientId,
    setupHealthByClientId,
    listClientsPayload: listPayload,
  });

  if (!resolved.ok) {
    const withEvidence = resolved.matches.filter((m) => m.evidence.length > 0);
    return {
      verified: false,
      narrowCount: narrow.length,
      candidateLabels: narrow.map((c) => c.label).sort(),
      reason: withEvidence.length > 1 ? "ambiguous" : "no_website_linkage",
    };
  }

  prefetchedSnapshot = snapshotByClientId.get(resolved.clientId);

  return {
    verified: true,
    selection: {
      verified: true,
      clientId: resolved.clientId,
      basis: "company_website_linkage_authoritative",
    },
    prefetchedSnapshot,
    listClientsPayload: listPayload,
    narrowCandidates: narrow,
  };
}
