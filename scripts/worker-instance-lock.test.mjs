import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  acquireWorkerLock,
  probeWorkerLock,
  releaseWorkerLock,
} from "./worker-instance-lock.mjs";

const repoRoot = join(import.meta.dirname, "..");

test("run-worker.sh does not use flock (macOS stock bash)", () => {
  const sh = readFileSync(join(repoRoot, "scripts/run-worker.sh"), "utf8");
  assert.ok(!/\bflock\b/.test(sh));
  assert.ok(sh.includes("worker-instance-lock.mjs"));
  assert.ok(!/worker-instance-lock\.mjs" acquire/.test(sh));
  assert.ok(sh.includes("GROUND_CONTROL_WORKER_LOCK_ROOT"));
});

test("worker CLI acquires the singleton instance lock", () => {
  const cli = readFileSync(
    join(repoRoot, "packages/worker/src/cli.ts"),
    "utf8",
  );
  assert.ok(cli.includes("acquireWorkerLock"));
  assert.ok(cli.includes("pid: process.pid"));
  assert.ok(cli.includes("GROUND_CONTROL_WORKER_LOCK_ROOT"));
});

test("root npm worker script starts the worker package CLI", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  assert.equal(pkg.scripts.worker, "npm run start -w @agent-control/worker");
});

test("acquire and release worker lock directory", () => {
  const base = mkdtempSync(join(tmpdir(), "gc-worker-lock-"));
  const lockRoot = join(base, ".worker-instance.lock");
  const holder = process.pid;
  const a = acquireWorkerLock(lockRoot, { pid: holder });
  assert.equal(a.ok, true);
  const b = acquireWorkerLock(lockRoot, { pid: holder + 1 });
  assert.equal(b.ok, false);
  assert.equal(b.reason, "held");
  const rel = releaseWorkerLock(lockRoot, { pid: holder });
  assert.equal(rel.ok, true);
  const c = acquireWorkerLock(lockRoot, { pid: holder });
  assert.equal(c.ok, true);
  releaseWorkerLock(lockRoot, { pid: holder });
  rmSync(base, { recursive: true, force: true });
});

test("stale lock recovers when holder pid is gone", () => {
  const base = mkdtempSync(join(tmpdir(), "gc-worker-lock-stale-"));
  const lockRoot = join(base, ".worker-instance.lock");
  const dir = `${lockRoot}.d`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pid"), "999999999", "utf8");
  const next = acquireWorkerLock(lockRoot, { pid: process.pid });
  assert.equal(next.ok, true);
  releaseWorkerLock(lockRoot, { pid: process.pid });
  rmSync(base, { recursive: true, force: true });
});

test("second launcher cannot acquire while real holder pid is alive", async () => {
  const base = mkdtempSync(join(tmpdir(), "gc-worker-lock-holder-"));
  const lockRoot = join(base, ".worker-instance.lock");
  const lockUrl = pathToFileURL(
    join(repoRoot, "scripts/worker-instance-lock.mjs"),
  ).href;
  const holder = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { acquireWorkerLock } from ${JSON.stringify(lockUrl)};
const lockRoot = ${JSON.stringify(lockRoot)};
const r = acquireWorkerLock(lockRoot, { pid: process.pid });
if (!r.ok) process.exit(2);
setInterval(() => {}, 60_000);`,
    ],
    { stdio: "ignore", detached: true },
  );
  holder.unref();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(holder.pid > 0);

  const blocked = acquireWorkerLock(lockRoot, { pid: process.pid });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "held");
  assert.equal(blocked.pid, holder.pid);

  process.kill(holder.pid, "SIGKILL");
  await new Promise((resolve) => setTimeout(resolve, 50));
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

test("probe reports held lock with owner pid", () => {
  const base = mkdtempSync(join(tmpdir(), "gc-worker-lock-probe-"));
  const lockRoot = join(base, ".worker-instance.lock");
  acquireWorkerLock(lockRoot, { pid: process.pid });
  const probe = probeWorkerLock(lockRoot);
  assert.equal(probe.held, true);
  assert.equal(probe.pid, process.pid);
  releaseWorkerLock(lockRoot, { pid: process.pid });
  rmSync(base, { recursive: true, force: true });
});
