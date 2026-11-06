import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_KIMI_POLICY,
  UsageLedger,
  isProviderRateLimitFailure,
  looksLikeRateLimit,
} from "./ledger.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("UsageLedger", () => {
  it("paces kimi starts inside the rolling window", () => {
    const dir = mkdtempSync(join(tmpdir(), "ac-usage-"));
    roots.push(dir);
    const ledger = new UsageLedger(join(dir, "usage.db"));
    const policy = {
      ...DEFAULT_KIMI_POLICY,
      max_starts_per_window: 2,
      min_gap_sec: 0,
    };
    expect(ledger.checkBudget("kimi", policy, 0).allowed).toBe(true);
    ledger.record({ agent: "kimi", kind: "start", jobId: "a" });
    ledger.record({ agent: "kimi", kind: "start", jobId: "b" });
    const blocked = ledger.checkBudget("kimi", policy, 0);
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toMatch(/max_starts_per_window/);
    ledger.close();
  });

  it("detects rate limit text", () => {
    expect(looksLikeRateLimit("Error: rate limit exceeded")).toBe(true);
    expect(looksLikeRateLimit("ok")).toBe(false);
  });

  it("only treats failed executor error output as a provider limit", () => {
    expect(isProviderRateLimitFailure({ exitCode: 0, stderr: "Error: rate limit exceeded" })).toBe(false);
    expect(isProviderRateLimitFailure({ exitCode: 1, stderr: "" })).toBe(false);
    expect(isProviderRateLimitFailure({ exitCode: 1, stderr: "Error: HTTP 429 rate limit exceeded" })).toBe(true);
  });
});

it("recognizes top-level provider failures and ignores quoted command output", () => {
 const error = JSON.stringify({type: "error", message: "HTTP 429 rate limit exceeded"});
 expect(isProviderRateLimitFailure({exitCode: 1, stdout: error, stderr: ""})).toBe(true);
 expect(isProviderRateLimitFailure({exitCode: 1, stdout: JSON.stringify({type: "turn.failed", error: {message: "usage limit exceeded"}}), stderr: ""})).toBe(true);
 const command = JSON.stringify({type: "item.completed", item: {type: "command_execution", aggregated_output: error}});
 expect(isProviderRateLimitFailure({exitCode: 1, stdout: command, stderr: ""})).toBe(false);
 expect(isProviderRateLimitFailure({exitCode: 0, stdout: error, stderr: ""})).toBe(false);
});
