#!/usr/bin/env node
/**
 * macOS-safe single worker instance lock (no flock). Uses an atomic directory
 * create with PID file; stale locks recover when the owning PID is gone.
 */
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { fileURLToPath } from "node:url";

const STALE_GRACE_MS = 5000;

function lockPaths(lockRoot) {
  const dir = lockRoot.endsWith(".lock.d") ? lockRoot : `${lockRoot}.d`;
  return { dir, pidFile: `${dir}/pid`, metaFile: `${dir}/meta.json` };
}

function pidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLockPid(pidFile) {
  try {
    const raw = readFileSync(pidFile, "utf8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function tryRemoveStale(dir, pidFile) {
  const pid = readLockPid(pidFile);
  if (pid !== null && pidAlive(pid)) return false;
  try {
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export function acquireWorkerLock(lockRoot, options = {}) {
  const { pid = process.pid } = options;
  const { dir, pidFile, metaFile } = lockPaths(lockRoot);

  try {
    mkdirSync(dir, { recursive: false });
    writeFileSync(pidFile, String(pid), { encoding: "utf8", flag: "w" });
    writeFileSync(
      metaFile,
      JSON.stringify({ pid, startedAt: new Date().toISOString() }),
      "utf8",
    );
    return { ok: true, dir, pid };
  } catch (err) {
    if (err && err.code !== "EEXIST") {
      return { ok: false, reason: "error", error: err };
    }
  }

  const existingPid = readLockPid(pidFile);
  if (existingPid !== null && pidAlive(existingPid)) {
    return { ok: false, reason: "held", pid: existingPid, dir };
  }

  if (!tryRemoveStale(dir, pidFile)) {
    const again = readLockPid(pidFile);
    if (again !== null && pidAlive(again)) {
      return { ok: false, reason: "held", pid: again, dir };
    }
    return { ok: false, reason: "busy", dir };
  }

  return acquireWorkerLock(lockRoot, options);
}

export function releaseWorkerLock(lockRoot, options = {}) {
  const { pid = process.pid } = options;
  const { dir, pidFile } = lockPaths(lockRoot);
  if (!existsSync(dir)) return { ok: true, released: false };
  const owner = readLockPid(pidFile);
  if (owner !== null && owner !== pid) {
    return { ok: false, reason: "not_owner", pid: owner };
  }
  try {
    rmSync(dir, { recursive: true, force: true });
    return { ok: true, released: true };
  } catch (err) {
    return { ok: false, reason: "error", error: err };
  }
}

function usage() {
  console.error("usage: worker-instance-lock.mjs acquire|release <lock-root>");
  process.exit(2);
}

function main() {
  const [cmd, lockRoot] = process.argv.slice(2);
  if (!cmd || !lockRoot) usage();
  if (cmd === "acquire") {
    const r = acquireWorkerLock(lockRoot);
    if (r.ok) {
      process.stdout.write(String(r.pid ?? process.pid));
      process.exit(0);
    }
    if (r.reason === "held") process.exit(1);
    process.exit(2);
  }
  if (cmd === "release") {
    const r = releaseWorkerLock(lockRoot);
    process.exit(r.ok ? 0 : 1);
  }
  usage();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
