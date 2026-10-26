import { join } from "node:path";
import { Yg3ReadonlyMcpClient } from "./client.js";
import { resolveYg3MetadataStore } from "./metadata-path.js";
import { resolveRepoRootFromRelayModule } from "./repo-env.js";
import { Yg3OAuthProvider } from "./oauth-provider.js";
import { Yg3SnapshotMetaStore } from "./snapshot-meta.js";
import { KeychainTokenStore, type TokenStore } from "./token-store.js";
import { assertOwnerYg3McpAccess, yg3McpConfigured } from "./access.js";
import { resolveYg3McpUrl } from "./url.js";

export type Yg3McpFactoryDeps = {
  relayDataDir: string;
  audience: string;
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
  tokenStore?: TokenStore;
  redirectUrl?: string;
  fetchFn?: typeof fetch;
};

/**
 * Owner-only factory. Returns null when MCP path disabled (legacy adapters remain default).
 */
export function createYg3ReadonlyMcpClient(
  deps: Yg3McpFactoryDeps,
): Yg3ReadonlyMcpClient | null {
  const env = deps.env ?? process.env;
  assertOwnerYg3McpAccess(deps.audience);
  if (!yg3McpConfigured(env)) return null;

  const mcpUrl = resolveYg3McpUrl(env);
  const repoRoot =
    deps.repoRoot ?? resolveRepoRootFromRelayModule(import.meta.url);
  const meta = resolveYg3MetadataStore(deps.relayDataDir, repoRoot);
  const snapshot = Yg3SnapshotMetaStore.defaultPath(deps.relayDataDir);
  const tokenStore = deps.tokenStore ?? new KeychainTokenStore();
  const redirectUrl =
    deps.redirectUrl ?? `http://127.0.0.1/oauth/yg3/callback`;
  const authProvider = new Yg3OAuthProvider({
    redirectUrl,
    metadataStore: meta,
    tokenStore,
  });

  return new Yg3ReadonlyMcpClient({
    mcpUrl,
    authProvider,
    snapshotMeta: snapshot,
    fetchFn: deps.fetchFn,
  });
}

export function resolveRelayDataDir(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const rel = env.RELAY_DATA_DIR?.trim() || "./data/relay";
  return rel.startsWith("/") ? rel : join(repoRoot, rel);
}
