import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  isPlaceholderValue,
  parseEnvString,
  resolveWorkRootFromKeys,
  runDoctor,
  assertLoopbackHealthUrl,
} from "./doctor-lib.mjs";

test("placeholder detection avoids real tokens", () => {
  assert.equal(isPlaceholderValue("replace-with-long-random"), true);
  assert.equal(isPlaceholderValue("sk-live-not-placeholder"), false);
});

test("work root resolves canonical and legacy keys", () => {
  const keys = parseEnvString(
    "GROUND_CONTROL_WORK_ROOT=/a\nPARTHA_WORK_ROOT=/b\n",
  );
  assert.equal(resolveWorkRootFromKeys(keys), "/a");
});

test("doctor fails on missing env in temp root", () => {
  const dir = mkdtempSync(join(tmpdir(), "gc-doc-"));
  const r = runDoctor({ root: dir, skipNative: true });
  assert.equal(r.ok, false);
  assert.ok(r.checks.some((c) => c.id === "env_file" && c.status === "fail"));
  rmSync(dir, { recursive: true, force: true });
});

test("doctor passes structural checks with valid fixture env", () => {
  const dir = mkdtempSync(join(tmpdir(), "gc-doc-"));
  writeFileSync(
    join(dir, ".env"),
    `WORKER_TOKEN=${"x".repeat(24)}\nRELAY_JWT_SECRET=${"y".repeat(32)}\nOWNER_APPROVAL_SECRET=abcd\nPUBLIC_BASE_URL=http://127.0.0.1:8787\n`,
  );
  writeFileSync(join(dir, "config.yaml"), "owner:\n  id: o\n");
  const r = runDoctor({ root: dir, skipNative: true });
  assert.equal(r.ok, true);
  rmSync(dir, { recursive: true, force: true });
});

test("loopback health URL guard", () => {
  assert.throws(() => assertLoopbackHealthUrl("https://example.com/healthz"));
  assert.ok(assertLoopbackHealthUrl("http://127.0.0.1:8787/healthz"));
});
