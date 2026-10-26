import { existsSync } from "node:fs";
import { join } from "node:path";

export type BoardExtensionPaths = {
  /** Set when GROUND_CONTROL_WORK_ROOT (or legacy PARTHA_WORK_ROOT) is configured. */
  parthaWorkRoot: string | null;
  parthaWorkEnvFile: string | null;
  funnelsLoopbackBase: string;
  brainRoot: string | null;
  brainPython: string | null;
  brainScript: string | null;
  brainVault: string | null;
  /** Optional Second Brain slug for owner identity on Home (env only — never hardcoded). */
  brainOwnerProfileSlug: string | null;
  growthRunnerScript: string;
  yg3AccountsRunnerScript: string;
  lifecycleQueueScript: string | null;
};

export function repoRootFromRelayPackage(relayPackageRoot: string): string {
  return join(relayPackageRoot, "..", "..");
}

export function workRootAdapterConfigured(pathsCfg: BoardExtensionPaths): boolean {
  return pathsCfg.parthaWorkRoot != null && pathsCfg.parthaWorkRoot.length > 0;
}

export function brainAdapterConfigured(pathsCfg: BoardExtensionPaths): boolean {
  return (
    pathsCfg.brainRoot != null &&
    pathsCfg.brainPython != null &&
    pathsCfg.brainScript != null &&
    pathsCfg.brainVault != null
  );
}

export function resolveWorkRootFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const workTrim =
    env.GROUND_CONTROL_WORK_ROOT?.trim() || env.PARTHA_WORK_ROOT?.trim();
  return workTrim ? workTrim.replace(/\/$/, "") : null;
}

export function resolveBoardExtensionPaths(
  relayPackageRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): BoardExtensionPaths {
  const parthaWorkRoot = resolveWorkRootFromEnv(env);

  let parthaWorkEnvFile: string | null = null;
  if (parthaWorkRoot) {
    const envLocal = join(parthaWorkRoot, ".env.local");
    parthaWorkEnvFile = existsSync(envLocal)
      ? envLocal
      : join(parthaWorkRoot, ".env");
  }

  const funnelsLoopbackBase = (
    env.FUNNELS_LOOPBACK_URL?.trim() || "http://127.0.0.1:4141"
  ).replace(/\/$/, "");

  const brainRootTrim = env.BRAIN_ROOT?.trim();
  const brainRoot = brainRootTrim ? brainRootTrim.replace(/\/$/, "") : null;

  const profileSlug = env.BRAIN_OWNER_PROFILE_SLUG?.trim() || "";

  const brainPython =
    env.BRAIN_PYTHON?.trim() ||
    (brainRoot ? join(brainRoot, ".venv/bin/python") : null);
  const brainScript =
    env.BRAIN_SCRIPT?.trim() || (brainRoot ? join(brainRoot, "brain.py") : null);
  const brainVault =
    env.BRAIN_VAULT?.trim().replace(/\/$/, "") ||
    (brainRoot ? join(brainRoot, "vault") : null);

  return {
    parthaWorkRoot,
    parthaWorkEnvFile,
    funnelsLoopbackBase,
    brainRoot,
    brainPython,
    brainScript,
    brainVault,
    brainOwnerProfileSlug: profileSlug.length > 0 ? profileSlug : null,
    growthRunnerScript: join(
      relayPackageRoot,
      "scripts",
      "board-growth-runner.ts",
    ),
    yg3AccountsRunnerScript: join(
      relayPackageRoot,
      "scripts",
      "board-yg3-accounts-runner.ts",
    ),
    lifecycleQueueScript: parthaWorkRoot
      ? join(parthaWorkRoot, "scripts", "lifecycle.ts")
      : null,
  };
}
