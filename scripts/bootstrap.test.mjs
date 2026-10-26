import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

const repoRoot = join(import.meta.dirname, "..");

test("bootstrap only-dirs does not overwrite existing env", () => {
  const dir = mkdtempSync(join(tmpdir(), "gc-boot-"));
  writeFileSync(join(dir, ".env.example"), "DEMO=1\n");
  writeFileSync(join(dir, "config.example.yaml"), "owner:\n  id: x\n");
  writeFileSync(join(dir, ".env"), "KEEP=1\n");
  writeFileSync(join(dir, "package.json"), '{"name":"t","scripts":{}}');
  execFileSync("bash", [join(repoRoot, "scripts/bootstrap.sh"), "--only-dirs"], {
    cwd: dir,
    env: { ...process.env, GROUND_CONTROL_BOOTSTRAP_ROOT: dir },
  });
  assert.equal(readFileSync(join(dir, ".env"), "utf8").trim(), "KEEP=1");
  assert.ok(existsSync(join(dir, "data/relay")));
  rmSync(dir, { recursive: true, force: true });
});

test("bootstrap creates missing config from examples", () => {
  const dir = mkdtempSync(join(tmpdir(), "gc-boot-"));
  writeFileSync(join(dir, ".env.example"), "DEMO=1\n");
  writeFileSync(join(dir, "config.example.yaml"), "owner:\n  id: x\n");
  writeFileSync(join(dir, "package.json"), '{"name":"t","scripts":{}}');
  execFileSync("bash", [join(repoRoot, "scripts/bootstrap.sh"), "--only-dirs"], {
    cwd: dir,
    env: { ...process.env, GROUND_CONTROL_BOOTSTRAP_ROOT: dir },
  });
  assert.ok(existsSync(join(dir, ".env")));
  assert.ok(existsSync(join(dir, "config.yaml")));
  rmSync(dir, { recursive: true, force: true });
});
