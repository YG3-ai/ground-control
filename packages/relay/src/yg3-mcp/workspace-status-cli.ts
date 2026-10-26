#!/usr/bin/env node
import { createYg3ReadonlyMcpClient } from "./factory.js";
import {
  loadRepoDotenv,
  relayDataDirFromRepoModule,
  resolveRepoRootFromRelayModule,
} from "./repo-env.js";
import { isYg3McpEnabled } from "./url.js";
import { readStoredSelectionSummary } from "./workspace-selection-service.js";

loadRepoDotenv(import.meta.url);

async function main(): Promise<void> {
  if (!isYg3McpEnabled()) {
    console.log(JSON.stringify({ ok: false, error: "mcp_disabled" }));
    process.exit(1);
  }
  const relayDataDir = relayDataDirFromRepoModule(import.meta.url);
  const repoRoot = resolveRepoRootFromRelayModule(import.meta.url);
  const mcp = createYg3ReadonlyMcpClient({
    relayDataDir,
    repoRoot,
    audience: "owner",
  });
  if (!mcp) {
    console.log(JSON.stringify({ ok: false, error: "client_unavailable" }));
    process.exit(1);
  }
  const client = mcp as NonNullable<typeof mcp>;
  const summary = await client.runReadSession(async (call) => {
    const whoami = await call("whoami", {});
    return readStoredSelectionSummary({ relayDataDir, whoamiPayload: whoami });
  });
  console.log(JSON.stringify({ ok: true, ...summary }));
}

main().catch(() => {
  console.log(JSON.stringify({ ok: false, error: "status_crashed" }));
  process.exit(1);
});
