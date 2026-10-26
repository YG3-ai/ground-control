import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ExecResult = {
  stdout: string;
  stderr: string;
  code: number;
};

export async function runBounded(
  file: string,
  args: readonly string[],
  opts: {
    cwd?: string;
    timeoutMs: number;
    maxBuffer: number;
    env?: NodeJS.ProcessEnv;
  },
): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(file, [...args], {
      cwd: opts.cwd,
      timeout: opts.timeoutMs,
      maxBuffer: opts.maxBuffer,
      env: opts.env,
      shell: false,
    });
    return { stdout: String(stdout), stderr: String(stderr), code: 0 };
  } catch (err: unknown) {
    const e = err as {
      stdout?: string;
      stderr?: string;
      code?: number;
      message?: string;
    };
    return {
      stdout: String(e.stdout ?? ""),
      stderr: String(e.stderr ?? e.message ?? ""),
      code: typeof e.code === "number" ? e.code : 1,
    };
  }
}

/** Slug for brain read: letters, numbers, slash, hyphen only. */
export function isSafeBrainSlug(slug: string): boolean {
  if (!slug || slug.length > 120) return false;
  return /^[a-zA-Z0-9/_-]+$/.test(slug);
}

export function clampText(input: string, max: number): string {
  const t = input.trim();
  if (t.length <= max) return t;
  return t.slice(0, max);
}
