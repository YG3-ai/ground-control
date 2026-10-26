import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Create an isolated working copy for a job.
 * Prefer git worktree when source is a git repo; otherwise copy the tree.
 * Concurrent jobs never share the same working tree.
 */
export function prepareJobWorkspace(opts: {
  jobsRoot: string;
  jobId: string;
  sourcePath: string;
}): { workPath: string; mode: "worktree" | "copy" } {
  mkdirSync(opts.jobsRoot, { recursive: true });
  const workPath = join(opts.jobsRoot, opts.jobId);
  if (existsSync(workPath)) {
    throw new Error(`work path already exists: ${workPath}`);
  }

  const sourceReal = realpathSync(opts.sourcePath);
  const isGit =
    existsSync(join(sourceReal, ".git")) ||
    spawnSync("git", ["-C", sourceReal, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
    }).status === 0;

  if (isGit) {
    mkdirSync(workPath, { recursive: true });
    // Use a temporary branch name unique to the job.
    const branch = `agent-control/${opts.jobId}`;
    const added = spawnSync(
      "git",
      ["-C", sourceReal, "worktree", "add", "-b", branch, workPath, "HEAD"],
      { encoding: "utf8" },
    );
    if (added.status !== 0) {
      // Fallback to detached worktree without new branch if branch exists oddly.
      rmSync(workPath, { recursive: true, force: true });
      const detached = spawnSync(
        "git",
        ["-C", sourceReal, "worktree", "add", "--detach", workPath, "HEAD"],
        { encoding: "utf8" },
      );
      if (detached.status !== 0) {
        throw new Error(
          `git worktree failed: ${added.stderr || detached.stderr || added.stdout}`,
        );
      }
    }
    return { workPath, mode: "worktree" };
  }

  mkdirSync(workPath, { recursive: true });
  cpSync(sourceReal, workPath, { recursive: true });
  return { workPath, mode: "copy" };
}

export function cleanupJobWorkspace(opts: {
  sourcePath: string;
  workPath: string;
  mode: "worktree" | "copy";
}): void {
  if (opts.mode === "worktree") {
    spawnSync("git", ["-C", opts.sourcePath, "worktree", "remove", "--force", opts.workPath], {
      encoding: "utf8",
    });
    // Best-effort prune.
    spawnSync("git", ["-C", opts.sourcePath, "worktree", "prune"], { encoding: "utf8" });
  }
  rmSync(opts.workPath, { recursive: true, force: true });
}

/** Create a tiny disposable project for tests. */
export function createFixtureProject(root: string): string {
  const dir = mkdtempSync(join(root, "fixture-"));
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
  return dir;
}
