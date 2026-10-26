#!/usr/bin/env node
/**
 * Render and stage Ground Control relay/ngrok/worker LaunchAgents idempotently.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const GROUND_CONTROL_AGENT_NAMES = ["relay", "ngrok", "worker"];

export function agentLabel(name) {
  return `com.groundcontrol.${name}`;
}

export function defaultLaunchAgentsDir(home = process.env.HOME) {
  if (!home) throw new Error("HOME is required to resolve LaunchAgents directory");
  return join(home, "Library", "LaunchAgents");
}

export function launchctlGuiDomain(uid = process.getuid?.() ?? 501) {
  return `gui/${uid}`;
}

export function renderLaunchAgentPlist(root, label) {
  return execFileSync("bash", [join(root, "scripts/render-launchd-plist.sh"), label], {
    encoding: "utf8",
  });
}

export function renderAllGroundControlLaunchAgents({ root, launchAgentsDir }) {
  mkdirSync(launchAgentsDir, { recursive: true });
  const written = [];
  for (const name of GROUND_CONTROL_AGENT_NAMES) {
    const label = agentLabel(name);
    const dst = join(launchAgentsDir, `${label}.plist`);
    const xml = renderLaunchAgentPlist(root, label);
    writeFileSync(dst, xml, "utf8");
    written.push({ name, label, path: dst });
  }
  return written;
}

export function launchAgentLoaded(executor, domain, label) {
  const r = executor.print(`${domain}/${label}`);
  return Boolean(r?.ok);
}

export function stageGroundControlLaunchAgents({
  root,
  launchAgentsDir,
  executor,
  domain,
  bootstrapMissing = true,
  kickstartLabels = [],
}) {
  const rendered = renderAllGroundControlLaunchAgents({ root, launchAgentsDir });
  const bootstrapped = [];
  const kickstarted = [];

  for (const { name, label, path } of rendered) {
    const fq = `${domain}/${label}`;
    const loaded = launchAgentLoaded(executor, domain, label);
    if (!loaded && bootstrapMissing) {
      executor.bootout?.(domain, label);
      const b = executor.bootstrap(domain, path);
      if (b?.ok !== false) bootstrapped.push(name);
      executor.enable?.(fq);
    }
    if (kickstartLabels.includes(name) || kickstartLabels.includes(label)) {
      if (executor.kickstart(fq)) kickstarted.push(name);
    }
  }

  return { rendered, bootstrapped, kickstarted };
}

export function missingGroundControlPlists(launchAgentsDir) {
  return GROUND_CONTROL_AGENT_NAMES.filter((name) => {
    const label = agentLabel(name);
    return !existsSync(join(launchAgentsDir, `${label}.plist`));
  });
}

export function assessIndependentRemoteRecovery({ launchAgentsDir, executor, domain }) {
  const agents = GROUND_CONTROL_AGENT_NAMES.map((name) => {
    const label = agentLabel(name);
    const plist = join(launchAgentsDir, `${label}.plist`);
    const plistPresent = existsSync(plist);
    const loaded = plistPresent && launchAgentLoaded(executor, domain, label);
    let keepAlive = false;
    if (plistPresent) {
      try {
        const xml = readFileSync(plist, "utf8");
        keepAlive = xml.includes("<key>KeepAlive</key>") && xml.includes("<true/>");
      } catch {
        keepAlive = false;
      }
    }
    return { name, label, plistPresent, loaded, keepAlive };
  });

  const blockers = [];
  if (agents.some((a) => !a.plistPresent)) {
    blockers.push("missing_launchagent_plist");
  }
  if (agents.some((a) => a.plistPresent && !a.loaded)) {
    blockers.push("launchagent_not_loaded");
  }
  if (agents.some((a) => a.plistPresent && !a.keepAlive)) {
    blockers.push("keepalive_not_configured");
  }
  blockers.push(
    "no_bundled_remote_shell: independent recovery requires login access to this Mac or an already-working HTTPS tunnel to the relay; Ground Control does not open SSH or publish operator credentials.",
  );

  return {
    agents,
    automaticCrashRecoveryReady: agents.every((a) => a.plistPresent && a.keepAlive),
    independentRemoteRecoveryBlocked: blockers,
  };
}

export function defaultLaunchctlExecutor() {
  return {
    print(target) {
      try {
        execFileSync("launchctl", ["print", target], { stdio: "pipe" });
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },
    bootout(domain, label) {
      try {
        execFileSync("launchctl", ["bootout", `${domain}/${label}`], { stdio: "ignore" });
      } catch {
        /* ignore */
      }
    },
    bootstrap(domain, plistPath) {
      try {
        execFileSync("launchctl", ["bootstrap", domain, plistPath], { stdio: "pipe" });
        return { ok: true };
      } catch (err) {
        return { ok: false, err };
      }
    },
    enable(fq) {
      try {
        execFileSync("launchctl", ["enable", fq], { stdio: "ignore" });
      } catch {
        /* ignore */
      }
    },
    kickstart(fq) {
      try {
        execFileSync("launchctl", ["kickstart", fq], { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    },
  };
}

function parseArgs(argv) {
  const out = {
    stage: false,
    assessRecovery: false,
    root: join(fileURLToPath(new URL(".", import.meta.url)), ".."),
    launchAgentsDir: defaultLaunchAgentsDir(),
    domain: launchctlGuiDomain(),
    bootstrapMissing: true,
    kickstartLabels: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--stage") out.stage = true;
    else if (a === "--assess-recovery") out.assessRecovery = true;
    else if (a === "--bootstrap-missing") out.bootstrapMissing = true;
    else if (a === "--root") out.root = argv[++i];
    else if (a === "--launch-agents-dir") out.launchAgentsDir = argv[++i];
    else if (a === "--domain") out.domain = argv[++i];
    else if (a === "--kickstart") out.kickstartLabels = argv[++i].split(",").filter(Boolean);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const executor = defaultLaunchctlExecutor();

  if (args.assessRecovery) {
    const assessment = assessIndependentRemoteRecovery({
      launchAgentsDir: args.launchAgentsDir,
      executor,
      domain: args.domain,
    });
    console.log(JSON.stringify(assessment, null, 2));
    return;
  }

  if (args.stage) {
    const result = stageGroundControlLaunchAgents({
      root: args.root,
      launchAgentsDir: args.launchAgentsDir,
      executor,
      domain: args.domain,
      bootstrapMissing: args.bootstrapMissing,
      kickstartLabels: args.kickstartLabels,
    });
    console.log(
      JSON.stringify({
        ok: true,
        rendered: result.rendered.map((r) => r.label),
        bootstrapped: result.bootstrapped,
        kickstarted: result.kickstarted,
      }),
    );
    return;
  }

  console.error("usage: groundcontrol-launchagents.mjs --stage|--assess-recovery");
  process.exit(2);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
