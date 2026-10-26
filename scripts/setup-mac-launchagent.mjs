import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export const YG3_SYNC_LAUNCH_LABEL = "com.groundcontrol.yg3-sync";

export function yg3SyncPlistSource(root) {
  return join(root, "launchd", "rendered", `${YG3_SYNC_LAUNCH_LABEL}.plist`);
}

export function yg3SyncPlistDest(launchAgentsDir) {
  return join(launchAgentsDir, `${YG3_SYNC_LAUNCH_LABEL}.plist`);
}

export function launchctlGuiDomain(uid) {
  return `gui/${uid}`;
}

/**
 * @param {object} opts
 * @param {string} opts.root
 * @param {string} opts.launchAgentsDir
 * @param {boolean} [opts.dryRun]
 * @param {{ bootout?: Function, bootstrap?: Function, getuid?: Function }} [opts.executor]
 */
export function installYg3SyncLaunchAgent(opts) {
  const src = yg3SyncPlistSource(opts.root);
  if (!existsSync(src)) {
    return { ok: false, detail: "plist_not_rendered" };
  }
  const dst = yg3SyncPlistDest(opts.launchAgentsDir);
  if (opts.dryRun) {
    return { ok: true, detail: "would_install", dest: dst };
  }
  mkdirSync(opts.launchAgentsDir, { recursive: true });
  copyFileSync(src, dst);
  try {
    chmodSync(dst, statSync(src).mode & 0o777);
  } catch {
    /* ignore */
  }
  const uid = opts.executor?.getuid?.() ?? process.getuid?.() ?? 0;
  const domain = launchctlGuiDomain(uid);
  const bootout = opts.executor?.bootout ?? defaultBootout;
  const bootstrap = opts.executor?.bootstrap ?? defaultBootstrap;
  bootout(domain, YG3_SYNC_LAUNCH_LABEL);
  const boot = bootstrap(domain, dst);
  if (!boot.ok) return { ok: false, detail: boot.detail ?? "bootstrap_failed" };
  return { ok: true, detail: "installed", dest: dst };
}

export function uninstallYg3SyncLaunchAgent(opts) {
  const dst = yg3SyncPlistDest(opts.launchAgentsDir);
  const uid = opts.executor?.getuid?.() ?? process.getuid?.() ?? 0;
  const domain = launchctlGuiDomain(uid);
  const bootout = opts.executor?.bootout ?? defaultBootout;
  if (!opts.dryRun) {
    bootout(domain, YG3_SYNC_LAUNCH_LABEL);
    try {
      if (existsSync(dst)) rmSync(dst);
    } catch {
      /* ignore */
    }
  }
  return { ok: true, detail: opts.dryRun ? "would_uninstall" : "uninstalled" };
}

function defaultBootout(domain, label) {
  spawnSync("launchctl", ["bootout", `${domain}/${label}`], { stdio: "ignore" });
}

function defaultBootstrap(domain, plistPath) {
  const r = spawnSync("launchctl", ["bootstrap", domain, plistPath], {
    encoding: "utf8",
  });
  return { ok: r.status === 0, detail: r.status === 0 ? "ok" : "bootstrap_failed" };
}

export function launchAgentInstalled(launchAgentsDir) {
  return existsSync(yg3SyncPlistDest(launchAgentsDir));
}

export function plistMatchesRendered(root, launchAgentsDir) {
  const src = yg3SyncPlistSource(root);
  const dst = yg3SyncPlistDest(launchAgentsDir);
  if (!existsSync(src) || !existsSync(dst)) return false;
  try {
    return readFileSync(src, "utf8") === readFileSync(dst, "utf8");
  } catch {
    return false;
  }
}
