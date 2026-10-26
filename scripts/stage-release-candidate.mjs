#!/usr/bin/env node
/**
 * Copy release-boundary candidates to a temp directory and re-run safety scans.
 * No archive, no git commit, no private data copy.
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync, statSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  analyzeRelease,
  loadBoundary,
  resolveManifest,
} from "./release-boundary-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const keep = process.env.GROUND_CONTROL_STAGE_KEEP === "1";
const dest =
  process.env.GROUND_CONTROL_STAGE_DIR?.trim() ||
  mkdtempSync(join(tmpdir(), "gc-release-candidate-"));

const boundary = loadBoundary(root);
const manifest = resolveManifest(root, boundary);

let copied = 0;
for (const rel of manifest.files) {
  const src = join(root, rel);
  const dst = join(dest, rel);
  mkdirSync(dirname(dst), { recursive: true });
  try {
    cpSync(src, dst, { preserveTimestamps: true });
    const mode = statSync(src).mode & 0o777;
    try {
      chmodSync(dst, mode);
    } catch {
      /* ignore */
    }
    copied += 1;
  } catch {
    console.log(`stage_skip: ${rel}`);
  }
}

const stagedManifest = {
  mode: `staged:${manifest.mode}`,
  files: manifest.files.filter((rel) => {
    try {
      statSync(join(dest, rel));
      return true;
    } catch {
      return false;
    }
  }),
  limitation: manifest.limitation,
};

const { pathFindings, startupFindings } = analyzeRelease(
  dest,
  boundary,
  stagedManifest,
);

const failed = pathFindings.length + startupFindings.length > 0;
console.log(`stage_root: ${dest}`);
console.log(`stage_mode: ${manifest.mode}`);
console.log(`candidate_file_count: ${stagedManifest.files.length}`);
console.log(`copied: ${copied}`);
if (manifest.limitation.length) {
  console.log(`limitations: ${manifest.limitation.join(",")}`);
}
for (const f of [...pathFindings, ...startupFindings].sort((a, b) =>
  a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind),
)) {
  console.log(`${f.kind}: ${f.path}`);
}

if (!keep && !process.env.GROUND_CONTROL_STAGE_DIR) {
  rmSync(dest, { recursive: true, force: true });
  console.log("stage_cleaned: true");
} else {
  console.log("stage_cleaned: false");
}

process.exit(failed ? 1 : 0);
