#!/usr/bin/env node
/**
 * Append GROUND_CONTROL_WORK_ROOT from legacy PARTHA_WORK_ROOT when safe.
 * Requires backup via backup-local-config.mjs first (caller responsibility).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnvKeys } from "./doctor-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(root, ".env");
if (!existsSync(envPath)) {
  console.log("migrate: no .env");
  process.exit(0);
}

const keys = parseEnvKeys(envPath);
if (keys.has("GROUND_CONTROL_WORK_ROOT")) {
  console.log("migrate: ground_control_work_root_already_set");
  process.exit(0);
}
const legacy = keys.get("PARTHA_WORK_ROOT");
if (!legacy?.trim()) {
  console.log("migrate: no_legacy_work_root");
  process.exit(0);
}

let text = readFileSync(envPath, "utf8");
if (!text.endsWith("\n")) text += "\n";
text += `\n# Canonical work-root key (Slice 3A); legacy PARTHA_WORK_ROOT still honored\nGROUND_CONTROL_WORK_ROOT=${legacy.trim()}\n`;
writeFileSync(envPath, text);
console.log("migrate: appended_ground_control_work_root");
