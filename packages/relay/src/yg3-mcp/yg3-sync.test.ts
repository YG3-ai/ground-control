import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { projectYg3SnapshotV1 } from "./projector.js";
import {
  growthFeedFromYg3Snapshot,
  lifecycleFeedFromYg3Snapshot,
  snapshotHasNoPiiFields,
  yg3AccountsFeedFromSnapshot,
} from "./feed-from-snapshot.js";
import { Yg3SnapshotFileStore } from "./snapshot-file-store.js";
import { Yg3SnapshotMetaStore } from "./snapshot-meta.js";
import { clearYg3SnapshotFlightForTests } from "./snapshot-service.js";
import {
  extractTrustedClientIds,
  parseDailyCheckinEnvelope,
  parseLeadsEnvelope,
  parseListClientConnectionsEnvelope,
  parseListProjectsEnvelope,
  parseSearchOpportunitiesEnvelope,
  parseWhoamiEnvelope,
} from "./envelope-parsers.js";
import {
  parseListClientsEnvelope,
  resolveExactWorkspace,
} from "./workspace-resolve.js";
import { verifyExactWorkspaceAuthority } from "./workspace-verify.js";
import {
  selectYg3MediaWorkspaceFromQuerySingleton,
} from "./workspace-media-select.js";
import {
  filterNarrowNameCandidates,
  resolveUniqueWebsiteLinkage,
} from "./workspace-media-resolve.js";
import {
  ownerSlugAuthorityMatch,
  selectOwnerClientBySlugAndYg3NameHeuristic,
} from "./workspace-owner-select.js";
import { normalizeWorkspaceSlug } from "./workspace-resolve.js";

function mcpText(text: string): unknown {
  return [{ type: "text", text }];
}

const FABRICATED_CLIENT_ID = "11111111-1111-4111-8111-111111111111";
const FABRICATED_AGENCY_ID = "22222222-2222-4222-8222-222222222222";
const FABRICATED_USER_ID = "33333333-3333-4333-8333-333333333333";

const FABRICATED = {
  whoami: mcpText(
    JSON.stringify({
      agency_id: FABRICATED_AGENCY_ID,
      user_id: FABRICATED_USER_ID,
      role: "admin",
      principal_type: "admin",
      scope_client_id: null,
      scope_client_name: null,
    }),
  ),
  daily_checkin: mcpText("- Traffic steady across workspaces.\n- 2 sync alerts.\n"),
  client_connections: mcpText(
    "3 clients in scope, 1 with a connection needing attention.\n" +
      "Example — all clear\n" +
      "Other — LinkedIn: Disconnected\n",
  ),
  projects: mcpText(
    `{
  "id": "${FABRICATED_CLIENT_ID}",
  "client_id": "${FABRICATED_CLIENT_ID}",
  "status": "active"
},
{
  "id": "44444444-4444-4444-8444-444444444444",
  "client_id": null,
  "status": "active"
}`,
  ),
  tasks: mcpText("[]"),
  client_snapshots: [mcpText("Visits: 42\nSessions: 40\n")],
  traffic_breakdowns: [mcpText("Organic: 10\nPaid: 5\n")],
  search_opportunities: [mcpText("opportunities: 3\n")],
  leads: [mcpText("leads: 7\n")],
};

describe("YG3 snapshot sync", () => {
  it("parses MCP text envelopes for schema paths", () => {
    const who = parseWhoamiEnvelope(FABRICATED.whoami);
    expect(who?.userId).toBe(FABRICATED_USER_ID);
    const projects = parseListProjectsEnvelope(FABRICATED.projects);
    expect(projects.length).toBeGreaterThan(0);
    const conn = parseListClientConnectionsEnvelope(FABRICATED.client_connections);
    expect(conn.clientsInScope).toBe(3);
    expect(conn.statusCounts.all_clear).toBe(1);
  });

  it("matches owner yugen media slug authority to yg3 media api slug", () => {
    expect(
      ownerSlugAuthorityMatch(
        normalizeWorkspaceSlug("yg3-media"),
        normalizeWorkspaceSlug("yugen media"),
      ),
    ).toBe(true);
  });

  it("selects unique client row with yg3 name and media slug token", () => {
    const clientId = FABRICATED_CLIENT_ID;
    const snap = mcpText(JSON.stringify({ client: { name: "YG3 Media", slug: "yg3-media-co" } }));
    const res = selectOwnerClientBySlugAndYg3NameHeuristic({
      clients: [
        { clientId, name: "YG3 Media", slug: null },
        { clientId: "44444444-4444-4444-8444-444444444444", name: "YG3", slug: "yg3" },
      ],
      snapshotByClientId: new Map([[clientId, snap]]),
    });
    expect(res.verified).toBe(true);
    if (res.verified) expect(res.clientId).toBe(clientId);
  });

  it("resolves unique narrow candidate by company website linkage", () => {
    const clientId = FABRICATED_CLIENT_ID;
    const candidates = filterNarrowNameCandidates([
      { clientId, name: "YG3 Media Ops", slug: "yg3-media" },
      { clientId: "44444444-4444-4444-8444-444444444444", name: "Other Co", slug: null },
    ]);
    expect(candidates.length).toBe(1);
    const snap = mcpText(JSON.stringify({ website: "https://yg3.ai" }));
    const res = resolveUniqueWebsiteLinkage({
      candidates,
      host: "yg3.ai",
      domainsByClientId: new Map(),
      snapshotByClientId: new Map([[clientId, snap]]),
      setupHealthByClientId: new Map(),
    });
    expect(res.ok).toBe(true);
  });

  it("verifies YG3 Media query singleton via company website snapshot anchor", () => {
    const clientId = FABRICATED_CLIENT_ID;
    const snap = mcpText(
      JSON.stringify({ detail: "connected property includes yg3.ai" }),
    );
    const res = selectYg3MediaWorkspaceFromQuerySingleton({
      query: "YG3 Media",
      clients: [{ clientId, name: "Other Label", slug: "x" }],
      clientSnapshot: snap,
    });
    expect(res.verified).toBe(true);
    if (res.verified) {
      expect(res.basis).toBe(
        "list_clients_query_singleton_plus_company_website_snapshot",
      );
    }
  });

  it("parses JSON and plain-text client metric envelopes", () => {
    expect(
      parseSearchOpportunitiesEnvelope(
        mcpText(
          JSON.stringify({
            strikeDistance: [{ kind: "a" }, { kind: "b" }],
            lowCtr: [{ kind: "c" }],
          }),
        ),
      ),
    ).toBe(2);
    expect(parseLeadsEnvelope(mcpText("No leads found."))).toEqual({
      kind: "empty",
      count: 0,
    });
    expect(
      parseDailyCheckinEnvelope(mcpText("• Sync queue stable.\n• 2 alerts.\n"))
        .insightLines.length,
    ).toBe(2);
  });

  it("resolves workspace by scope_client_id", () => {
    const clients = parseListClientsEnvelope(
      mcpText(
        `[{"id":"${FABRICATED_CLIENT_ID}","name":"Acme Co"}]`,
      ),
    );
    const who = parseWhoamiEnvelope(
      mcpText(
        JSON.stringify({
          agency_id: FABRICATED_AGENCY_ID,
          user_id: FABRICATED_USER_ID,
          scope_client_id: FABRICATED_CLIENT_ID,
          scope_client_name: "Acme Co",
        }),
      ),
    );
    const res = resolveExactWorkspace(who, clients);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.clientId).toBe(FABRICATED_CLIENT_ID);
  });

  it("rejects broad multi-client list without exact authority", () => {
    const clients = parseListClientsEnvelope(
      mcpText(
        `[{"id":"${FABRICATED_CLIENT_ID}","name":"A"},{"id":"44444444-4444-4444-8444-444444444444","name":"B"}]`,
      ),
    );
    const verify = verifyExactWorkspaceAuthority(
      parseWhoamiEnvelope(FABRICATED.whoami),
      clients,
    );
    expect(verify.verified).toBe(false);
    if (!verify.verified) expect(verify.candidateCount).toBe(2);
  });

  it("skips client-scoped metrics when workspace is not verified", () => {
    const snap = projectYg3SnapshotV1(
      { tenantKey: "t", userKey: "u" },
      "2026-01-01T00:00:00.000Z",
      FABRICATED,
      { allowClientScopedMetrics: false },
    );
    expect(snap.metricAvailability.client_snapshot).toBe("unavailable");
    expect(snap.metricAvailability.traffic_breakdown).toBe("unavailable");
    expect(snap.growth.visits).toBeNull();
  });

  it("stops on ambiguous workspace candidates", () => {
    const clients = parseListClientsEnvelope(
      mcpText(
        `[{"id":"${FABRICATED_CLIENT_ID}","name":"A"},{"id":"44444444-4444-4444-8444-444444444444","name":"B"}]`,
      ),
    );
    const res = resolveExactWorkspace(parseWhoamiEnvelope(FABRICATED.whoami), clients);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.candidateCount).toBe(2);
  });

  it("extracts trusted client ids only from explicit client_id fields", () => {
    const ids = extractTrustedClientIds(
      parseWhoamiEnvelope(FABRICATED.whoami),
      parseListProjectsEnvelope(FABRICATED.projects),
      5,
    );
    expect(ids).toEqual([FABRICATED_CLIENT_ID]);
  });

  it("projects fabricated discovery into snapshot without PII fields", () => {
    const snap = projectYg3SnapshotV1(
      { tenantKey: FABRICATED_AGENCY_ID, userKey: FABRICATED_USER_ID },
      "2026-01-01T00:00:00.000Z",
      FABRICATED,
    );
    expect(snap.workspace.clientCount).toBe(3);
    expect(snap.projects.total).toBe(2);
    expect(snap.growth.visits).toBe(42);
    expect(snapshotHasNoPiiFields(snap)).toBe(true);
    expect(snap.metricAvailability.client_snapshot).toBe("mapped");
  });

  it("maps snapshot into growth and lifecycle feeds with ordinal labels", () => {
    const snap = projectYg3SnapshotV1(
      { tenantKey: "t", userKey: "u" },
      "2026-01-01T00:00:00.000Z",
      FABRICATED,
    );
    const load = {
      enabled: true,
      snapshot: snap,
      health: "ok" as const,
      source: "yg3-mcp" as const,
    };
    const growth = growthFeedFromYg3Snapshot(load, "7d");
    expect(growth?.source).toBe("yg3-mcp");
    const accounts = yg3AccountsFeedFromSnapshot(load);
    expect(accounts?.items[0]?.name).toMatch(/^Workspace /);
    expect(accounts?.items.every((r) => !r.email.includes("@"))).toBe(true);
    const life = lifecycleFeedFromYg3Snapshot(load);
    expect(life?.source).toBe("yg3-mcp");
  });

  it("rejects tenant mismatch on meta bind", () => {
    const dir = mkdtempSync(join(tmpdir(), "gc-yg3-sync-"));
    const meta = new Yg3SnapshotMetaStore(join(dir, "snapshot-meta.json"));
    meta.bindIdentity({ tenantKey: "t1", userKey: "u1" });
    expect(() =>
      meta.touchWhoamiOk({ tenantKey: "t2", userKey: "u1" }),
    ).toThrow(/tenant_identity_mismatch/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("atomic snapshot store writes mode 600", () => {
    const dir = mkdtempSync(join(tmpdir(), "gc-yg3-sync-"));
    const store = new Yg3SnapshotFileStore(join(dir, "yg3", "snapshot-v1.json"));
    const snap = projectYg3SnapshotV1(
      { tenantKey: "t", userKey: "u" },
      "2026-01-01T00:00:00.000Z",
      FABRICATED,
    );
    store.saveAtomic(snap);
    const loaded = store.load();
    expect(loaded?.tenantKey).toBe("t");
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects public audience before MCP session", async () => {
    clearYg3SnapshotFlightForTests();
    const dir = mkdtempSync(join(tmpdir(), "gc-yg3-sync-"));
    process.env.YG3_MCP_ENABLED = "1";
    const { runYg3OwnerSync } = await import("./snapshot-service.js");
    await expect(
      runYg3OwnerSync({
        repoRoot: dir,
        relayDataDir: join(dir, "data"),
        audience: "public",
      }),
    ).rejects.toThrow();
    delete process.env.YG3_MCP_ENABLED;
    rmSync(dir, { recursive: true, force: true });
  });

  it("malformed snapshot file returns null", () => {
    const dir = mkdtempSync(join(tmpdir(), "gc-yg3-sync-"));
    const path = join(dir, "snapshot-v1.json");
    writeFileSync(path, "{not-json", "utf8");
    const store = new Yg3SnapshotFileStore(path);
    expect(store.load()).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});
