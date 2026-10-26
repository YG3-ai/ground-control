import { existsSync } from "node:fs";
import { join } from "node:path";
import { LIFE_MIRROR_ASSET_PATTERN } from "./board-world-live.js";

export function isAllowedLifeMirrorAsset(file: string): boolean {
  if (!file || file.includes("/") || file.includes("\\") || file.includes("..")) {
    return false;
  }
  return LIFE_MIRROR_ASSET_PATTERN.test(file);
}

/** Resolve shipped life-mirror files across src/dist and monorepo cwd layouts. */
export function resolveLifeMirrorAssetPath(
  relayDir: string,
  file: string,
): string | null {
  if (!isAllowedLifeMirrorAsset(file)) return null;

  const dirs = new Set<string>([
    join(relayDir, "assets", "life-mirror"),
    join(relayDir, "..", "src", "assets", "life-mirror"),
    join(relayDir, "..", "dist", "assets", "life-mirror"),
  ]);
  const cwd = process.cwd();
  if (cwd) {
    dirs.add(join(cwd, "packages", "relay", "src", "assets", "life-mirror"));
    dirs.add(join(cwd, "packages", "relay", "dist", "assets", "life-mirror"));
  }

  for (const dir of dirs) {
    const path = join(dir, file);
    if (existsSync(path)) return path;
  }
  return null;
}
