import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type {
  IsolationBackend,
  IsolationHandle,
  IsolationRunResult,
  IsolationRunSpec,
} from "./types.js";

function assertSafeMount(hostPath: string): void {
  const abs = resolve(hostPath);
  const home = resolve(homedir());

  if (
    abs === "/var/run/docker.sock" ||
    abs === "/run/docker.sock" ||
    abs.endsWith("/docker.sock")
  ) {
    throw new Error(`refusing docker.sock mount: ${hostPath}`);
  }
  if (abs === home) {
    throw new Error(`refusing to mount home directory: ${hostPath}`);
  }
  if (
    abs.includes("/Library/Keychains") ||
    abs === `${home}/.ssh` ||
    abs.startsWith(`${home}/.ssh/`)
  ) {
    throw new Error(`refusing sensitive host mount: ${hostPath}`);
  }
}

function runDocker(
  args: string[],
  opts?: { timeoutMs?: number; input?: string },
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn("docker", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer =
      opts?.timeoutMs != null
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, opts.timeoutMs)
        : null;

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: String(err), timedOut });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, timedOut });
    });

    if (opts?.input != null) {
      child.stdin.write(opts.input);
    }
    child.stdin.end();
  });
}

/**
 * Docker isolation backend.
 *
 * Hard constraints enforced here (not left to agents):
 * - never mounts Docker socket, home, SSH agent, or Keychain
 * - never runs privileged / with capability add
 * - non-root user when configured
 * - optional read-only rootfs + tmpfs for /tmp
 */
export class DockerIsolationBackend implements IsolationBackend {
  readonly name = "docker";

  async assertAvailable(): Promise<void> {
    const probe = await runDocker(["version", "--format", "{{.Server.Version}}"], {
      timeoutMs: 15_000,
    });
    if (probe.code !== 0) {
      throw new Error(
        `Docker is required for isolation but is unavailable: ${probe.stderr || probe.stdout}`,
      );
    }
  }

  private buildArgs(spec: IsolationRunSpec): string[] {
    const args = [
      "run",
      "-d",
      "--name",
      spec.name ?? `ac-${Date.now()}`,
      "--user",
      spec.runAsUser,
      `--memory=${spec.memoryMb}m`,
      `--cpus=${String(spec.cpus)}`,
      "--workdir",
      spec.workdir,
      // No privilege escalation path for agents.
      "--security-opt",
      "no-new-privileges:true",
      "--cap-drop",
      "ALL",
    ];

    if (spec.readOnlyRootfs) {
      args.push("--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m");
    }

    // Network: "none" or a named custom network. Never host networking.
    if (spec.network === "none") {
      args.push("--network", "none");
    } else if (spec.network === "host") {
      throw new Error("host networking is forbidden");
    } else {
      args.push("--network", spec.network);
    }

    for (const [k, v] of Object.entries(spec.env)) {
      // Reject attempts to inject docker-related or host secret env blindly —
      // callers must pass an explicit allowlisted env map.
      if (/^(DOCKER_|SSH_|AWS_CONTAINER_)/i.test(k)) {
        throw new Error(`env var not allowed in isolation: ${k}`);
      }
      args.push("-e", `${k}=${v}`);
    }

    for (const m of spec.mounts) {
      assertSafeMount(m.hostPath);
      const flag = m.readOnly ? "ro" : "rw";
      args.push("-v", `${m.hostPath}:${m.containerPath}:${flag}`);
    }

    args.push(spec.image, ...spec.command);
    return args;
  }

  async run(spec: IsolationRunSpec): Promise<IsolationHandle> {
    await this.assertAvailable();
    const args = this.buildArgs(spec);
    const started = await runDocker(args, { timeoutMs: 60_000 });
    if (started.code !== 0) {
      throw new Error(`docker run failed: ${started.stderr || started.stdout}`);
    }
    const containerId = started.stdout.trim();
    if (!containerId) {
      throw new Error("docker run returned empty container id");
    }

    let cancelled = false;
    let waitPromise: Promise<IsolationRunResult> | null = null;
    let streamedStdout = "";
    let streamedStderr = "";
    let logFollow: ReturnType<typeof spawn> | null = null;

    if (spec.onOutput) {
      // Follow logs while the container runs so get_task_output is not empty mid-job.
      logFollow = spawn("docker", ["logs", "-f", containerId], {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
      logFollow.stdout?.on("data", (d: Buffer) => {
        const text = d.toString("utf8");
        streamedStdout += text;
        try {
          spec.onOutput?.({ stdout: text });
        } catch {
          // ignore
        }
      });
      logFollow.stderr?.on("data", (d: Buffer) => {
        const text = d.toString("utf8");
        streamedStderr += text;
        try {
          spec.onOutput?.({ stderr: text });
        } catch {
          // ignore
        }
      });
    }

    const stopLogFollow = () => {
      if (!logFollow) return;
      try {
        logFollow.kill("SIGTERM");
      } catch {
        // ignore
      }
      logFollow = null;
    };

    const wait = async (): Promise<IsolationRunResult> => {
      if (waitPromise) return waitPromise;
      waitPromise = (async () => {
        const timeoutMs = Math.max(1, spec.timeoutSec) * 1000;
        const waited = await runDocker(["wait", containerId], { timeoutMs });
        let timedOut = waited.timedOut;
        let killed = cancelled;
        let exitCode = 1;

        if (timedOut) {
          await runDocker(["kill", containerId], { timeoutMs: 15_000 });
          killed = true;
          exitCode = 124;
        } else {
          exitCode = Number.parseInt(waited.stdout.trim(), 10);
          if (Number.isNaN(exitCode)) exitCode = waited.code === 0 ? 0 : 1;
        }

        stopLogFollow();
        const logs = await runDocker(["logs", containerId], { timeoutMs: 30_000 });
        // Cleanup container to avoid leaks; ignore errors.
        await runDocker(["rm", "-f", containerId], { timeoutMs: 15_000 });

        return {
          containerId,
          exitCode,
          stdout: logs.stdout || streamedStdout,
          stderr: logs.stderr || streamedStderr,
          timedOut,
          killed,
        };
      })();
      return waitPromise;
    };

    return {
      containerId,
      wait,
      cancel: async (signal: "SIGTERM" | "SIGKILL" = "SIGTERM") => {
        cancelled = true;
        stopLogFollow();
        const killArgs =
          signal === "SIGKILL"
            ? ["kill", containerId]
            : ["kill", "--signal", "SIGTERM", containerId];
        await runDocker(killArgs, { timeoutMs: 15_000 });
      },
    };
  }

  async assertHostPathInvisible(
    hostPath: string,
  ): Promise<{ ok: true } | { ok: false; detail: string }> {
    await this.assertAvailable();
    await access(hostPath);

    // Start a container with NO mounts and network none; try to read the host path
    // string as if it existed inside the container (it must not).
    const result = await runDocker(
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--user",
        "1000:1000",
        "--read-only",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=16m",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "alpine:3.20",
        "sh",
        "-c",
        // Attempt to read the host absolute path; must fail.
        `if [ -e '${hostPath.replace(/'/g, "")}' ]; then echo VISIBLE; cat '${hostPath.replace(/'/g, "")}'; exit 0; else echo INVISIBLE; exit 0; fi`,
      ],
      { timeoutMs: 60_000 },
    );

    if (result.code !== 0) {
      return { ok: false, detail: result.stderr || result.stdout };
    }
    const lines = result.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.includes("VISIBLE")) {
      return { ok: false, detail: `host path unexpectedly visible: ${hostPath}` };
    }
    if (!lines.includes("INVISIBLE")) {
      return { ok: false, detail: `unexpected probe output: ${result.stdout}` };
    }
    return { ok: true };
  }
}

export class MockFailIsolationBackend implements IsolationBackend {
  readonly name = "mock-fail";

  async assertAvailable(): Promise<void> {
    throw new Error(
      "Isolation backend is mock-fail: refusing to run agents on the unrestricted host login. Install/start Docker (or another supported container/VM backend).",
    );
  }

  async run(): Promise<IsolationHandle> {
    await this.assertAvailable();
    throw new Error("unreachable");
  }

  async assertHostPathInvisible(): Promise<{ ok: false; detail: string }> {
    return {
      ok: false,
      detail: "isolation backend unavailable; cannot verify sentinel invisibility",
    };
  }
}
