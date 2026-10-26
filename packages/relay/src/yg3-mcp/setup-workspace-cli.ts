#!/usr/bin/env node
/**
 * First-run workspace resolution (no OAuth UI).
 */
import { createYg3ReadonlyMcpClient } from "./factory.js";
import {
  loadRepoDotenv,
  relayDataDirFromRepoModule,
  resolveRepoRootFromRelayModule,
} from "./repo-env.js";
import { isYg3McpEnabled } from "./url.js";
import { principalTierFromWhoami } from "./workspace-principal.js";
import { parseWhoamiEnvelope } from "./envelope-parsers.js";
import { resolveWorkspaceForSync } from "./workspace-selector.js";
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
  const out = await mcp.runReadSession(async (call) => {
    const whoami = await call("whoami", {});
    const tier = principalTierFromWhoami(parseWhoamiEnvelope(whoami));
    if (tier === "client_scoped") {
      const picked = await resolveWorkspaceForSync({
        call,
        relayDataDir,
        whoamiPayload: whoami,
      });
      return {
        ok: picked.ok,
        principal_tier: tier,
        selector_status: picked.ok ? picked.selectorStatus : picked.selectorStatus,
        blocker: picked.ok ? undefined : picked.blocker,
        action: picked.ok ? "auto_scope" : "fix_scope",
      };
    }
    const summary = readStoredSelectionSummary({
      relayDataDir,
      whoamiPayload: whoami,
    });
    if (summary.hasStoredSelection) {
      return {
        ok: true,
        principal_tier: tier,
        selector_status: "stored_selection_present",
        action: "none",
      };
    }
    return {
      ok: false,
      principal_tier: tier,
      selector_status: "selection_required",
      blocker: "workspace_selection_required",
      action: "run_yg3_workspaces_search_and_select",
    };
  });
  console.log(JSON.stringify(out));
  process.exit(out.ok ? 0 : 1);
}

main().catch(() => {
  console.log(JSON.stringify({ ok: false, error: "setup_workspace_crashed" }));
  process.exit(1);
});
