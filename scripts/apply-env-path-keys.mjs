#!/usr/bin/env node
/**
 * Append missing non-secret path keys to .env (preserves existing lines/values).
 * Usage: node scripts/apply-env-path-keys.mjs <backup-dir>
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const backupDir = process.argv[2];
if (!backupDir) {
  console.error("usage: apply-env-path-keys.mjs <backup-dir>");
  process.exit(1);
}

const keysPath = join(backupDir, "path-keys.json");
const envPath = join(root, ".env");
if (!existsSync(keysPath) || !existsSync(envPath)) {
  console.error("missing path-keys.json or .env");
  process.exit(1);
}

const pathKeys = JSON.parse(readFileSync(keysPath, "utf8"));
const ORDER = [
  "GROUND_CONTROL_WORK_ROOT",
  "FUNNELS_LOOPBACK_URL",
  "BRAIN_ROOT",
  "BRAIN_VAULT",
  "BRAIN_PYTHON",
  "BRAIN_SCRIPT",
];

let text = readFileSync(envPath, "utf8");
const present = new Set();
for (const line of text.split("\n")) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line.trim());
  if (m) present.add(m[1]);
}

const added = [];
for (const key of ORDER) {
  if (present.has(key) || pathKeys[key] === undefined) continue;
  if (!text.endsWith("\n")) text += "\n";
  text += `\n# Added by apply-env-path-keys (Slice 2B); safe to edit\n${key}=${pathKeys[key]}\n`;
  added.push(key);
}

if (added.length) writeFileSync(envPath, text);
console.log(`keys_added: ${added.length ? added.join(",") : "none"}`);
