import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  analyzeRelease,
  forbiddenPathFinding,
  isInReleaseBoundary,
  listCandidateWalk,
  loadBoundary,
  resolveManifest,
  startupContentFindings,
} from "./release-boundary-lib.mjs";
// startupContentFindings imported for render plist assertion

const repoRoot = join(import.meta.dirname, "..");
const boundary = loadBoundary(repoRoot);

test("boundary keeps example env and excludes live env", () => {
  assert.equal(isInReleaseBoundary(".env.example", boundary), true);
  assert.equal(isInReleaseBoundary(".env", boundary), false);
  assert.equal(isInReleaseBoundary("config.example.yaml", boundary), true);
  assert.equal(isInReleaseBoundary("config.yaml", boundary), false);
});

test("forbiddenPathFinding flags secret artifacts by path only", () => {
  assert.deepEqual(forbiddenPathFinding("logs/out.log", boundary), {
    path: "logs/out.log",
    kind: "excluded_pattern",
  });
  assert.deepEqual(forbiddenPathFinding(".env", boundary), {
    path: ".env",
    kind: "forbidden_basename",
  });
  assert.equal(forbiddenPathFinding(".env.example", boundary), null);
});

test("startup heuristics detect machine paths without echoing content", () => {
  const bad = startupContentFindings(
    "launchd/x.plist",
    '<string>/Users/Someone/Projects/app</string>',
  );
  assert.ok(bad.some((f) => f.kind === "machine_user_home_path"));
  const ok = startupContentFindings(
    ".env.example",
    "BINARY=/Users/YOU/.local/bin/agent\nPUBLIC_BASE_URL=https://your-stable-name.ngrok-free.app\n",
  );
  assert.equal(ok.length, 0);
});

test("analyzeRelease reports kinds only", () => {
  const dir = mkdtempSync(join(tmpdir(), "gc-release-"));
  const sub = join(dir, "launchd");
  mkdirSync(join(dir, "release"), { recursive: true });
  mkdirSync(sub, { recursive: true });
  writeFileSync(
    join(dir, "release", "boundary.json"),
    readFileSync(join(repoRoot, "release/boundary.json")),
  );
  writeFileSync(
    join(sub, "test.plist"),
    "<string>/Users/NotYou/proj</string>",
  );
  const mini = {
    ...boundary,
    includeGlobs: ["release/**", "launchd/**"],
    excludeGlobs: [],
    startupConfigGlobs: ["launchd/**"],
  };
  const manifest = { mode: "test", files: ["launchd/test.plist"], limitation: [] };
  const { startupFindings } = analyzeRelease(dir, mini, manifest);
  assert.ok(startupFindings.length >= 1);
  assert.equal("content" in startupFindings[0], false);
  rmSync(dir, { recursive: true, force: true });
});

test("candidate-walk includes packages source not logs", () => {
  const files = listCandidateWalk(repoRoot, boundary);
  assert.ok(files.some((f) => f.startsWith("packages/")));
  assert.ok(!files.some((f) => f.startsWith("logs/")));
});

test("resolveManifest documents no-commit limitation", () => {
  const dir = mkdtempSync(join(tmpdir(), "gc-git-"));
  mkdirSync(join(dir, "release"));
  writeFileSync(
    join(dir, "release/boundary.json"),
    readFileSync(join(repoRoot, "release/boundary.json")),
  );
  writeFileSync(join(dir, ".env.example"), "X=1\n");
  const mini = {
    ...boundary,
    includeGlobs: [".env.example", "release/**"],
    excludeGlobs: [],
  };
  const m = resolveManifest(dir, mini);
  assert.ok(m.limitation.length > 0 || m.mode === "candidate-walk");
  rmSync(dir, { recursive: true, force: true });
});

test("render-launchd-plist substitutes project root token only", () => {
  const out = execFileSync(
    "bash",
    [join(repoRoot, "scripts/render-launchd-plist.sh"), "com.groundcontrol.relay"],
    { encoding: "utf8" },
  );
  assert.ok(!out.includes("__GROUND_CONTROL_ROOT__"));
  assert.match(out, /run-relay\.sh/);
});

test("checker output shape has no secret payload fields", () => {
  const { pathFindings, startupFindings } = analyzeRelease(repoRoot, boundary, {
    mode: "candidate-walk",
    files: listCandidateWalk(repoRoot, boundary),
    limitation: ["test"],
  });
  for (const f of [...pathFindings, ...startupFindings]) {
    assert.ok(f.path);
    assert.ok(f.kind);
    assert.equal(Object.keys(f).length, 2);
  }
});
