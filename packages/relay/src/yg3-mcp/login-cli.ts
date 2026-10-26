#!/usr/bin/env node
import {
  canonicalYg3MetadataStore,
  resolveYg3MetadataStore,
} from "./metadata-path.js";
import { resolveRepoRootFromRelayModule } from "./repo-env.js";
import { Yg3OAuthProvider } from "./oauth-provider.js";
import { KeychainTokenStore } from "./token-store.js";
import { runYg3LoginFlow } from "./login-flow.js";
import {
  loadRepoDotenv,
  relayDataDirFromRepoModule,
} from "./repo-env.js";
import { isYg3McpEnabled, resolveYg3McpUrl } from "./url.js";

loadRepoDotenv(import.meta.url);

async function main(): Promise<void> {
  if (!isYg3McpEnabled()) {
    console.error("Set YG3_MCP_ENABLED=1 in .env before yg3:login");
    process.exit(1);
  }
  const repoRoot = resolveRepoRootFromRelayModule(import.meta.url);
  const dataDir = relayDataDirFromRepoModule(import.meta.url);
  const mcpUrl = resolveYg3McpUrl();
  const metadataStore = resolveYg3MetadataStore(dataDir, repoRoot);
  const persistStore = canonicalYg3MetadataStore(dataDir);
  const tokenStore = new KeychainTokenStore();
  const provider = new Yg3OAuthProvider({
    redirectUrl: "http://127.0.0.1/callback",
    metadataStore: persistStore,
    tokenStore,
  });

  if (metadataStore !== persistStore) {
    const legacy = metadataStore.load();
    if (legacy.client?.client_id) {
      persistStore.save(legacy);
    }
  }

  const result = await runYg3LoginFlow({
    mcpUrl,
    provider,
    metadataStore: persistStore,
  });
  if (!result.ok) {
    console.error(`yg3:login failed: ${result.error}`);
    process.exit(1);
  }
  const clientRegistered = Boolean(
    persistStore.load().client?.client_id,
  );
  const hasTokens = await tokenStore.hasTokens();
  if (!clientRegistered || !hasTokens) {
    console.error("yg3:login failed: incomplete_oauth_state");
    process.exit(1);
  }
  console.log("yg3:login ok");
}

main().catch(() => {
  console.error("yg3:login failed");
  process.exit(1);
});
