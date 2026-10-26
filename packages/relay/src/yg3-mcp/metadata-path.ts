import { existsSync } from "node:fs";
import { join } from "node:path";
import { Yg3MetadataStore } from "./metadata-store.js";

/** Primary oauth-client.json under the configured relay data directory. */
export function primaryOAuthMetadataPath(relayDataDir: string): string {
  return join(relayDataDir, "yg3", "oauth-client.json");
}

/** Legacy paths from pre-3B1 login-cli repo-root bug; read-only until canonical save. */
export function legacyOAuthMetadataPaths(repoRoot: string): string[] {
  return [
    join(repoRoot, "packages", "data", "relay", "yg3", "oauth-client.json"),
    join(
      repoRoot,
      "packages",
      "relay",
      "data",
      "relay",
      "yg3",
      "oauth-client.json",
    ),
  ];
}

export function resolveYg3MetadataStore(
  relayDataDir: string,
  repoRoot: string,
): Yg3MetadataStore {
  const primary = primaryOAuthMetadataPath(relayDataDir);
  if (existsSync(primary)) {
    return new Yg3MetadataStore(primary);
  }
  for (const legacy of legacyOAuthMetadataPaths(repoRoot)) {
    if (existsSync(legacy)) {
      return new Yg3MetadataStore(legacy);
    }
  }
  return new Yg3MetadataStore(primary);
}

/** Persist metadata to the canonical path (migrates off legacy on write). */
export function canonicalYg3MetadataStore(relayDataDir: string): Yg3MetadataStore {
  return new Yg3MetadataStore(primaryOAuthMetadataPath(relayDataDir));
}
