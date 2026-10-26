import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  installYg3SyncLaunchAgent,
  launchAgentInstalled,
  plistMatchesRendered,
} from "./setup-mac-launchagent.mjs";

export function isMacOsPlatform() {
  return process.platform === "darwin";
}

export function printSetupHelp() {
  const text = `Ground Control — macOS first-run setup

Usage:
  npm run setup:mac [options]

Options:
  --help, -h              Show this help (no setup, no writes)
  --dry-run               Print planned steps only
  --non-interactive       Fail instead of prompting (CI / automation)
  --brain-root PATH       Set BRAIN_ROOT in .env when missing
  --test-root PATH        Use an isolated root (never touches ~/Library/LaunchAgents)

What it does (idempotent):
  • Ensures dependencies and build (bootstrap when needed)
  • Creates .env / config.yaml from examples when missing
  • Connects YG3 once (interactive OAuth) when Keychain has no valid token
  • Resolves or guides client workspace selection
  • Offers daily background YG3 sync (LaunchAgent) — only if you confirm

Reconnect YG3 only if access is revoked or tokens are invalid.

Rollback background sync only:
  npm run setup:mac:uninstall-yg3-sync

Advanced relay/worker services: see docs/OPERATOR_GUIDE.md
`;
  process.stdout.write(text);
}

export function parseSetupCliArgs(argv) {
  const args = argv ?? process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    return { action: "help" };
  }
  let brainRoot = process.env.GROUND_CONTROL_BRAIN_ROOT || "";
  let testRoot = process.env.GROUND_CONTROL_SETUP_ROOT?.trim() || "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--brain-root" && args[i + 1]) brainRoot = args[i + 1];
    if (args[i] === "--test-root" && args[i + 1]) testRoot = args[i + 1];
  }
  return {
    action: "run",
    dryRun: args.includes("--dry-run"),
    nonInteractive: args.includes("--non-interactive"),
    brainRoot,
    testRoot,
  };
}

export function parseEnvFile(path) {
  if (!existsSync(path)) return new Map();
  const map = new Map();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 1) continue;
    map.set(t.slice(0, i), t.slice(i + 1));
  }
  return map;
}

export function yg3EnabledFromEnv(env) {
  const v = (env.get("YG3_MCP_ENABLED") || "").trim().toLowerCase();
  return v === "1" || v === "true";
}

export function defaultKeychainTokensPresent() {
  if (!isMacOsPlatform()) return false;
  const r = spawnSync(
    "security",
    [
      "find-generic-password",
      "-s",
      "ground-control-yg3-mcp",
      "-a",
      "oauth-tokens",
    ],
    { stdio: "ignore" },
  );
  return r.status === 0;
}

export function brainRootConfigured(env) {
  const root = (env.get("BRAIN_ROOT") || "").trim();
  return Boolean(root && existsSync(root));
}

export function workspaceSelectionPresent(root, env) {
  const relayData = (env.get("RELAY_DATA_DIR") || "./data/relay").trim();
  const base = relayData.startsWith("/")
    ? relayData
    : join(root, relayData);
  return existsSync(join(base, "yg3", "workspace-selection.json"));
}

export function renderedYg3PlistPresent(root) {
  return existsSync(
    join(root, "launchd", "rendered", "com.groundcontrol.yg3-sync.plist"),
  );
}

export function projectArtifactsReady(root) {
  return (
    existsSync(join(root, "node_modules")) &&
    existsSync(join(root, "packages/relay/dist/cli.js"))
  );
}

export function runBootstrapDirs(root) {
  const r = spawnSync(
    "bash",
    [join(root, "scripts", "bootstrap.sh"), "--only-dirs"],
    {
      cwd: root,
      env: { ...process.env, GROUND_CONTROL_BOOTSTRAP_ROOT: root },
      encoding: "utf8",
    },
  );
  return r.status === 0;
}

export function runFullBootstrap(root) {
  const r = spawnSync("bash", [join(root, "scripts", "bootstrap.sh")], {
    cwd: root,
    env: { ...process.env, GROUND_CONTROL_BOOTSTRAP_ROOT: root },
    encoding: "utf8",
  });
  return r.status === 0;
}

export function runRelayBuild(root) {
  const r = spawnSync("npm", ["run", "build", "-w", "@agent-control/relay"], {
    cwd: root,
    encoding: "utf8",
  });
  return r.status === 0;
}

export function renderYg3LaunchAgent(root) {
  const script = join(root, "scripts", "prepare-yg3-launchagent.sh");
  const r = spawnSync("bash", [script], { cwd: root, encoding: "utf8" });
  return { ok: r.status === 0, detail: r.status === 0 ? "rendered" : "render_failed" };
}

export function ensureConfigFromExamples(root, dryRun) {
  const created = [];
  const envEx = join(root, ".env.example");
  const envPath = join(root, ".env");
  const cfgEx = join(root, "config.example.yaml");
  const cfgPath = join(root, "config.yaml");
  if (!existsSync(envPath) && existsSync(envEx)) {
    if (!dryRun) writeFileSync(envPath, readFileSync(envEx, "utf8"), "utf8");
    created.push(".env");
  }
  if (!existsSync(cfgPath) && existsSync(cfgEx)) {
    if (!dryRun) writeFileSync(cfgPath, readFileSync(cfgEx, "utf8"), "utf8");
    created.push("config.yaml");
  }
  return created;
}

export function ensureYg3EnabledInEnv(root, dryRun) {
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) return { ok: false, detail: "missing_env" };
  const cur = readFileSync(envPath, "utf8");
  if (/YG3_MCP_ENABLED=1/m.test(cur)) return { ok: true, detail: "already_enabled" };
  if (dryRun) return { ok: true, detail: "would_enable" };
  writeFileSync(envPath, cur.trimEnd() + "\nYG3_MCP_ENABLED=1\n", "utf8");
  return { ok: true, detail: "enabled" };
}

export function ensureBrainRootInEnv(root, brainRoot, dryRun) {
  const envPath = join(root, ".env");
  const env = parseEnvFile(envPath);
  if (brainRootConfigured(env)) return { ok: true, action: "already_set" };
  if (!brainRoot) return { ok: false, action: "missing_brain_root" };
  if (dryRun) return { ok: true, action: "would_set_brain_root" };
  const line = `BRAIN_ROOT=${brainRoot}\n`;
  if (!existsSync(envPath)) {
    writeFileSync(envPath, line, "utf8");
  } else {
    writeFileSync(envPath, readFileSync(envPath, "utf8").trimEnd() + "\n" + line, "utf8");
  }
  return { ok: true, action: "set_brain_root" };
}

function defaultRunYg3Login(root) {
  const r = spawnSync("npm", ["run", "yg3:login"], {
    cwd: root,
    stdio: "inherit",
    encoding: "utf8",
  });
  return r.status === 0;
}

function defaultRunWorkspaceResolve(root) {
  const r = spawnSync(
    "node",
    ["--import", "tsx", join(root, "packages/relay/src/yg3-mcp/setup-workspace-cli.ts")],
    { cwd: root, encoding: "utf8" },
  );
  return r.status === 0;
}

function defaultRunWorkspaceSearch(root, query) {
  const r = spawnSync(
    "node",
    [
      "--import",
      "tsx",
      join(root, "packages/relay/src/yg3-mcp/workspaces-search-cli.ts"),
      query,
    ],
    { cwd: root, encoding: "utf8" },
  );
  return { ok: r.status === 0, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function defaultRunWorkspaceSelectRef(root, ref) {
  const r = spawnSync(
    "node",
    [
      "--import",
      "tsx",
      join(root, "packages/relay/src/yg3-mcp/workspace-select-cli.ts"),
      "--ref",
      String(ref),
    ],
    { cwd: root, encoding: "utf8" },
  );
  return r.status === 0;
}

export function resolveLaunchAgentsDir(root, testRootMode) {
  if (testRootMode) {
    return join(root, "Library", "LaunchAgents");
  }
  if (process.env.GROUND_CONTROL_LAUNCH_AGENTS_DIR?.trim()) {
    return process.env.GROUND_CONTROL_LAUNCH_AGENTS_DIR.trim();
  }
  return join(process.env.HOME || "", "Library", "LaunchAgents");
}

/** Interactive guided setup may offer background sync (not dry-run / not non-interactive). */
export function canOfferBackgroundSync(opts) {
  return !opts.dryRun && !opts.nonInteractive && isMacOsPlatform();
}

/** Real owner ~/Library/LaunchAgents — never in dry-run, non-interactive, or test-root. */
export function canTouchLiveLaunchAgents(opts) {
  return canOfferBackgroundSync(opts) && !opts.testRootMode;
}

function resolveLaunchctlExecutor(opts, deps) {
  if (opts.testRootMode) {
    return (
      deps.launchctlExecutor ?? {
        getuid: () => 502,
        bootout: () => {},
        bootstrap: () => ({ ok: true }),
      }
    );
  }
  return deps.launchctlExecutor;
}

/**
 * @param {object} opts
 * @param {string} opts.root
 * @param {boolean} [opts.dryRun]
 * @param {boolean} [opts.nonInteractive]
 * @param {string} [opts.brainRoot]
 * @param {boolean} [opts.testRootMode]
 * @param {object} [opts.deps]
 */
export async function runMacSetup(opts) {
  const root = opts.root;
  const dryRun = Boolean(opts.dryRun);
  const nonInteractive = Boolean(opts.nonInteractive);
  const testRootMode = Boolean(opts.testRootMode);
  const deps = opts.deps ?? {};
  const keychain = deps.keychainTokensPresent ?? defaultKeychainTokensPresent;
  const runYg3Login = deps.runYg3Login ?? defaultRunYg3Login;
  const runWorkspaceResolve = deps.runWorkspaceResolve ?? defaultRunWorkspaceResolve;
  const runWorkspaceSearch = deps.runWorkspaceSearch ?? defaultRunWorkspaceSearch;
  const runWorkspaceSelectRef = deps.runWorkspaceSelectRef ?? defaultRunWorkspaceSelectRef;
  const promptYesNo =
    deps.promptYesNo ??
    (async (_q, def) => (nonInteractive ? def : def));
  const promptLine = deps.promptLine ?? (async () => "");
  const steps = [];

  if (!isMacOsPlatform()) {
    return { ok: false, blocked: true, blocker: "unsupported_os", steps };
  }
  steps.push({ id: "platform", status: "pass", detail: "darwin" });

  if (dryRun) {
    steps.push({ id: "bootstrap", status: "pass", detail: "skipped_dry_run" });
  } else if (projectArtifactsReady(root)) {
    steps.push({ id: "bootstrap", status: "pass", detail: "already_ready" });
    if (!runBootstrapDirs(root)) {
      return { ok: false, blocked: true, blocker: "bootstrap_dirs_failed", steps };
    }
  } else {
    if (!runFullBootstrap(root)) {
      return { ok: false, blocked: true, blocker: "bootstrap_failed", steps };
    }
    steps.push({ id: "bootstrap", status: "pass", detail: "full_bootstrap" });
    if (!projectArtifactsReady(root) && !runRelayBuild(root)) {
      return { ok: false, blocked: true, blocker: "build_failed", steps };
    }
  }

  const created = ensureConfigFromExamples(root, dryRun);
  steps.push({
    id: "config_files",
    status: "pass",
    detail: created.length ? `created_${created.join("_")}` : "present",
  });

  const yg3On = ensureYg3EnabledInEnv(root, dryRun);
  steps.push({
    id: "yg3_enabled",
    status: yg3On.ok ? "pass" : "fail",
    detail: yg3On.detail,
  });
  if (!yg3On.ok) {
    return { ok: false, blocked: true, blocker: "yg3_enable_failed", steps };
  }

  let tokens = keychain();
  steps.push({
    id: "yg3_credential",
    status: tokens ? "pass" : "warn",
    detail: tokens ? "keychain_present" : "missing",
  });

  if (!tokens && !dryRun) {
    if (nonInteractive) {
      return { ok: false, blocked: true, blocker: "oauth_required", steps };
    }
    const connect = await promptYesNo(
      "Connect YG3 now? This opens a one-time browser sign-in. (Y/n) ",
      true,
    );
    if (!connect) {
      return { ok: false, blocked: true, blocker: "oauth_declined", steps };
    }
    steps.push({ id: "yg3_login", status: "pass", detail: "starting_oauth" });
    if (!runYg3Login(root)) {
      return { ok: false, blocked: true, blocker: "oauth_failed", steps };
    }
    tokens = keychain();
    if (!tokens) {
      return { ok: false, blocked: true, blocker: "oauth_no_token", steps };
    }
    steps.push({ id: "yg3_credential", status: "pass", detail: "keychain_present" });
  }

  let brainRoot = opts.brainRoot;
  if (!brainRoot && !nonInteractive && !dryRun) {
    const env = parseEnvFile(join(root, ".env"));
    if (!brainRootConfigured(env)) {
      const entered = await promptLine(
        "Second Brain folder path (Markdown vault root, Enter to skip for now): ",
      );
      if (entered.trim()) brainRoot = entered.trim();
    }
  }
  const brain = ensureBrainRootInEnv(root, brainRoot, dryRun);
  steps.push({
    id: "second_brain",
    status: brain.ok ? "pass" : "warn",
    detail: brain.action,
  });

  if (!dryRun && tokens) {
    let wsOk = runWorkspaceResolve(root);
    if (!wsOk && !nonInteractive) {
      steps.push({ id: "workspace_selection", status: "warn", detail: "guided_search" });
      const query = await promptLine(
        "Search for your client workspace (name or slug): ",
      );
      if (query.trim()) {
        runWorkspaceSearch(root, query.trim());
        const refStr = await promptLine(
          "Enter the ref number for your client row from the search results: ",
        );
        const ref = Number.parseInt(refStr, 10);
        if (Number.isFinite(ref) && ref > 0) {
          wsOk = runWorkspaceSelectRef(root, ref);
        }
      }
    }
    steps.push({
      id: "workspace_selection",
      status: wsOk ? "pass" : "warn",
      detail: wsOk ? "resolved" : "selection_required",
    });
    if (!wsOk && nonInteractive) {
      return { ok: false, blocked: true, blocker: "workspace_selection_required", steps };
    }
    if (!wsOk && !nonInteractive) {
      return { ok: false, blocked: true, blocker: "workspace_selection_required", steps };
    }
  } else {
    steps.push({
      id: "workspace_selection",
      status: "warn",
      detail: dryRun ? "skipped_dry_run" : "awaiting_credential",
    });
  }

  const render = dryRun
    ? { ok: true, detail: "would_render_plist" }
    : renderYg3LaunchAgent(root);
  steps.push({
    id: "yg3_launchagent_template",
    status: render.ok ? "pass" : "fail",
    detail: render.detail,
  });
  if (!render.ok) {
    return { ok: false, blocked: true, blocker: "launchagent_render_failed", steps };
  }

  const launchAgentsDir = resolveLaunchAgentsDir(root, testRootMode);
  let backgroundDetail = "not_offered";
  if (canOfferBackgroundSync(opts) && tokens) {
    const installBg = await promptYesNo(
      "Keep Ground Control synced automatically in the background? (Y/n) ",
      true,
    );
    if (installBg) {
      const install = installYg3SyncLaunchAgent({
        root,
        launchAgentsDir,
        dryRun: false,
        executor: resolveLaunchctlExecutor(opts, deps),
      });
      backgroundDetail = install.ok ? install.detail : install.detail;
      steps.push({
        id: "yg3_background_sync",
        status: install.ok ? "pass" : "fail",
        detail: backgroundDetail,
      });
      if (!install.ok) {
        return { ok: false, blocked: true, blocker: "background_install_failed", steps };
      }
    } else {
      backgroundDetail = "declined";
      steps.push({ id: "yg3_background_sync", status: "warn", detail: "declined" });
    }
  } else if (dryRun) {
    backgroundDetail = "would_prompt";
    steps.push({ id: "yg3_background_sync", status: "pass", detail: backgroundDetail });
  } else if (nonInteractive) {
    backgroundDetail = "skipped_non_interactive";
    steps.push({ id: "yg3_background_sync", status: "warn", detail: backgroundDetail });
  }

  if (!dryRun) {
    mkdirSync(join(root, "logs"), { recursive: true });
  }

  return {
    ok: true,
    blocked: false,
    blocker: "none",
    steps,
    backgroundDetail,
    launchAgentInstalled: launchAgentInstalled(launchAgentsDir),
    plistUpToDate: plistMatchesRendered(root, launchAgentsDir),
  };
}
