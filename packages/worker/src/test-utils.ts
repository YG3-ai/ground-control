import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import type { AppConfig } from "@agent-control/shared";
import { WorkerService } from "./service.js";

export function makeTempRoot(): string {
  return mkdtempSync(join(tmpdir(), "ac-worker-"));
}

export function initGitFixture(dir: string): void {
  writeFileSync(join(dir, "README.md"), "# fixture\n");
  writeFileSync(join(dir, "hello.txt"), "hello\n");
  spawnSync("git", ["init"], { cwd: dir, encoding: "utf8" });
  spawnSync("git", ["config", "user.email", "test@example.com"], {
    cwd: dir,
    encoding: "utf8",
  });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir, encoding: "utf8" });
  spawnSync("git", ["add", "."], { cwd: dir, encoding: "utf8" });
  spawnSync("git", ["commit", "-m", "init"], { cwd: dir, encoding: "utf8" });
}

export function buildTestConfig(root: string, fixturePath: string): AppConfig {
  mkdirSync(join(root, "data", "worker"), { recursive: true });
  mkdirSync(join(root, "data", "policy"), { recursive: true });
  return {
    owner: { id: "owner-test", display_name: "Test Owner" },
    relay: { url: "ws://127.0.0.1:8787/worker" },
    worker: {
      data_dir: join(root, "data", "worker"),
      policy_dir: join(root, "data", "policy"),
      max_output_bytes: 64_000,
      default_timeout_sec: 120,
      agent_execution: "docker",
      allowed_roots: [fixturePath],
      local_control: { enabled: false },
      isolation: {
        backend: "docker",
        image: "agent-control-mock:local",
        network: "none",
        run_as_user: "1000:1000",
        read_only_rootfs: true,
        memory_mb: 512,
        cpus: 1,
      },
    },
    supervisor: { enabled: false },
    agents: {
      mock: { enabled: true, adapter: "mock" },
      cursor: { enabled: false, adapter: "cursor" },
      kimi: { enabled: false, adapter: "kimi" },
    },
    projects: [
      {
        id: "demo-sandbox",
        name: "Demo Sandbox",
        description: "test",
        source_path: fixturePath,
        allowed_agents: ["mock"],
        permissions: {
          network: "none",
          git_write: true,
          max_runtime_sec: 120,
        },
        credentials: [],
      },
    ],
  };
}

export function createService(root: string, fixturePath: string): WorkerService {
  const config = buildTestConfig(root, fixturePath);
  return new WorkerService({
    config,
    dbPath: join(root, "data", "worker", "jobs.db"),
    configRoot: root,
  });
}

export async function waitForJob(
  service: WorkerService,
  jobId: string,
  timeoutMs = 90_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = service.store.getJob(jobId);
    if (
      job &&
      (job.status === "succeeded" ||
        job.status === "failed" ||
        job.status === "cancelled" ||
        job.status === "timed_out")
    ) {
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timeout waiting for job ${jobId}`);
}

/** Opt-in: `AGENT_CONTROL_ENABLE_DOCKER_TESTS=1` when Docker is running (avoids hung `docker` CLI). */
export function dockerAvailable(): boolean {
  if (process.env.AGENT_CONTROL_ENABLE_DOCKER_TESTS !== "1") return false;
  const probe = spawnSync("docker", ["version"], {
    encoding: "utf8",
    stdio: "pipe",
    timeout: 3_000,
    killSignal: "SIGKILL",
  });
  if (probe.error) return false;
  return probe.status === 0;
}

export function ensureMockImage(): void {
  const repoRoot = join(
    // packages/worker/src -> repo root
    fileUrlRepoRoot(),
  );
  const built = spawnSync(
    "docker",
    ["images", "-q", "agent-control-mock:local"],
    { encoding: "utf8" },
  );
  if (built.stdout.trim()) return;
  const result = spawnSync(
    "docker",
    ["build", "-t", "agent-control-mock:local", join(repoRoot, "docker/mock-agent")],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`failed to build mock image: ${result.stderr || result.stdout}`);
  }
}

function fileUrlRepoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../../..");
}
