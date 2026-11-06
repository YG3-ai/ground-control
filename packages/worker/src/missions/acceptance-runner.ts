import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

export type AcceptanceRunResult =
  | {
      ok: true;
      exitCode: 0;
      evidenceHash: string;
      durationMs: number;
    }
  | {
      ok: false;
      exitCode: number;
      evidenceHash: string;
      durationMs: number;
      code: "non_zero_exit" | "timeout" | "spawn_error";
    };

export function acceptanceEvidenceHash(input: {
  testId: string;
  exitCode: number;
  durationMs: number;
}): string {
  return createHash("sha256")
    .update(`${input.testId}|${input.exitCode}|${input.durationMs}`)
    .digest("hex")
    .slice(0, 16);
}

export function acceptanceEvidenceMarker(testId: string): string {
  return `acceptance_evidence:${testId}`;
}

export function acceptanceExitCodeMarker(testId: string): string {
  return `acceptance_exit_code:${testId}`;
}

/**
 * Run a qualification acceptance command in the mission workspace.
 * Does not capture stdout/stderr into markers or events — hash + exit code only.
 */
export async function runAcceptanceCommand(input: {
  testId: string;
  command: string;
  cwd: string;
  timeoutSec?: number;
}): Promise<AcceptanceRunResult> {
  const started = Date.now();
  const timeoutMs = Math.max(1, input.timeoutSec ?? 600) * 1000;
  const child = spawn(input.command, {
    shell: true,
    cwd: input.cwd,
    stdio: "ignore",
  });
  const outcome = await new Promise<{ exitCode: number; code?: "timeout" | "spawn_error" }>((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGTERM"); resolve({ exitCode: 124, code: "timeout" }); }, timeoutMs);
    child.once("error", () => { clearTimeout(timer); resolve({ exitCode: 1, code: "spawn_error" }); });
    child.once("close", (code) => { clearTimeout(timer); resolve({ exitCode: code ?? 1 }); });
  });
  const durationMs = Date.now() - started;
  const exitCode = outcome.exitCode;
  const evidenceHash = acceptanceEvidenceHash({
    testId: input.testId,
    exitCode,
    durationMs,
  });
  if (outcome.code === "timeout") {
    return {
      ok: false,
      exitCode: 124,
      evidenceHash,
      durationMs,
      code: "timeout",
    };
  }
  if (outcome.code === "spawn_error") {
    return {
      ok: false,
      exitCode: exitCode || 1,
      evidenceHash,
      durationMs,
      code: "spawn_error",
    };
  }
  if (exitCode !== 0) {
    return {
      ok: false,
      exitCode,
      evidenceHash,
      durationMs,
      code: "non_zero_exit",
    };
  }
  return { ok: true, exitCode: 0, evidenceHash, durationMs };
}
