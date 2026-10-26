#!/usr/bin/env node
/**
 * Owner-only sanitized YG3 connectivity probe (whoami + allowlisted tool schemas).
 * Never prints tokens, client secrets, or identity fields.
 */
import { existsSync, statSync } from "node:fs";
import { createYg3ReadonlyMcpClient } from "./factory.js";
import { KeychainTokenStore } from "./token-store.js";
import {
  primaryOAuthMetadataPath,
  resolveYg3MetadataStore,
} from "./metadata-path.js";
import {
  loadRepoDotenv,
  relayDataDirFromRepoModule,
  resolveRepoRootFromRelayModule,
} from "./repo-env.js";
import { roleCategoryFromWhoami } from "./sanitize.js";
import { isYg3McpEnabled } from "./url.js";

loadRepoDotenv(import.meta.url);

type ProbeReport = {
  yg3_mcp_enabled: boolean;
  oauth_metadata_present: boolean;
  oauth_metadata_mode?: string;
  keychain_tokens_present: boolean;
  connected: boolean;
  browser_required: boolean;
  role_category?: string;
  allowlisted_tool_schemas?: Array<{
    name: string;
    hasInputSchema: boolean;
    hasOutputSchema: boolean;
  }>;
  error_code?: string;
};

async function main(): Promise<void> {
  const report: ProbeReport = {
    yg3_mcp_enabled: isYg3McpEnabled(),
    oauth_metadata_present: false,
    keychain_tokens_present: false,
    connected: false,
    browser_required: true,
  };

  const repoRoot = resolveRepoRootFromRelayModule(import.meta.url);
  const relayDataDir = relayDataDirFromRepoModule(import.meta.url);
  const metadataStore = resolveYg3MetadataStore(relayDataDir, repoRoot);
  const oauthPath = primaryOAuthMetadataPath(relayDataDir);

  const clientRegistered = Boolean(metadataStore.load().client?.client_id);
  report.oauth_metadata_present = clientRegistered;
  if (existsSync(oauthPath)) {
    try {
      const mode = statSync(oauthPath).mode & 0o777;
      report.oauth_metadata_mode = mode.toString(8);
    } catch {
      report.oauth_metadata_mode = "unknown";
    }
  } else if (clientRegistered) {
    report.oauth_metadata_mode = "legacy_location";
  }

  const tokenStore = new KeychainTokenStore();
  report.keychain_tokens_present = await tokenStore.hasTokens();

  if (!report.yg3_mcp_enabled) {
    report.error_code = "mcp_disabled";
    console.log(JSON.stringify(report));
    return;
  }

  if (!report.oauth_metadata_present || !report.keychain_tokens_present) {
    report.browser_required = true;
    report.error_code = "oauth_incomplete";
    console.log(JSON.stringify(report));
    return;
  }

  const client = createYg3ReadonlyMcpClient({
    relayDataDir,
    repoRoot,
    audience: "owner",
    tokenStore,
  });
  if (!client) {
    report.error_code = "client_unavailable";
    console.log(JSON.stringify(report));
    return;
  }

  const identity = await client.probeIdentity();
  if (!identity.ok) {
    report.browser_required = true;
    report.error_code = identity.error ?? "whoami_failed";
    console.log(JSON.stringify(report));
    return;
  }

  let role = "unknown";
  try {
    const raw = await client.fetchWhoamiPayload();
    role = roleCategoryFromWhoami(raw);
  } catch {
    role = "unknown";
  }

  let schemas: ProbeReport["allowlisted_tool_schemas"] = [];
  try {
    schemas = await client.discoverAllowlistedToolSchemas();
  } catch {
    report.connected = true;
    report.browser_required = false;
    report.role_category = role;
    report.error_code = "tool_catalog_failed";
    console.log(JSON.stringify(report));
    return;
  }

  report.connected = true;
  report.browser_required = false;
  report.role_category = role;
  report.allowlisted_tool_schemas = schemas;
  console.log(JSON.stringify(report));
}

main().catch(() => {
  console.log(
    JSON.stringify({
      connected: false,
      browser_required: true,
      error_code: "probe_crashed",
    }),
  );
  process.exit(1);
});
