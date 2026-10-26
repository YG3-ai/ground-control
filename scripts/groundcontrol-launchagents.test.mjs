import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  agentLabel,
  assessIndependentRemoteRecovery,
  renderAllGroundControlLaunchAgents,
  stageGroundControlLaunchAgents,
  GROUND_CONTROL_AGENT_NAMES,
} from "./groundcontrol-launchagents.mjs";

const repoRoot = join(import.meta.dirname, "..");

test("renders relay ngrok and worker plists idempotently", () => {
  const dir = mkdtempSync(join(tmpdir(), "gc-la-render-"));
  execFileSync("mkdir", ["-p", join(dir, "scripts")]);
  execFileSync("cp", ["-R", join(repoRoot, "launchd"), join(dir, "launchd")]);
  execFileSync("cp", [join(repoRoot, "scripts/render-launchd-plist.sh"), join(dir, "scripts/")]);
  execFileSync("chmod", ["+x", join(dir, "scripts/render-launchd-plist.sh")]);
  const agents = join(dir, "LaunchAgents");
  const a = renderAllGroundControlLaunchAgents({ root: dir, launchAgentsDir: agents });
  const b = renderAllGroundControlLaunchAgents({ root: dir, launchAgentsDir: agents });
  assert.equal(a.length, 3);
  assert.equal(b.length, 3);
  for (const name of GROUND_CONTROL_AGENT_NAMES) {
    const label = agentLabel(name);
    const path = join(agents, `${label}.plist`);
    assert.ok(existsSync(path));
    const xml = readFileSync(path, "utf8");
    assert.ok(xml.includes("<key>KeepAlive</key>"));
    assert.ok(!xml.includes("__GROUND_CONTROL_ROOT__"));
  }
  rmSync(dir, { recursive: true, force: true });
});

test("stage bootstraps only missing agents without disruptive kickstart", () => {
  const dir = mkdtempSync(join(tmpdir(), "gc-la-stage-"));
  execFileSync("mkdir", ["-p", join(dir, "scripts")]);
  execFileSync("cp", ["-R", join(repoRoot, "launchd"), join(dir, "launchd")]);
  execFileSync("cp", [join(repoRoot, "scripts/render-launchd-plist.sh"), join(dir, "scripts/")]);
  execFileSync("chmod", ["+x", join(dir, "scripts/render-launchd-plist.sh")]);
  const agents = join(dir, "LaunchAgents");
  const loaded = new Set(["com.groundcontrol.relay", "com.groundcontrol.ngrok"]);
  const calls = [];
  const executor = {
    print(target) {
      const label = target.split("/").pop();
      return { ok: loaded.has(label) };
    },
    bootout(d, l) {
      calls.push(`bootout:${d}/${l}`);
    },
    bootstrap(d, p) {
      calls.push(`bootstrap:${d}:${p}`);
      loaded.add(p.split("/").pop().replace(".plist", ""));
      return { ok: true };
    },
    enable(fq) {
      calls.push(`enable:${fq}`);
    },
    kickstart(fq) {
      calls.push(`kickstart:${fq}`);
      return true;
    },
  };
  const r = stageGroundControlLaunchAgents({
    root: dir,
    launchAgentsDir: agents,
    executor,
    domain: "gui/501",
    bootstrapMissing: true,
    kickstartLabels: [],
  });
  assert.deepEqual(r.bootstrapped, ["worker"]);
  assert.ok(!calls.some((c) => c.startsWith("kickstart:")));
  rmSync(dir, { recursive: true, force: true });
});

test("recovery assessment records remote shell blocker", () => {
  const dir = mkdtempSync(join(tmpdir(), "gc-la-assess-"));
  const agents = join(dir, "LaunchAgents");
  const assessment = assessIndependentRemoteRecovery({
    launchAgentsDir: agents,
    executor: { print: () => ({ ok: false }) },
    domain: "gui/501",
  });
  assert.equal(assessment.automaticCrashRecoveryReady, false);
  assert.ok(
    assessment.independentRemoteRecoveryBlocked.some((b) => b.includes("no_bundled_remote_shell")),
  );
  rmSync(dir, { recursive: true, force: true });
});
