import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createRequire } from "node:module";
import { parseLocalEnvFile } from "./load-local-env.mjs";
import {
  isMacOsPlatform,
  renderedYg3PlistPresent,
  workspaceSelectionPresent,
} from "./setup-mac-lib.mjs";

const require = createRequire(import.meta.url);

export const REQUIRED_ENV_KEYS = [
  "WORKER_TOKEN",
  "RELAY_JWT_SECRET",
  "OWNER_APPROVAL_SECRET",
];

export const PLACEHOLDER_PATTERNS = [
  /^replace-with/i,
  /^your[-_]/i,
  /example\.com/i,
  /min-\d+-chars/i,
];

export function parseEnvString(raw) {
  const keys = new Map();
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    const value = t.slice(eq + 1).trim();
    keys.set(key, value);
  }
  return keys;
}

export function parseEnvKeys(envPath) {
  if (!existsSync(envPath)) return null;
  const parsed = parseLocalEnvFile(dirname(envPath), basename(envPath));
  if (parsed) {
    return new Map(Object.entries(parsed));
  }
  return parseEnvString(readFileSync(envPath, "utf8"));
}

export function isPlaceholderValue(value) {
  if (value === undefined || value === "") return true;
  return PLACEHOLDER_PATTERNS.some((re) => re.test(value));
}

export function resolveWorkRootFromKeys(keys) {
  if (!keys) return null;
  const gc = keys.get("GROUND_CONTROL_WORK_ROOT")?.trim();
  const legacy = keys.get("PARTHA_WORK_ROOT")?.trim();
  const v = gc || legacy;
  return v ? v.replace(/\/$/, "") : null;
}

export function brainKeysFromMap(keys) {
  if (!keys) return {};
  return {
    BRAIN_ROOT: keys.get("BRAIN_ROOT")?.trim() || "",
    BRAIN_VAULT: keys.get("BRAIN_VAULT")?.trim() || "",
    BRAIN_PYTHON: keys.get("BRAIN_PYTHON")?.trim() || "",
    BRAIN_SCRIPT: keys.get("BRAIN_SCRIPT")?.trim() || "",
  };
}

export function runDoctor(options) {
  const {
    root,
    envPath = join(root, ".env"),
    configPath = join(root, "config.yaml"),
    relayHealthUrl = null,
    skipNative = false,
  } = options;

  const checks = [];

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({
    id: "node_version",
    status: nodeMajor >= 20 ? "pass" : "fail",
    severity: "blocker",
    detail: `node ${process.versions.node}`,
  });

  if (!skipNative) {
    try {
      require.resolve("better-sqlite3", { paths: [join(root, "packages/worker")] });
      require("better-sqlite3");
      checks.push({
        id: "better_sqlite3",
        status: "pass",
        severity: "blocker",
        detail: "native module loads",
      });
    } catch {
      checks.push({
        id: "better_sqlite3",
        status: "fail",
        severity: "blocker",
        detail: "native module failed to load",
      });
    }
  }

  const envExists = existsSync(envPath);
  checks.push({
    id: "env_file",
    status: envExists ? "pass" : "fail",
    severity: "blocker",
    detail: envExists ? "present" : "missing",
  });

  const configExists = existsSync(configPath);
  checks.push({
    id: "config_yaml",
    status: configExists ? "pass" : "fail",
    severity: "blocker",
    detail: configExists ? "present" : "missing",
  });

  const keys = parseEnvKeys(envPath);
  for (const req of REQUIRED_ENV_KEYS) {
    const val = keys?.get(req);
    const ok = val && !isPlaceholderValue(val);
    let minOk = ok;
    if (ok && req === "WORKER_TOKEN" && val.length < 24) minOk = false;
    if (ok && req === "RELAY_JWT_SECRET" && val.length < 32) minOk = false;
    if (ok && req === "OWNER_APPROVAL_SECRET" && val.length < 4) minOk = false;
    checks.push({
      id: `env_${req.toLowerCase()}`,
      status: minOk ? "pass" : "fail",
      severity: "blocker",
      detail: minOk ? "set" : val ? "placeholder_or_short" : "missing",
    });
  }

  const pub = keys?.get("PUBLIC_BASE_URL")?.trim() || "";
  const localPub =
    pub.includes("127.0.0.1") || pub.startsWith("http://localhost");
  if (pub && isPlaceholderValue(pub)) {
    checks.push({
      id: "env_public_base_url",
      status: "fail",
      severity: "blocker",
      detail: "placeholder",
    });
  } else if (pub && !localPub) {
    checks.push({
      id: "env_public_base_url",
      status: "pass",
      severity: "info",
      detail: "public_https_configured",
    });
    const hasNgrok = pub.includes("ngrok");
    const cfConfig = join(process.env.HOME || "", ".cloudflared/config.yml");
    if (hasNgrok) {
      checks.push({
        id: "tunnel_ngrok_cli",
        status: commandExists("ngrok") ? "pass" : "warn",
        severity: "warn",
        detail: commandExists("ngrok") ? "cli_found" : "cli_missing",
      });
    } else {
      checks.push({
        id: "tunnel_cloudflared_config",
        status: existsSync(cfConfig) ? "pass" : "warn",
        severity: "warn",
        detail: existsSync(cfConfig) ? "config_present" : "config_missing",
      });
      checks.push({
        id: "tunnel_cloudflared_cli",
        status: commandExists("cloudflared") ? "pass" : "warn",
        severity: "warn",
        detail: commandExists("cloudflared") ? "cli_found" : "cli_missing",
      });
    }
  } else {
    checks.push({
      id: "env_public_base_url",
      status: pub ? "pass" : "warn",
      severity: pub ? "info" : "warn",
      detail: pub ? "local" : "unset",
    });
  }

  const workRoot = resolveWorkRootFromKeys(keys);
  if (workRoot) {
    checks.push({
      id: "ground_control_work_root",
      status: existsSync(workRoot) ? "pass" : "warn",
      severity: "warn",
      detail: existsSync(workRoot) ? "path_exists" : "path_missing",
    });
    if (keys?.has("PARTHA_WORK_ROOT") && !keys?.has("GROUND_CONTROL_WORK_ROOT")) {
      checks.push({
        id: "work_root_legacy_key",
        status: "warn",
        severity: "warn",
        detail: "prefer_ground_control_work_root",
      });
    }
  } else {
    checks.push({
      id: "ground_control_work_root",
      status: "warn",
      severity: "warn",
      detail: "not_configured",
    });
  }

  const brain = brainKeysFromMap(keys);
  const anyBrain = Object.values(brain).some(Boolean);
  if (anyBrain) {
    const complete =
      brain.BRAIN_ROOT &&
      (brain.BRAIN_VAULT || brain.BRAIN_ROOT) &&
      (brain.BRAIN_PYTHON || brain.BRAIN_ROOT) &&
      (brain.BRAIN_SCRIPT || brain.BRAIN_ROOT);
    checks.push({
      id: "brain_adapter",
      status: complete ? "pass" : "warn",
      severity: "warn",
      detail: complete ? "configured" : "incomplete",
    });
  } else {
    checks.push({
      id: "brain_adapter",
      status: "warn",
      severity: "warn",
      detail: "not_configured",
    });
  }

  if (configExists && keys) {
    try {
      const yaml = readFileSync(configPath, "utf8");
      for (const agent of ["cursor", "kimi"]) {
        const re = new RegExp(`${agent}:[\\s\\S]*?binary:\\s*(\\S+)`, "m");
        const m = yaml.match(re);
        const bin = m?.[1]?.replace(/"/g, "");
        if (bin && bin.includes("YOU")) {
          checks.push({
            id: `agent_${agent}_binary`,
            status: "warn",
            severity: "warn",
            detail: "placeholder_path",
          });
        } else if (bin) {
          checks.push({
            id: `agent_${agent}_binary`,
            status: existsSync(bin) ? "pass" : "warn",
            severity: "warn",
            detail: existsSync(bin) ? "found" : "missing",
          });
        }
      }
    } catch {
      checks.push({
        id: "config_yaml_parse",
        status: "warn",
        severity: "warn",
        detail: "unreadable",
      });
    }
  }

  checks.push({
    id: "docker_mock_image",
    status: commandExists("docker") ? "pass" : "warn",
    severity: "warn",
    detail: commandExists("docker") ? "cli_found" : "cli_missing",
  });

  const yg3Enabled =
    keys?.get("YG3_MCP_ENABLED")?.trim() === "1" ||
    keys?.get("YG3_MCP_ENABLED")?.trim()?.toLowerCase() === "true";
  checks.push({
    id: "yg3_mcp_enabled",
    status: yg3Enabled ? "pass" : "warn",
    severity: "warn",
    detail: yg3Enabled ? "enabled" : "disabled",
  });
  const relayData = keys?.get("RELAY_DATA_DIR")?.trim() || "./data/relay";
  const metaPresent = yg3OAuthClientRegistered(root, keys);
  checks.push({
    id: "yg3_oauth_metadata",
    status: yg3Enabled ? (metaPresent ? "pass" : "warn") : "warn",
    severity: "warn",
    detail: yg3Enabled
      ? metaPresent
        ? "present"
        : "missing"
      : "not_applicable",
  });
  const snapV1Path = relayData.startsWith("/")
    ? join(relayData, "yg3", "snapshot-v1.json")
    : join(root, relayData, "yg3", "snapshot-v1.json");
  const snapPresent = existsSync(snapV1Path);
  checks.push({
    id: "yg3_snapshot_v1",
    status: yg3Enabled ? (snapPresent ? "pass" : "warn") : "warn",
    severity: "warn",
    detail: yg3Enabled
      ? snapPresent
        ? "present"
        : "missing"
      : "not_applicable",
  });

  checks.push({
    id: "yg3_keychain_tokens",
    status:
      yg3Enabled && process.platform === "darwin"
        ? yg3KeychainTokensPresent()
          ? "pass"
          : "warn"
        : "warn",
    severity: "warn",
    detail: yg3Enabled
      ? process.platform === "darwin"
        ? yg3KeychainTokensPresent()
          ? "present"
          : "missing"
        : "non_darwin"
      : "not_applicable",
  });

  checks.push({
    id: "gc_supported_os",
    status: isMacOsPlatform() ? "pass" : "warn",
    severity: "warn",
    detail: isMacOsPlatform() ? "macos" : "unsupported_for_first_release",
  });

  checks.push({
    id: "yg3_workspace_selection",
    status:
      yg3Enabled && keys
        ? workspaceSelectionPresent(root, keys)
          ? "pass"
          : "warn"
        : "warn",
    severity: "warn",
    detail: yg3Enabled
      ? workspaceSelectionPresent(root, keys)
        ? "present"
        : "missing_or_client_auto_pending"
      : "not_applicable",
  });

  const yg3Template = join(
    root,
    "launchd",
    "templates",
    "com.groundcontrol.yg3-sync.plist.template",
  );
  checks.push({
    id: "yg3_sync_launchagent_template",
    status: existsSync(yg3Template) ? "pass" : "warn",
    severity: "warn",
    detail: existsSync(yg3Template) ? "present" : "missing",
  });

  checks.push({
    id: "yg3_sync_launchagent_rendered",
    status: renderedYg3PlistPresent(root) ? "pass" : "warn",
    severity: "warn",
    detail: renderedYg3PlistPresent(root) ? "rendered" : "not_rendered",
  });

  checks.push({
    id: "yg3_sync_last_health",
    status: yg3Enabled ? (yg3SyncStatusHealthy(root, keys) ? "pass" : "warn") : "warn",
    severity: "warn",
    detail: yg3Enabled ? yg3SyncStatusDetail(root, keys) : "not_applicable",
  });

  const assertLive = process.env.GROUND_CONTROL_DOCTOR_ASSERT_LIVE_AGENTS === "1";
  checks.push({
    id: "yg3_sync_launchagent_live",
    status: "warn",
    severity: "warn",
    detail: assertLive ? yg3LiveLaunchAgentDetail() : "not_checked_isolated",
  });

  const blockers = checks.filter(
    (c) => c.severity === "blocker" && c.status === "fail",
  );
  return {
    ok: blockers.length === 0,
    checks,
    exitCode: blockers.length === 0 ? 0 : 1,
  };
}

function yg3OAuthClientRegistered(root, keys) {
  const relayData = keys?.get("RELAY_DATA_DIR")?.trim() || "./data/relay";
  const primary = relayData.startsWith("/")
    ? join(relayData, "yg3", "oauth-client.json")
    : join(root, relayData, "yg3", "oauth-client.json");
  const candidates = [
    primary,
    join(root, "packages", "data", "relay", "yg3", "oauth-client.json"),
    join(
      root,
      "packages",
      "relay",
      "data",
      "relay",
      "yg3",
      "oauth-client.json",
    ),
  ];
  for (const metaPath of candidates) {
    if (!existsSync(metaPath)) continue;
    try {
      const parsed = JSON.parse(readFileSync(metaPath, "utf8"));
      if (parsed?.client?.client_id) return true;
    } catch {
      /* unreadable */
    }
  }
  return false;
}

function yg3SyncStatusPath(root, keys) {
  const relayData = keys?.get("RELAY_DATA_DIR")?.trim() || "./data/relay";
  return relayData.startsWith("/")
    ? join(relayData, "yg3", "sync-status.json")
    : join(root, relayData, "yg3", "sync-status.json");
}

function yg3SyncStatusDetail(root, keys) {
  const p = yg3SyncStatusPath(root, keys);
  if (!existsSync(p)) return "missing";
  try {
    const s = JSON.parse(readFileSync(p, "utf8"));
    const state = typeof s.state === "string" ? s.state : "unknown";
    const err =
      typeof s.lastErrorCode === "string" && s.lastErrorCode
        ? `_err_${s.lastErrorCode}`
        : "";
    return `${state}${err}`;
  } catch {
    return "unreadable";
  }
}

function yg3SyncStatusHealthy(root, keys) {
  const detail = yg3SyncStatusDetail(root, keys);
  return detail === "ok" || detail === "running" || detail === "idle";
}

function yg3LiveLaunchAgentDetail() {
  try {
    const { spawnSync } = require("node:child_process");
    const r = spawnSync("launchctl", ["print", "gui/0/com.groundcontrol.yg3-sync"], {
      stdio: "ignore",
    });
    return r.status === 0 ? "installed" : "not_installed";
  } catch {
    return "check_failed";
  }
}

function yg3KeychainTokensPresent() {
  try {
    const { spawnSync } = require("node:child_process");
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
  } catch {
    return false;
  }
}

function commandExists(cmd) {
  try {
    const { execSync } = require("node:child_process");
    execSync(`command -v ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function assertLoopbackHealthUrl(urlString) {
  const u = new URL(urlString);
  const host = u.hostname.toLowerCase();
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error("health_url_not_loopback");
  }
  return u;
}

async function relayHealthChecks(urlString) {
  const out = [];
  try {
    assertLoopbackHealthUrl(urlString);
    const res = await fetch(urlString, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      out.push({
        id: "relay_health",
        status: "warn",
        severity: "warn",
        detail: `http_${res.status}`,
      });
      return out;
    }
    const body = await res.json();
    out.push({
      id: "relay_health",
      status: "pass",
      severity: "info",
      detail: "reachable",
    });
    const connected = Boolean(body?.worker?.connected ?? body?.connected);
    out.push({
      id: "worker_connected",
      status: connected ? "pass" : "warn",
      severity: "warn",
      detail: connected ? "true" : "false",
    });
  } catch {
    out.push({
      id: "relay_health",
      status: "warn",
      severity: "warn",
      detail: "unreachable",
    });
  }
  return out;
}

export async function runDoctorAsync(options) {
  const base = runDoctor(options);
  if (options.relayHealthUrl) {
    const extra = await relayHealthChecks(options.relayHealthUrl);
    base.checks.push(...extra);
  }
  const blockers = base.checks.filter(
    (c) => c.severity === "blocker" && c.status === "fail",
  );
  base.ok = blockers.length === 0;
  base.exitCode = base.ok ? 0 : 1;
  return base;
}
