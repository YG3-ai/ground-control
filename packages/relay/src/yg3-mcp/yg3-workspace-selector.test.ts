import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { classifyWorkspaceAccountKind } from "./workspace-account-kind.js";
import { principalTierFromWhoami } from "./workspace-principal.js";
import { normalizeWorkspaceSlug } from "./workspace-resolve.js";
import {
  buildSelectionRecord,
  revalidateStoredSelection,
  resolveWorkspaceForSync,
} from "./workspace-selector.js";
import { WorkspaceSelectionStore } from "./workspace-selection-store.js";
import {
  ownerSlugAuthorityMatch,
  selectOwnerClientBySlugAndYg3NameHeuristic,
} from "./workspace-owner-select.js";
import { pickClientOnlySearchHits } from "./workspace-catalog.js";

const FABRICATED_CLIENT_ID = "11111111-1111-4111-8111-111111111111";
const FABRICATED_AGENCY_ID = "22222222-2222-4222-8222-222222222222";
const FABRICATED_USER_ID = "33333333-3333-4333-8333-333333333333";

function mcpText(text: string): unknown {
  return [{ type: "text", text }];
}

describe("YG3 role-aware workspace selector", () => {
  it("classifies principal tiers", () => {
    expect(
      principalTierFromWhoami({
        agencyId: FABRICATED_AGENCY_ID,
        userId: FABRICATED_USER_ID,
        role: "superadmin",
        principalType: "superadmin",
        scopeClientId: null,
        scopeClientDisplayName: null,
      }),
    ).toBe("super_admin");
    expect(
      principalTierFromWhoami({
        agencyId: FABRICATED_AGENCY_ID,
        userId: FABRICATED_USER_ID,
        role: "member",
        principalType: "client",
        scopeClientId: FABRICATED_CLIENT_ID,
        scopeClientDisplayName: "Acme",
      }),
    ).toBe("client_scoped");
    expect(
      principalTierFromWhoami({
        agencyId: FABRICATED_AGENCY_ID,
        userId: FABRICATED_USER_ID,
        role: "agency_owner",
        principalType: "agency",
        scopeClientId: null,
        scopeClientDisplayName: null,
      }),
    ).toBe("agency");
  });

  it("separates agency vs client with duplicate YG3 names", () => {
    const agency = classifyWorkspaceAccountKind(
      { clientId: FABRICATED_CLIENT_ID, name: "YG3", slug: "yg3" },
      mcpText(JSON.stringify({ client: { name: "YG3", slug: "yg3" } })),
    );
    const client = classifyWorkspaceAccountKind(
      { clientId: FABRICATED_CLIENT_ID, name: "YG3 Media", slug: "yg3-media-co" },
      mcpText(
        JSON.stringify({ client: { name: "YG3 Media", slug: "yg3-media-co" } }),
      ),
    );
    expect(agency).toBe("agency");
    expect(client).toBe("client");
  });

  it("normalizes yugen media slug variants", () => {
    expect(normalizeWorkspaceSlug("yugen-media")).toBe("yugen media");
    expect(
      ownerSlugAuthorityMatch(
        normalizeWorkspaceSlug("yg3-media"),
        normalizeWorkspaceSlug("yugen media"),
      ),
    ).toBe(true);
  });

  it("binds and revalidates stored workspace selection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gc-yg3-ws-sel-"));
    const store = WorkspaceSelectionStore.defaultPath(dir);
    const record = buildSelectionRecord({
      identity: { tenantKey: "t1", userKey: "u1" },
      tier: "super_admin",
      clientId: FABRICATED_CLIENT_ID,
      selectionBasis: "client_type+exact_normalized_slug+yg3_name",
      normalizedSlug: "yugen media",
      displayNameCorroborated: true,
    });
    store.save(record);
    const loaded = store.load();
    expect(loaded?.clientId).toBe(FABRICATED_CLIENT_ID);

    const roster = [{ clientId: FABRICATED_CLIENT_ID, name: "YG3 Media", slug: null }];
    const snap = mcpText(
      JSON.stringify({ client: { id: FABRICATED_CLIENT_ID, name: "YG3 Media", slug: "yugen-media" } }),
    );
    const check = await revalidateStoredSelection(
      async (tool, args) => {
        const query =
          args && typeof args === "object" && "query" in args
            ? String((args as { query?: string }).query ?? "")
            : "";
        if (tool === "list_clients") {
          if (!query) return mcpText("(other clients only)");
          if (query === "YG3")
            return mcpText(
              "- YG3 Media [yugen-media] (id: " + FABRICATED_CLIENT_ID + ")",
            );
          return mcpText("");
        }
        if (tool === "get_client_snapshot") return snap;
        throw new Error("unexpected");
      },
      record,
      { principalTier: "super_admin" },
    );
    expect(check.valid).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects agency revalidation when client is outside roster pages", async () => {
    const record = buildSelectionRecord({
      identity: { tenantKey: "t1", userKey: "u1" },
      tier: "agency",
      clientId: FABRICATED_CLIENT_ID,
      selectionBasis: "manual",
      normalizedSlug: "yugen media",
      displayNameCorroborated: true,
    });
    const snap = mcpText(
      JSON.stringify({
        client: {
          id: FABRICATED_CLIENT_ID,
          name: "YG3 Media",
          slug: "yugen-media",
        },
      }),
    );
    const check = await revalidateStoredSelection(
      async (tool) => {
        if (tool === "list_clients") return mcpText("(other clients only)");
        if (tool === "get_client_snapshot") return snap;
        throw new Error("unexpected");
      },
      record,
      { principalTier: "agency" },
    );
    expect(check.valid).toBe(false);
  });

  it("filters search hits to client accounts only", () => {
    const hits = pickClientOnlySearchHits([
      { ref: 1, displayName: "YG3", slugNormalized: "yg3", accountKind: "agency" },
      { ref: 2, displayName: "YG3 Media", slugNormalized: "yg3-media", accountKind: "client" },
    ]);
    expect(hits.length).toBe(1);
    expect(hits[0]?.accountKind).toBe("client");
  });

  it("client_scoped sync auto-selects verified scope client", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gc-yg3-ws-sel-"));
    const whoami = mcpText(
      JSON.stringify({
        agency_id: FABRICATED_AGENCY_ID,
        user_id: FABRICATED_USER_ID,
        role: "member",
        principal_type: "client",
        scope_client_id: FABRICATED_CLIENT_ID,
        scope_client_display_name: "Acme Co",
      }),
    );
    const snap = mcpText(
      JSON.stringify({
        client: { name: "Acme Co", slug: "acme-co" },
      }),
    );
    const result = await resolveWorkspaceForSync({
      relayDataDir: dir,
      whoamiPayload: whoami,
      call: async (tool) => {
        if (tool === "get_client_snapshot") return snap;
        throw new Error(`unexpected ${tool}`);
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.selectorStatus).toBe("auto_client_scope");
      expect(result.selectionBasis).toBe("auto_scope_client_id");
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("super_admin sync requires explicit stored selection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gc-yg3-ws-sel-"));
    const whoami = mcpText(
      JSON.stringify({
        agency_id: FABRICATED_AGENCY_ID,
        user_id: FABRICATED_USER_ID,
        role: "superadmin",
        principal_type: "superadmin",
      }),
    );
    const result = await resolveWorkspaceForSync({
      relayDataDir: dir,
      whoamiPayload: whoami,
      call: async (tool) => {
        if (tool === "list_clients") return mcpText("");
        throw new Error(`unexpected ${tool}`);
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.selectorStatus).toBe("selection_required");
      expect(result.blocker).toBe("workspace_selection_required");
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("selects unique client by media slug heuristic", () => {
    const snap = mcpText(
      JSON.stringify({ client: { name: "YG3 Media", slug: "yg3-media-co" } }),
    );
    const res = selectOwnerClientBySlugAndYg3NameHeuristic({
      clients: [
        { clientId: FABRICATED_CLIENT_ID, name: "YG3 Media", slug: null },
        { clientId: "44444444-4444-4444-8444-444444444444", name: "YG3", slug: "yg3" },
      ],
      snapshotByClientId: new Map([[FABRICATED_CLIENT_ID, snap]]),
    });
    expect(res.verified).toBe(true);
  });
});
