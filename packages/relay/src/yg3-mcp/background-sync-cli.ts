#!/usr/bin/env node
/**
 * Workspace-verified read-only YG3 sync for launchd / manual triggers.
 */
import { createYg3ReadonlyMcpClient } from "./factory.js";
import {
  loadRepoDotenv,
  relayDataDirFromRepoModule,
  resolveRepoRootFromRelayModule,
} from "./repo-env.js";
import { Yg3RawResponseStore } from "./raw-store.js";
import { isYg3McpEnabled } from "./url.js";
import type { Yg3SyncTrigger } from "./yg3-sync-status.js";
import { runVerifiedOwnerYg3Sync } from "./verified-owner-sync.js";

loadRepoDotenv(import.meta.url);

function parseTrigger(): Yg3SyncTrigger {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--trigger" && args[i + 1]) {
      const t = args[i + 1] as Yg3SyncTrigger;
      if (
        t === "calendar" ||
        t === "run_at_load" ||
        t === "manual" ||
        t === "setup"
      ) {
        return t;
      }
    }
  }
  return "unknown";
}

async function main(): Promise<void> {
  const trigger = parseTrigger();
  if (!isYg3McpEnabled()) {
    console.log(JSON.stringify({ ok: false, error: "mcp_disabled" }));
    process.exit(1);
  }
  const repoRoot = resolveRepoRootFromRelayModule(import.meta.url);
  const relayDataDir = relayDataDirFromRepoModule(import.meta.url);
  const client = createYg3ReadonlyMcpClient({
    relayDataDir,
    repoRoot,
    audience: "owner",
  });
  if (!client) {
    console.log(JSON.stringify({ ok: false, error: "client_unavailable" }));
    process.exit(1);
  }
  const result = await runVerifiedOwnerYg3Sync({
    client,
    relayDataDir,
    rawStore: Yg3RawResponseStore.defaultPath(relayDataDir),
    trigger,
  });
  if (result.skipped === "already_running") {
    console.log(JSON.stringify({ ok: true, skipped: "already_running" }));
    return;
  }
  if (!result.ok) {
    console.log(JSON.stringify({ ok: false, error: result.errorCode }));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, synced: true }));
}

main().catch(() => {
  console.log(JSON.stringify({ ok: false, error: "background_sync_crashed" }));
  process.exit(1);
});
