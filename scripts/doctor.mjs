#!/usr/bin/env node
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "./load-local-env.mjs";
import { runDoctorAsync } from "./doctor-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
loadLocalEnv(root);
const jsonOut = process.argv.includes("--json");
const probeHealth = process.argv.includes("--probe-health");
const skipNative = process.argv.includes("--skip-native");

const port = process.env.RELAY_PORT || "8787";
const relayHealthUrl = probeHealth
  ? `http://127.0.0.1:${port}/healthz`
  : null;

const result = await runDoctorAsync({
  root,
  relayHealthUrl,
  skipNative,
});

if (jsonOut) {
  console.log(JSON.stringify({ ok: result.ok, checks: result.checks }, null, 0));
} else {
  for (const c of result.checks) {
    console.log(`${c.id}: ${c.status} (${c.severity}) ${c.detail}`);
  }
  console.log(`doctor: ${result.ok ? "ok" : "failed"}`);
}

process.exit(result.exitCode);
