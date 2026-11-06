import { spawnSync } from "node:child_process";
import { constants, existsSync, accessSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  BinaryResolveError,
  resolveExecutable,
} from "../binary-resolve.js";

export type CodexProbe = {
  ok: boolean;
  path: string | null;
  version: string | null;
  auth_configured: boolean | null;
  auth_mode: string | null;
  path_source: "configured" | "resolved" | "missing";
  launchd_path_ok: boolean;
  error: string | null;
};

const LAUNCHD_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
/** `codex doctor` checks local state databases and is too expensive for a board poll. */
const PROBE_CACHE_TTL_MS = 5 * 60_000;
const probeCache = new Map<string, { expiresAt: number; probe: CodexProbe }>();

function probeCacheKey(input?: { configuredBinary?: string; pathEnv?: string }): string {
  return `${input?.configuredBinary ?? ""}\u0000${input?.pathEnv ?? process.env.PATH ?? ""}`;
}

/** Test-only reset; production cache expires quickly enough to reflect login changes. */
export function clearCodexProbeCacheForTests(): void {
  probeCache.clear();
}

function runText(
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): string {
  const r = spawnSync(command, args, {
    encoding: "utf8",
    env: env ?? process.env,
    timeout: 15_000,
  });
  return `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
}

function parseVersion(text: string): string | null {
  const m = text.match(/codex(?:-cli)?\s+([0-9.]+)/i);
  return m?.[1] ?? null;
}

function parseDoctorAuth(text: string): {
  auth_configured: boolean | null;
  auth_mode: string | null;
} {
  let auth_configured: boolean | null = null;
  let auth_mode: string | null = null;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (/auth\s+auth is configured/i.test(t)) {
      auth_configured = true;
    }
    if (/auth\s+not configured/i.test(t)) {
      auth_configured = false;
    }
    if (/stored auth mode\s+/i.test(t)) {
      auth_mode = t.split(/\s{2,}/).pop()?.trim() ?? null;
    }
    if (/auth mode\s+/i.test(t) && !auth_mode) {
      auth_mode = t.split(/\s{2,}/).pop()?.trim() ?? null;
    }
  }
  return { auth_configured, auth_mode };
}

export function probeCodexBinary(input?: {
  configuredBinary?: string;
  pathEnv?: string;
}): CodexProbe {
  const cacheKey = probeCacheKey(input);
  const cached = probeCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.probe;

  const cache = (probe: CodexProbe): CodexProbe => {
    probeCache.set(cacheKey, { probe, expiresAt: Date.now() + PROBE_CACHE_TTL_MS });
    return probe;
  };
  const pathEnv = input?.pathEnv ?? process.env.PATH ?? "";
  let path: string | null = null;
  let path_source: CodexProbe["path_source"] = "missing";
  try {
    const resolved = resolveExecutable(
      input?.configuredBinary,
      "codex",
      [],
    );
    path = resolved.path;
    path_source = input?.configuredBinary ? "configured" : "resolved";
  } catch (err) {
    return cache({
      ok: false,
      path: null,
      version: null,
      auth_configured: null,
      auth_mode: null,
      path_source: "missing",
      launchd_path_ok: false,
      error:
        err instanceof BinaryResolveError ? err.message : String(err),
    });
  }

  const versionText = runText(path, ["--version"], { PATH: pathEnv });
  const version = parseVersion(versionText);

  let launchd_path_ok = false;
  if (path && isAbsolute(path)) {
    try {
      accessSync(path, constants.X_OK);
      launchd_path_ok = existsSync(path);
    } catch {
      launchd_path_ok = false;
    }
  }
  if (!launchd_path_ok) {
    try {
      const thin = runText(path, ["--version"], { PATH: LAUNCHD_PATH });
      launchd_path_ok = Boolean(parseVersion(thin) || thin.includes("codex"));
    } catch {
      launchd_path_ok = false;
    }
  }

  const doctor = runText(path, ["doctor"], { PATH: pathEnv });
  const auth = parseDoctorAuth(doctor);

  return cache({
    ok: true,
    path,
    version,
    auth_configured: auth.auth_configured,
    auth_mode: auth.auth_mode,
    path_source,
    launchd_path_ok,
    error: null,
  });
}
