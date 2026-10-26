import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_KIMI_POLICY,
  UsageLedger,
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
});
