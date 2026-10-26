import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  loadLocalEnv,
  parseLocalEnvFile,
  repoRootFromScriptsModule,
} from "./load-local-env.mjs";

test("loadLocalEnv preserves quoted values with spaces", () => {
  const dir = mkdtempSync(join(tmpdir(), "gc-env-"));
  writeFileSync(
    join(dir, ".env"),
    'GROUND_CONTROL_WORK_ROOT="/tmp/my work"\nYG3_MCP_ENABLED=1\n',
  );
  const prev = process.env.GROUND_CONTROL_WORK_ROOT;
  delete process.env.GROUND_CONTROL_WORK_ROOT;
  loadLocalEnv(dir);
  assert.equal(process.env.GROUND_CONTROL_WORK_ROOT, "/tmp/my work");
  assert.equal(process.env.YG3_MCP_ENABLED, "1");
  if (prev === undefined) delete process.env.GROUND_CONTROL_WORK_ROOT;
  else process.env.GROUND_CONTROL_WORK_ROOT = prev;
  rmSync(dir, { recursive: true, force: true });
});

test("parseLocalEnvFile reads spaced paths without shell source", () => {
  const dir = mkdtempSync(join(tmpdir(), "gc-env-"));
  writeFileSync(
    join(dir, ".env"),
    'BRAIN_ROOT="/Users/me/My Brain"\n',
  );
  const parsed = parseLocalEnvFile(dir);
  assert.equal(parsed.BRAIN_ROOT, "/Users/me/My Brain");
  rmSync(dir, { recursive: true, force: true });
});

test("repo root from scripts module resolves", () => {
  const root = repoRootFromScriptsModule(import.meta.url);
  const pkgPath = join(root, "package.json");
  assert.ok(existsSync(pkgPath));
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  assert.equal(pkg.name, "agent-control");
  assert.ok(existsSync(join(root, "scripts", "load-local-env.mjs")));
});
