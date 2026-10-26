import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  isMacOsPlatform,
  parseSetupCliArgs,
  printSetupHelp,
  runMacSetup,
  renderedYg3PlistPresent,
} from "./setup-mac-lib.mjs";
import {
  installYg3SyncLaunchAgent,
  uninstallYg3SyncLaunchAgent,
  launchAgentInstalled,
} from "./setup-mac-launchagent.mjs";

const repoRoot = join(import.meta.dirname, "..");

test("--help performs no setup writes", () => {
  const dir = mkdtempSync(join(tmpdir(), "gc-setup-help-"));
  const marker = join(dir, "marker.txt");
  writeFileSync(marker, "ok", "utf8");
  const before = readFileSync(marker, "utf8");
  assert.equal(parseSetupCliArgs(["--help"]).action, "help");
  const out = execFileSync(
    "node",
    [join(repoRoot, "scripts/setup-mac.mjs"), "--help"],
    { encoding: "utf8" },
  );
  assert.ok(out.includes("npm run setup:mac"));
  assert.equal(readFileSync(marker, "utf8"), before);
  assert.ok(!existsSync(join(dir, ".env")));
  rmSync(dir, { recursive: true, force: true });
});

test("printSetupHelp is side-effect free", () => {
  const dir = mkdtempSync(join(tmpdir(), "gc-setup-help-"));
  printSetupHelp();
  assert.ok(!existsSync(join(dir, ".env")));
  rmSync(dir, { recursive: true, force: true });
});

test("macOS gate rejects unsupported platform in setup entry", async () => {
  if (process.platform === "darwin") {
    const dir = mkdtempSync(join(tmpdir(), "gc-setup-mac-"));
    writeFileSync(
      join(dir, ".env"),
      "YG3_MCP_ENABLED=1\nRELAY_DATA_DIR=./data/relay\n",
    );
    const r = await runMacSetup({
      root: dir,
      dryRun: true,
      nonInteractive: true,
      brainRoot: join(dir, "brain"),
    });
    assert.equal(r.ok, true);
    rmSync(dir, { recursive: true, force: true });
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "gc-setup-mac-"));
  const r = await runMacSetup({ root: dir, dryRun: true, nonInteractive: true, brainRoot: "" });
  assert.equal(r.blocked, true);
  assert.equal(r.blocker, "unsupported_os");
  rmSync(dir, { recursive: true, force: true });
});

test("dry-run setup is idempotent on temp root", async () => {
  if (!isMacOsPlatform()) return;
  const dir = mkdtempSync(join(tmpdir(), "gc-setup-mac-"));
  writeFileSync(join(dir, ".env"), `YG3_MCP_ENABLED=1\nRELAY_DATA_DIR=./data/relay\n`);
  writeFileSync(join(dir, ".env.example"), "YG3_MCP_ENABLED=0\n");
  execFileSync("cp", ["-R", join(repoRoot, "scripts"), join(dir, "scripts")]);
  execFileSync("cp", ["-R", join(repoRoot, "launchd"), join(dir, "launchd")]);
  const a = await runMacSetup({
    root: dir,
    dryRun: true,
    nonInteractive: true,
    brainRoot: join(dir, "brain"),
  });
  const b = await runMacSetup({
    root: dir,
    dryRun: true,
    nonInteractive: true,
    brainRoot: join(dir, "brain"),
  });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  rmSync(dir, { recursive: true, force: true });
});

test("interactive missing token starts oauth via deps mock", async () => {
  if (!isMacOsPlatform()) return;
  const dir = mkdtempSync(join(tmpdir(), "gc-setup-mac-"));
  seedMinimalRepo(dir);
  writeFileSync(join(dir, ".env"), "YG3_MCP_ENABLED=1\nRELAY_DATA_DIR=./data/relay\n");
  let oauthCalled = false;
  let hasToken = false;
  const r = await runMacSetup({
    root: dir,
    dryRun: false,
    nonInteractive: false,
    testRootMode: true,
    brainRoot: join(dir, "brain"),
    deps: {
      keychainTokensPresent: () => {
        if (oauthCalled) hasToken = true;
        return hasToken;
      },
      promptYesNo: async () => true,
      promptLine: async () => "",
      runYg3Login: () => {
        oauthCalled = true;
        hasToken = true;
        return true;
      },
      runWorkspaceResolve: () => true,
    },
  });
  assert.equal(oauthCalled, true);
  assert.equal(r.ok, true);
  rmSync(dir, { recursive: true, force: true });
});

test("confirmed background install uses launchctl test double", async () => {
  if (!isMacOsPlatform()) return;
  const dir = mkdtempSync(join(tmpdir(), "gc-setup-mac-"));
  seedMinimalRepo(dir);
  writeFileSync(join(dir, ".env"), "YG3_MCP_ENABLED=1\nRELAY_DATA_DIR=./data/relay\n");
  execFileSync("bash", [join(dir, "scripts/prepare-yg3-launchagent.sh")], { cwd: dir });
  const launchAgentsDir = join(dir, "Library", "LaunchAgents");
  const calls = [];
  const r = await runMacSetup({
    root: dir,
    dryRun: false,
    nonInteractive: false,
    testRootMode: true,
    brainRoot: join(dir, "brain"),
    deps: {
      keychainTokensPresent: () => true,
      promptYesNo: async () => true,
      promptLine: async () => "",
      runWorkspaceResolve: () => true,
      launchctlExecutor: {
        getuid: () => 502,
        bootout: (d, l) => calls.push(`bootout:${d}/${l}`),
        bootstrap: (d, p) => {
          calls.push(`bootstrap:${d}:${p}`);
          return { ok: true };
        },
      },
    },
  });
  assert.equal(r.ok, true);
  assert.ok(calls.some((c) => c.startsWith("bootstrap:")));
  assert.ok(launchAgentInstalled(launchAgentsDir));
  rmSync(dir, { recursive: true, force: true });
});

test("declined background install does not call launchctl", async () => {
  if (!isMacOsPlatform()) return;
  const dir = mkdtempSync(join(tmpdir(), "gc-setup-mac-"));
  seedMinimalRepo(dir);
  writeFileSync(join(dir, ".env"), "YG3_MCP_ENABLED=1\nRELAY_DATA_DIR=./data/relay\n");
  execFileSync("bash", [join(dir, "scripts/prepare-yg3-launchagent.sh")], { cwd: dir });
  const calls = [];
  const r = await runMacSetup({
    root: dir,
    dryRun: false,
    nonInteractive: false,
    testRootMode: true,
    brainRoot: join(dir, "brain"),
    deps: {
      keychainTokensPresent: () => true,
      promptYesNo: async () => false,
      promptLine: async () => "",
      runWorkspaceResolve: () => true,
      launchctlExecutor: {
        bootout: () => calls.push("bootout"),
        bootstrap: () => calls.push("bootstrap"),
      },
    },
  });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("non-interactive never installs background agent", async () => {
  if (!isMacOsPlatform()) return;
  const dir = mkdtempSync(join(tmpdir(), "gc-setup-mac-"));
  seedMinimalRepo(dir);
  writeFileSync(join(dir, ".env"), "YG3_MCP_ENABLED=1\nRELAY_DATA_DIR=./data/relay\n");
  const calls = [];
  await runMacSetup({
    root: dir,
    dryRun: false,
    nonInteractive: true,
    testRootMode: true,
    brainRoot: "/tmp/brain",
    deps: {
      keychainTokensPresent: () => true,
      runWorkspaceResolve: () => true,
      launchctlExecutor: {
        bootout: () => calls.push("bootout"),
        bootstrap: () => calls.push("bootstrap"),
      },
    },
  });
  assert.equal(calls.length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("launchagent install is idempotent with test double", () => {
  const dir = mkdtempSync(join(tmpdir(), "gc-la-"));
  execFileSync("cp", ["-R", join(repoRoot, "launchd"), join(dir, "launchd")]);
  execFileSync("cp", ["-R", join(repoRoot, "scripts"), join(dir, "scripts")]);
  execFileSync("bash", [join(dir, "scripts/prepare-yg3-launchagent.sh")], { cwd: dir });
  const agentDir = join(dir, "agents");
  const exec = {
    getuid: () => 1,
    bootout: () => {},
    bootstrap: () => ({ ok: true }),
  };
  const a = installYg3SyncLaunchAgent({ root: dir, launchAgentsDir: agentDir, executor: exec });
  const b = installYg3SyncLaunchAgent({ root: dir, launchAgentsDir: agentDir, executor: exec });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  const u = uninstallYg3SyncLaunchAgent({ root: dir, launchAgentsDir: agentDir, executor: exec });
  assert.equal(u.ok, true);
  rmSync(dir, { recursive: true, force: true });
});

test("prepare script renders plist without owner home paths", () => {
  if (!isMacOsPlatform()) return;
  const dir = mkdtempSync(join(tmpdir(), "gc-setup-mac-"));
  execFileSync("cp", ["-R", join(repoRoot, "scripts"), join(dir, "scripts")]);
  execFileSync("cp", ["-R", join(repoRoot, "launchd"), join(dir, "launchd")]);
  execFileSync("bash", [join(dir, "scripts/prepare-yg3-launchagent.sh")], { cwd: dir });
  assert.ok(renderedYg3PlistPresent(dir));
  const xml = readFileSync(
    join(dir, "launchd/rendered/com.groundcontrol.yg3-sync.plist"),
    "utf8",
  );
  assert.ok(!xml.includes("/Users/"));
  rmSync(dir, { recursive: true, force: true });
});

function seedMinimalRepo(dir) {
  execFileSync("mkdir", ["-p", join(dir, "data/relay"), join(dir, "node_modules"), join(dir, "packages/relay/dist"), join(dir, "scripts")]);
  writeFileSync(join(dir, "package.json"), '{"name":"t","scripts":{}}');
  writeFileSync(join(dir, "packages/relay/dist/cli.js"), "// stub\n");
  writeFileSync(
    join(dir, "scripts/bootstrap.sh"),
    "#!/usr/bin/env bash\nexit 0\n",
  );
  execFileSync("chmod", ["+x", join(dir, "scripts/bootstrap.sh")]);
  execFileSync("cp", ["-R", join(repoRoot, "launchd"), join(dir, "launchd")]);
  execFileSync("cp", ["-R", join(repoRoot, "scripts/setup-mac-launchagent.mjs"), join(dir, "scripts/")]);
  execFileSync("cp", [join(repoRoot, "scripts/prepare-yg3-launchagent.sh"), join(dir, "scripts/")]);
  execFileSync("cp", [join(repoRoot, "scripts/render-launchd-plist.sh"), join(dir, "scripts/")]);
  execFileSync("cp", [join(repoRoot, "scripts/run-yg3-sync.sh"), join(dir, "scripts/")]);
  execFileSync("chmod", ["+x", join(dir, "scripts/prepare-yg3-launchagent.sh"), join(dir, "scripts/render-launchd-plist.sh"), join(dir, "scripts/run-yg3-sync.sh")]);
}
