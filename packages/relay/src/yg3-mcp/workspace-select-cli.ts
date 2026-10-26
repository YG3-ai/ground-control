#!/usr/bin/env node
import { createYg3ReadonlyMcpClient } from "./factory.js";
import {
  loadRepoDotenv,
  relayDataDirFromRepoModule,
  resolveRepoRootFromRelayModule,
} from "./repo-env.js";
import { isYg3McpEnabled } from "./url.js";
import {
  selectWorkspaceForPrincipal,
  type WorkspaceSelectInput,
} from "./workspace-selection-service.js";
import { selectWorkspaceBySlug } from "./workspace-selector.js";
import {
  OWNER_CLIENT_WORKSPACE_SLUG_NORMALIZED,
} from "./workspace-owner-select.js";
import { normalizeWorkspaceSlug } from "./workspace-resolve.js";

loadRepoDotenv(import.meta.url);

function readArgs(): WorkspaceSelectInput | "owner_slug" | null {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--ref" && args[i + 1]) {
      const n = Number.parseInt(args[i + 1] ?? "", 10);
      if (Number.isFinite(n) && n > 0) return { kind: "ref", ref: n };
    }
    if (args[i] === "--slug" && args[i + 1]) {
      const slug = args[i + 1] ?? "";
      if (
        normalizeWorkspaceSlug(slug) ===
        normalizeWorkspaceSlug(OWNER_CLIENT_WORKSPACE_SLUG_NORMALIZED)
      ) {
        return "owner_slug";
      }
      return { kind: "slug", slug };
    }
    if (args[i] === "--name" && args[i + 1]) {
      return { kind: "name", name: args[i + 1] ?? "" };
    }
  }
  const positional = args.filter((a) => !a.startsWith("--")).join(" ").trim();
  if (!positional) return null;
  if (
    normalizeWorkspaceSlug(positional) ===
    normalizeWorkspaceSlug(OWNER_CLIENT_WORKSPACE_SLUG_NORMALIZED)
  ) {
    return "owner_slug";
  }
  return { kind: "slug", slug: positional };
}

async function main(): Promise<void> {
  const input = readArgs();
  if (!input) {
    console.log(
      JSON.stringify({
        ok: false,
        error: "missing_select_arg",
        usage: "yg3:select --ref N | --slug SLUG | --name NAME",
      }),
    );
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
  const result = await client.runReadSession(async (call) => {
    const whoami = await call("whoami", {});
    if (input === "owner_slug") {
      return selectWorkspaceBySlug({
        call,
        relayDataDir,
        whoamiPayload: whoami,
        slugInput: OWNER_CLIENT_WORKSPACE_SLUG_NORMALIZED,
        requireCorroboratingName: true,
      });
    }
    return selectWorkspaceForPrincipal({
      call,
      relayDataDir,
      whoamiPayload: whoami,
      input,
    });
  });
  if (!result.ok) {
    console.log(
      JSON.stringify({
        ok: false,
        selector_status: result.selectorStatus,
        blocker: result.blocker,
      }),
    );
    process.exit(1);
  }
  console.log(
    JSON.stringify({
      ok: true,
      selector_status: result.selectorStatus,
      selection_basis: result.selectionBasis,
      principal_tier: result.principalTier,
    }),
  );
}

main().catch(() => {
  console.log(JSON.stringify({ ok: false, error: "select_crashed" }));
  process.exit(1);
});
