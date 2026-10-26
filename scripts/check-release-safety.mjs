#!/usr/bin/env node
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  analyzeRelease,
  loadBoundary,
  resolveManifest,
} from "./release-boundary-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const boundary = loadBoundary(root);
const manifest = resolveManifest(root, boundary);
const { pathFindings, startupFindings } = analyzeRelease(root, boundary, manifest);

const lines = [];
lines.push(`mode: ${manifest.mode}`);
lines.push(`candidates: ${manifest.files.length}`);
if (manifest.limitation.length) {
  lines.push(`limitations: ${manifest.limitation.join(",")}`);
}
for (const f of [...pathFindings, ...startupFindings].sort((a, b) =>
  a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind),
)) {
  lines.push(`${f.kind}: ${f.path}`);
}

const failed = pathFindings.length + startupFindings.length > 0;
for (const line of lines) {
  console.log(line);
}
process.exit(failed ? 1 : 0);
