import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { resolveRelayDataDir } from "./factory.js";

/** Monorepo root from a module under packages/relay/src/... */
export function resolveRepoRootFromRelayModule(importMetaUrl: string): string {
  return resolve(dirname(fileURLToPath(importMetaUrl)), "../../../..");
}

export function loadRepoDotenv(importMetaUrl: string): void {
  const root = resolveRepoRootFromRelayModule(importMetaUrl);
  const path = resolve(root, ".env");
  if (existsSync(path)) {
    loadDotenv({ path, override: false });
  }
}

export function relayDataDirFromRepoModule(importMetaUrl: string): string {
  const root = resolveRepoRootFromRelayModule(importMetaUrl);
  return resolveRelayDataDir(root);
}
