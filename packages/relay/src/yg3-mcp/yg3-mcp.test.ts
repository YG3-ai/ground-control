import { describe, expect, it, vi } from "vitest";
import {
  assertReadOnlyToolArgs,
  assertReadToolAllowed,
} from "./allowlist.js";
import { buildKeychainAddArgs, buildKeychainFindArgs } from "./keychain.js";
import { MemoryTokenStore } from "./token-store.js";
import { Yg3SnapshotMetaStore } from "./snapshot-meta.js";
import { normalizeWhoamiIdentity, roleCategoryFromWhoami } from "./sanitize.js";
import { resolveRepoRootFromRelayModule } from "./repo-env.js";
import { resolveYg3MetadataStore } from "./metadata-path.js";
import { validateYg3McpUrl } from "./url.js";
import { assertOwnerYg3McpAccess, Yg3PublicAccessError } from "./access.js";
import { createYg3ReadonlyMcpClient } from "./factory.js";
import { runYg3LoginFlow } from "./login-flow.js";
import { Yg3MetadataStore } from "./metadata-store.js";
import { Yg3OAuthProvider } from "./oauth-provider.js";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("YG3 MCP foundation", () => {
  it("validates HTTPS for production URLs", () => {
    expect(() => validateYg3McpUrl("http://example.com/mcp")).toThrow();
    expect(validateYg3McpUrl("https://mcp.yg3.ai/mcp").href).toContain("https");
    expect(validateYg3McpUrl("http://127.0.0.1:9/mcp").protocol).toBe("http:");
  });

  it("rejects non-allowlisted and write-semantics args", () => {
    expect(() => assertReadToolAllowed("delete_everything")).toThrow();
    assertReadToolAllowed("whoami");
    assertReadToolAllowed("list_clients");
    assertReadToolAllowed("list_client_domains");
    expect(() => assertReadOnlyToolArgs({ confirm: true })).toThrow();
    expect(() => assertReadOnlyToolArgs({ idempotency_key: "x" })).toThrow();
  });

  it("builds keychain argv arrays without shell", () => {
    const add = buildKeychainAddArgs("secret-json");
    expect(add[0]).toBe("add-generic-password");
    expect(add).toContain("-w");
    expect(buildKeychainFindArgs()).not.toContain("-w");
  });

  it("memory token store never logs secrets", async () => {
    const store = new MemoryTokenStore();
    await store.save({ access_token: "abc", token_type: "bearer" });
    expect(await store.hasTokens()).toBe(true);
    await store.clear();
    expect(await store.hasTokens()).toBe(false);
  });

  it("snapshot meta rejects tenant mismatch", () => {
    const dir = mkdtempSync(join(tmpdir(), "gc-yg3-meta-"));
    const store = new Yg3SnapshotMetaStore(join(dir, "snapshot-meta.json"));
    store.bindIdentity({ tenantKey: "t1", userKey: "u1" });
    expect(() =>
      store.touchWhoamiOk({ tenantKey: "t2", userKey: "u1" }),
    ).toThrow(/tenant_identity_mismatch/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("normalizes whoami identity fields", () => {
    const id = normalizeWhoamiIdentity({ tenant_id: "t", user_id: "u" });
    expect(id.tenantKey).toBe("t");
    expect(id.userKey).toBe("u");
  });

  it("maps whoami role to category without echoing identifiers", () => {
    expect(roleCategoryFromWhoami({ role: "agency_owner" })).toBe("owner");
    expect(roleCategoryFromWhoami({ account_role: "read_only" })).toBe("viewer");
    expect(roleCategoryFromWhoami({ tenant_id: "secret" })).toBe("unknown");
  });

  it("resolves monorepo root from relay yg3 module", () => {
    const root = resolveRepoRootFromRelayModule(import.meta.url);
    expect(root).toMatch(/agent-control$/);
  });

  it("resolves legacy oauth metadata path when canonical missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "gc-yg3-legacy-meta-"));
    const repo = join(dir, "repo");
    const legacyDir = join(
      repo,
      "packages",
      "data",
      "relay",
      "yg3",
    );
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      join(legacyDir, "oauth-client.json"),
      JSON.stringify({ client: { client_id: "cid" } }),
    );
    const relayData = join(repo, "data", "relay");
    const store = resolveYg3MetadataStore(relayData, repo);
    expect(store.load().client?.client_id).toBe("cid");
    rmSync(dir, { recursive: true, force: true });
  });

  it("blocks public audience from factory", () => {
    expect(() =>
      createYg3ReadonlyMcpClient({
        relayDataDir: "/tmp",
        audience: "public",
        env: { YG3_MCP_ENABLED: "1" },
        tokenStore: new MemoryTokenStore(),
      }),
    ).toThrow(Yg3PublicAccessError);
    expect(
      createYg3ReadonlyMcpClient({
        relayDataDir: "/tmp",
        audience: "owner",
        env: { YG3_MCP_ENABLED: "0" },
        tokenStore: new MemoryTokenStore(),
      }),
    ).toBeNull();
  });

  it("assertOwnerYg3McpAccess allows owner", () => {
    assertOwnerYg3McpAccess("owner");
    expect(() => assertOwnerYg3McpAccess("public")).toThrow();
  });

  it("login flow times out safely when callback never arrives", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gc-yg3-login-"));
    const meta = new Yg3MetadataStore(join(dir, "oauth-client.json"));
    meta.save({
      client: {
        client_id: "cid",
        client_id_issued_at: 1,
        redirect_uris: ["http://127.0.0.1/callback"],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
    });
    const tokens = new MemoryTokenStore();
    const provider = new Yg3OAuthProvider({
      redirectUrl: "http://127.0.0.1/callback",
      metadataStore: meta,
      tokenStore: tokens,
    });
    const mcpUrl = new URL("http://127.0.0.1:9/mcp");
    const fetchFn = vi.fn(async () => new Response("{}", { status: 404 }));
    const result = await runYg3LoginFlow({
      mcpUrl,
      provider,
      metadataStore: meta,
      timeoutMs: 200,
      fetchFn: fetchFn as typeof fetch,
      openBrowser: async () => {},
    });
    expect(result.ok).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
