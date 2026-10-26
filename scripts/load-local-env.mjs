import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function loadDotenvModule() {
  try {
    return require("dotenv");
  } catch {
    const relayDotenv = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "packages",
      "relay",
      "node_modules",
      "dotenv",
    );
    return require(relayDotenv);
  }
}

const dotenv = loadDotenvModule();

/** Repo root when this file lives under scripts/. */
export function repoRootFromScriptsModule(importMetaUrl = import.meta.url) {
  return join(dirname(fileURLToPath(importMetaUrl)), "..");
}

/**
 * Load ignored local .env into process.env (no override of existing vars).
 * Safe for values containing spaces when quoted per dotenv rules.
 */
export function loadLocalEnv(root) {
  const path = join(root, ".env");
  if (!existsSync(path)) {
    return { loaded: false };
  }
  const result = dotenv.config({ path, override: false });
  return {
    loaded: true,
    error: result.error ? "parse_error" : undefined,
  };
}

/** Parse .env without mutating process.env (dotenv rules, supports quoted spaces). */
export function parseLocalEnvFile(root, rel = ".env") {
  const path = join(root, rel);
  if (!existsSync(path)) return null;
  return dotenv.parse(readFileSync(path, "utf8"));
}
