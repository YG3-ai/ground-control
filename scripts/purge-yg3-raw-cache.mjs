#!/usr/bin/env node
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv, parseLocalEnvFile } from "./load-local-env.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
loadLocalEnv(root);

const { purgeYg3RawCache } = await import(
  "../packages/relay/src/yg3-mcp/raw-store.ts"
);

const env = parseLocalEnvFile(root) ?? {};
const relayRel = env.RELAY_DATA_DIR?.trim() || "./data/relay";
const relayDataDir = relayRel.startsWith("/")
  ? relayRel
  : join(root, relayRel);

const removed = purgeYg3RawCache(relayDataDir);
console.log(`yg3_raw_purge: removed=${removed}`);
