#!/usr/bin/env node
import { createYg3ReadonlyMcpClient } from "./factory.js";
import {
  loadRepoDotenv,
  relayDataDirFromRepoModule,
  resolveRepoRootFromRelayModule,
} from "./repo-env.js";
import { isYg3McpEnabled } from "./url.js";
import { searchWorkspacesForPrincipal } from "./workspace-selection-service.js";

loadRepoDotenv(import.meta.url);

async function main(): Promise<void> {
  const query = process.argv.slice(2).join(" ").trim();
  if (!query) {
    console.log(JSON.stringify({ ok: false, error: "missing_query" }));
    process.exit(1);
  }
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
  const out = await client.runReadSession(async (call) => {
    const whoami = await call("whoami", {});
    return searchWorkspacesForPrincipal({
      call,
      relayDataDir,
      whoamiPayload: whoami,
      query,
    });
  });
  if (!out.ok) {
    console.log(JSON.stringify(out));
    process.exit(out.blocker === "client_scope_auto_no_search" ? 0 : 1);
  }
  console.log(JSON.stringify(out));
}

main().catch(() => {
  console.log(JSON.stringify({ ok: false, error: "search_crashed" }));
  process.exit(1);
});
