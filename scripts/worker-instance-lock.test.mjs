import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { acquireWorkerLock, releaseWorkerLock } from "./worker-instance-lock.mjs";

const repoRoot = join(import.meta.dirname, "..");

test("run-worker.sh does not use flock (macOS stock bash)", () => {
  const sh = readFileSync(join(repoRoot, "scripts/run-worker.sh"), "utf8");
  assert.ok(!/\bflock\b/.test(sh));
  assert.ok(sh.includes("worker-instance-lock.mjs"));
});

test("acquire and release worker lock directory", () => {
  const base = mkdtempSync(join(tmpdir(), "gc-worker-lock-"));
  const lockRoot = join(base, ".worker-instance.lock");
  const holder = process.pid;
  const a = acquireWorkerLock(lockRoot, { pid: holder });
  assert.equal(a.ok, true);
  const b = acquireWorkerLock(lockRoot, { pid: holder });
  assert.equal(b.ok, false);
  assert.equal(b.reason, "held");
  const rel = releaseWorkerLock(lockRoot, { pid: holder });
  assert.equal(rel.ok, true);
  const c = acquireWorkerLock(lockRoot, { pid: holder });
  assert.equal(c.ok, true);
  releaseWorkerLock(lockRoot, { pid: holder });
  rmSync(base, { recursive: true, force: true });
});

test("CLI acquire exits 1 when lock held", () => {
  const base = mkdtempSync(join(tmpdir(), "gc-worker-lock-cli-"));
  const lockRoot = join(base, ".worker-instance.lock");
  acquireWorkerLock(lockRoot, { pid: process.pid });
  let exit = 0;
  try {
    execFileSync("node", [join(repoRoot, "scripts/worker-instance-lock.mjs"), "acquire", lockRoot], {
      encoding: "utf8",
    });
  } catch (err) {
    exit = err.status ?? 2;
  }
  assert.equal(exit, 1);
  releaseWorkerLock(lockRoot, { pid: process.pid });
  rmSync(base, { recursive: true, force: true });
});
