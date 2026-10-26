#!/usr/bin/env node
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assertLoopbackHealthUrl } from "./doctor-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = process.env.RELAY_PORT || "8787";
const defaultUrl = `http://127.0.0.1:${port}/healthz`;
const allowRemote = process.argv.includes("--allow-remote");

let healthUrl = defaultUrl;
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith("--url=")) healthUrl = arg.slice(6);
}

if (!allowRemote) {
  try {
    assertLoopbackHealthUrl(healthUrl);
  } catch {
    console.error("verify-local: health URL must be loopback (use --allow-remote to override)");
    process.exit(2);
  }
}

let res;
try {
  res = await fetch(healthUrl, { signal: AbortSignal.timeout(8000) });
} catch {
  console.error("verify-local: relay unreachable");
  process.exit(1);
}

if (!res.ok) {
  console.error(`verify-local: health HTTP ${res.status}`);
  process.exit(1);
}

let body;
try {
  body = await res.json();
} catch {
  console.error("verify-local: invalid health JSON");
  process.exit(1);
}

const connected = Boolean(body?.worker?.connected ?? body?.connected);
console.log(`relay_health: ok`);
console.log(`worker_connected: ${connected}`);

process.exit(connected ? 0 : 1);
