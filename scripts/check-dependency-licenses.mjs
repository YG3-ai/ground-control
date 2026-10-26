#!/usr/bin/env node
/**
 * Summarize production dependency licenses; flag UNKNOWN or policy-blocked SPDX ids.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = join(root, "package-lock.json");
const BLOCKED = new Set(["UNLICENSED", "UNKNOWN"]);
const WARN_ONLY = new Set(["GPL-3.0", "GPL-2.0", "AGPL-3.0"]);

if (!existsSync(lockPath)) {
  console.log("dependency_licenses: missing_lockfile");
  process.exit(1);
}

const lock = JSON.parse(readFileSync(lockPath, "utf8"));
const packages = lock.packages ?? {};
const byLicense = new Map();
const flagged = [];

for (const [pkgPath, meta] of Object.entries(packages)) {
  if (!pkgPath || pkgPath === "") continue;
  if (!meta.license) continue;
  const name = pkgPath.replace(/^node_modules\//, "").split("node_modules/").pop();
  const lic = String(meta.license).trim();
  byLicense.set(lic, (byLicense.get(lic) || 0) + 1);
  if (BLOCKED.has(lic.toUpperCase())) {
    flagged.push({ name, license: lic, severity: "block" });
  } else if (WARN_ONLY.has(lic)) {
    flagged.push({ name, license: lic, severity: "warn_copyleft" });
  }
}

const licenses = [...byLicense.entries()]
  .sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `${k}:${v}`)
  .join(",");

console.log(`dependency_license_kinds: ${byLicense.size}`);
console.log(`dependency_license_summary: ${licenses.slice(0, 2000)}`);
console.log(`dependency_flags: ${flagged.length}`);
for (const f of flagged.slice(0, 20)) {
  console.log(`flag_${f.severity}: ${f.name} (${f.license})`);
}

const blocked = flagged.filter((f) => f.severity === "block");
process.exit(blocked.length ? 1 : 0);
