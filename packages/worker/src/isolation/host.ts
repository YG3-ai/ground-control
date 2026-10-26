import { spawn, type ChildProcess } from "node:child_process";
import type {
  IsolationHandle,
  IsolationRunResult,
  OutputChunkHandler,
} from "./types.js";

export interface HostRunSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutSec: number;
  name?: string;
  /** Incremental log callback so get_task_output is non-empty while running. */
  onOutput?: OutputChunkHandler;
}

/**
 * Managed local process runner for Cursor/Kimi CLIs.
 * Does not attach to your interactive terminal sessions — spawns a fresh process
 * per job with the workspace those tools already understand (git remotes, etc.).
 */
export class HostProcessBackend {
  readonly name = "host";

  async run(spec: HostRunSpec): Promise<IsolationHandle> {
    let child: ChildProcess | null = null;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killed = false;
    let exitCode = 1;
    let settled = false;
    let resolveWait: ((r: IsolationRunResult) => void) | null = null;

    const waitPromise = new Promise<IsolationRunResult>((resolve) => {
      resolveWait = resolve;
    });

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      exitCode = code;
      resolveWait?.({
        containerId: null,
        exitCode,
        stdout,
        stderr,
        timedOut,
        killed,
      });
    };

    child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killed = true;
      child?.kill("SIGKILL");
    }, Math.max(1, spec.timeoutSec) * 1000);

    child.stdout?.on("data", (d: Buffer) => {
      const text = d.toString("utf8");
      stdout += text;
      try {
        spec.onOutput?.({ stdout: text });
      } catch {
        // never break the child on log persistence errors
      }
    });
    child.stderr?.on("data", (d: Buffer) => {
      const text = d.toString("utf8");
      stderr += text;
      try {
        spec.onOutput?.({ stderr: text });
      } catch {
        // ignore
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        const msg =
          `executable not found: ${spec.command} (ENOENT). ` +
          `Configure agents.*.binary to an absolute path visible to the worker ` +
          `(launchd PATH is often empty). Not an opaque exit 127.`;
        stderr += msg;
        try {
          spec.onOutput?.({ stderr: msg });
        } catch {
          // ignore
        }
      } else {
        const msg = String(err);
        stderr += msg;
        try {
          spec.onOutput?.({ stderr: msg });
        } catch {
          // ignore
        }
      }
      finish(127);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(timedOut ? 124 : (code ?? 1));
    });

    const pid = child.pid != null ? String(child.pid) : `host-${Date.now()}`;

    return {
      containerId: pid,
      wait: () => waitPromise,
      cancel: async (signal: "SIGTERM" | "SIGKILL" = "SIGTERM") => {
        killed = true;
        if (!child || child.killed) return;
        child.kill(signal === "SIGKILL" ? "SIGKILL" : "SIGTERM");
        if (signal === "SIGTERM") {
          setTimeout(() => {
            if (child && !child.killed) child.kill("SIGKILL");
          }, 5_000);
        }
      },
    };
  }
}
