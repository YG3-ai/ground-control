#!/usr/bin/env node
/**
 * Timestamped backup of ignored local config (no stdout secrets).
 * Usage: node scripts/backup-local-config.mjs
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dir = join(root, ".release-local-backups", stamp);
mkdirSync(dir, { recursive: true });

const manifest = { at: stamp, entries: [] };

function backupFile(rel, type) {
  const src = join(root, rel);
  if (!existsSync(src)) return;
  const dest = join(dir, rel.replace(/\//g, "__"));
  copyFileSync(src, dest);
  manifest.entries.push({ type, backupPath: dest, sourceRel: rel });
}

backupFile(".env", "dotenv");
backupFile("config.yaml", "yaml_config");

const pathsSrc = readFileSync(
  join(root, "packages/relay/src/board-extensions/paths.ts"),
  "utf8",
);
const pathKeys = {};
const work = pathsSrc.match(
  /const DEFAULT_PARTHA_WORK\s*=\s*\n?\s*"([^"]+)"/,
);
const brain = pathsSrc.match(/const DEFAULT_BRAIN_ROOT\s*=\s*"([^"]+)"/);
if (work?.[1]) pathKeys.PARTHA_WORK_ROOT = work[1];
if (brain?.[1]) {
  pathKeys.BRAIN_ROOT = brain[1];
  pathKeys.BRAIN_PYTHON = `${brain[1]}/.venv/bin/python`;
  pathKeys.BRAIN_SCRIPT = `${brain[1]}/brain.py`;
  pathKeys.BRAIN_VAULT = `${brain[1]}/vault`;
}
pathKeys.FUNNELS_LOOPBACK_URL = "http://127.0.0.1:4141";
writeFileSync(join(dir, "path-keys.json"), JSON.stringify(pathKeys, null, 2));
manifest.entries.push({ type: "path_keys_snapshot", backupPath: join(dir, "path-keys.json") });

writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`backup_dir: ${dir}`);
console.log(`entries: ${manifest.entries.map((e) => e.type).join(",")}`);
