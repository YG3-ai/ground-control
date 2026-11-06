import { spawn, spawnSync } from "node:child_process";

/**
 * Best-effort kill of a detached process group (Unix). No-op when pid is invalid.
 */
export function killProcessGroup(
  pid: number,
  signal: NodeJS.Signals = "SIGTERM",
): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

/** Probe whether anything responds in the process group (Unix). */
export function processGroupAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Parse host runner container_id (pid string) for cleanup. */
export function parseHostProcessGroupPid(
  containerId: string | null | undefined,
): number | null {
  if (!containerId?.trim()) return null;
  const n = Number(containerId);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Used in tests — detached spawn whose pid is the process group leader on Unix. */
export function spawnDetachedGroup(
  command: string,
  args: string[],
  opts: { cwd: string; env?: Record<string, string> },
): { pid: number | null } {
  const child = spawn(command, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return { pid: child.pid ?? null };
}

export function killProcessGroupSync(pid: number): void {
  killProcessGroup(pid, "SIGTERM");
  spawnSync("sleep", ["0.05"]);
  if (processGroupAlive(pid)) {
    killProcessGroup(pid, "SIGKILL");
  }
}
