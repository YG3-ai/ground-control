import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  exactDisplayNameMatch,
  exactNormalizedSlugMatch,
  readStoredSelectionSummary,
  searchWorkspacesForPrincipal,
  selectWorkspaceForPrincipal,
  selectorPathForTier,
} from "./workspace-selection-service.js";
import { WorkspaceSearchSessionStore } from "./workspace-search-session.js";
import { WorkspaceSelectionStore } from "./workspace-selection-store.js";
import { buildSelectionRecord } from "./workspace-selector.js";

const FABRICATED_CLIENT_ID = "11111111-1111-4111-8111-111111111111";
const FABRICATED_AGENCY_ROW_ID = "22222222-2222-4222-8222-222222222222";
const FABRICATED_AGENCY_ID = "33333333-3333-4333-8333-333333333333";
const FABRICATED_USER_ID = "44444444-4444-4444-8444-444444444444";

function mcpText(text: string): unknown {
  return [{ type: "text", text }];
}

function whoamiSuperAdmin(): unknown {
  return mcpText(
    JSON.stringify({
      agency_id: FABRICATED_AGENCY_ID,
      user_id: FABRICATED_USER_ID,
      role: "superadmin",
      principal_type: "superadmin",
    }),
  );
}

function whoamiAgency(): unknown {
  return mcpText(
    JSON.stringify({
      agency_id: FABRICATED_AGENCY_ID,
      user_id: FABRICATED_USER_ID,
      role: "agency_owner",
      principal_type: "agency",
    }),
  );
}

function whoamiClientScoped(): unknown {
  return mcpText(
    JSON.stringify({
      agency_id: FABRICATED_AGENCY_ID,
      user_id: FABRICATED_USER_ID,
      role: "member",
      principal_type: "client",
      scope_client_id: FABRICATED_CLIENT_ID,
    }),
  );
}

describe("workspace selection service", () => {
  it("maps principal tiers to selector paths", () => {
    expect(selectorPathForTier("client_scoped")).toBe("client_auto");
    expect(selectorPathForTier("agency")).toBe("agency_search");
    expect(selectorPathForTier("super_admin")).toBe("superadmin_explicit");
  });

  it("blocks client-scoped search", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gc-yg3-sel-svc-"));
    const out = await searchWorkspacesForPrincipal({
      relayDataDir: dir,
      whoamiPayload: whoamiClientScoped(),
      query: "acme",
      call: async () => mcpText(""),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.blocker).toBe("client_scope_auto_no_search");
    rmSync(dir, { recursive: true, force: true });
  });

  it("super_admin search includes agency rows for disambiguation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gc-yg3-sel-svc-"));
    const listText =
      "- YG3 [yg3] (id: " +
      FABRICATED_AGENCY_ROW_ID +
      ")\n- YG3 Media [yg3-media] (id: " +
      FABRICATED_CLIENT_ID +
      ")";
    const out = await searchWorkspacesForPrincipal({
      relayDataDir: dir,
      whoamiPayload: whoamiSuperAdmin(),
      query: "YG3",
      call: async (tool, args) => {
        if (tool === "list_clients") return mcpText(listText);
        const id =
          args && typeof args === "object" && "client_id" in args
            ? String((args as { client_id: string }).client_id)
            : "";
        if (tool === "get_client_snapshot" && id === FABRICATED_AGENCY_ROW_ID) {
          return mcpText(
            JSON.stringify({ client: { name: "YG3", slug: "yg3" } }),
          );
        }
        if (tool === "get_client_snapshot" && id === FABRICATED_CLIENT_ID) {
          return mcpText(
            JSON.stringify({
              client: { name: "YG3 Media", slug: "yg3-media" },
            }),
          );
        }
        throw new Error(`unexpected ${tool}`);
      },
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.results.some((r) => r.accountKind === "agency")).toBe(true);
      expect(out.results.some((r) => r.accountKind === "client")).toBe(true);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("agency search returns client rows only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gc-yg3-sel-svc-"));
    const listText =
      "- YG3 [yg3] (id: " +
      FABRICATED_AGENCY_ROW_ID +
      ")\n- YG3 Media [yg3-media] (id: " +
      FABRICATED_CLIENT_ID +
      ")";
    const out = await searchWorkspacesForPrincipal({
      relayDataDir: dir,
      whoamiPayload: whoamiAgency(),
      query: "YG3",
      call: async (tool, args) => {
        if (tool === "list_clients") return mcpText(listText);
        const id =
          args && typeof args === "object" && "client_id" in args
            ? String((args as { client_id: string }).client_id)
            : "";
        if (tool === "get_client_snapshot" && id === FABRICATED_AGENCY_ROW_ID) {
          return mcpText(
            JSON.stringify({ client: { name: "YG3", slug: "yg3" } }),
          );
        }
        if (tool === "get_client_snapshot" && id === FABRICATED_CLIENT_ID) {
          return mcpText(
            JSON.stringify({
              client: { name: "YG3 Media", slug: "yg3-media" },
            }),
          );
        }
        throw new Error(`unexpected ${tool}`);
      },
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.results.every((r) => r.accountKind === "client")).toBe(true);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects selecting agency ref for super_admin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gc-yg3-sel-svc-"));
    WorkspaceSearchSessionStore.defaultPath(dir).save({
      version: 1,
      tenantKey: FABRICATED_AGENCY_ID,
      userKey: FABRICATED_USER_ID,
      principalTier: "super_admin",
      query: "YG3",
      createdAt: new Date().toISOString(),
      entries: [
        {
          ref: 1,
          clientId: FABRICATED_AGENCY_ROW_ID,
          accountKind: "agency",
        },
      ],
    });
    const res = await selectWorkspaceForPrincipal({
      relayDataDir: dir,
      whoamiPayload: whoamiSuperAdmin(),
      input: { kind: "ref", ref: 1 },
      call: async () => mcpText(""),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.blocker).toBe("agency_account_not_selectable");
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists tenant-bound selection on client ref select", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gc-yg3-sel-svc-"));
    WorkspaceSearchSessionStore.defaultPath(dir).save({
      version: 1,
      tenantKey: FABRICATED_AGENCY_ID,
      userKey: FABRICATED_USER_ID,
      principalTier: "agency",
      query: "YG3",
      createdAt: new Date().toISOString(),
      entries: [
        {
          ref: 2,
          clientId: FABRICATED_CLIENT_ID,
          accountKind: "client",
        },
      ],
    });
    const snap = mcpText(
      JSON.stringify({
        client: { name: "YG3 Media", slug: "yg3-media" },
      }),
    );
    const res = await selectWorkspaceForPrincipal({
      relayDataDir: dir,
      whoamiPayload: whoamiAgency(),
      input: { kind: "ref", ref: 2 },
      call: async (tool) => {
        if (tool === "get_client_snapshot") return snap;
        throw new Error(`unexpected ${tool}`);
      },
    });
    expect(res.ok).toBe(true);
    const stored = WorkspaceSelectionStore.defaultPath(dir).load();
    expect(stored?.tenantKey).toBe(FABRICATED_AGENCY_ID);
    expect(stored?.principalTier).toBe("agency");
    rmSync(dir, { recursive: true, force: true });
  });

  it("matches exact slug and display name helpers", () => {
    expect(exactNormalizedSlugMatch("yg3-media", "yg3 media")).toBe(true);
    expect(exactDisplayNameMatch("YG3 Media", "yg3 media")).toBe(true);
  });

  it("reads stored selection summary without exposing ids", () => {
    const dir = mkdtempSync(join(tmpdir(), "gc-yg3-sel-svc-"));
    WorkspaceSelectionStore.defaultPath(dir).save(
      buildSelectionRecord({
        identity: { tenantKey: FABRICATED_AGENCY_ID, userKey: FABRICATED_USER_ID },
        tier: "super_admin",
        clientId: FABRICATED_CLIENT_ID,
        selectionBasis: "exact_normalized_slug",
        normalizedSlug: "yg3 media",
        displayNameCorroborated: true,
      }),
    );
    const summary = readStoredSelectionSummary({
      relayDataDir: dir,
      whoamiPayload: whoamiSuperAdmin(),
    });
    expect(summary.hasStoredSelection).toBe(true);
    expect(summary.normalizedSlug).toBe("yg3 media");
    expect(JSON.stringify(summary)).not.toMatch(FABRICATED_CLIENT_ID);
    rmSync(dir, { recursive: true, force: true });
  });
});
