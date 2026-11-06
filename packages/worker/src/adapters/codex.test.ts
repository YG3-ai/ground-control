import { describe, expect, it } from "vitest";
import { CodexAdapter, parseCodexSessionFromJsonl } from "./codex.js";
import type { JobRecord } from "@agent-control/shared";

const job = (overrides: Partial<JobRecord> = {}): JobRecord => ({
  id: "job-1",
  owner_id: "owner",
  project_id: "proj",
  agent: "codex",
  prompt: "say hi",
  status: "queued",
  idempotency_key: null,
  session_id: null,
  work_path: "/tmp/ws",
  container_id: null,
  exit_code: null,
  error: null,
  summary: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  started_at: null,
  finished_at: null,
  timeout_sec: 60,
  ...overrides,
});

describe("CodexAdapter", () => {
  it("builds exec command without secrets", () => {
    const adapter = new CodexAdapter();
    const plan = adapter.plan({
      job: job(),
      workPath: "/tmp/ws",
      followupMessages: [],
      execution: "host",
      isolationImage: "img",
      network: "none",
      runAsUser: "0",
      readOnlyRootfs: true,
      memoryMb: 512,
      cpus: 1,
      timeoutSec: 60,
      binary: "/usr/local/bin/codex",
      model: "gpt-test",
      reasoningEffort: "low",
    });
    expect(plan.execution).toBe("host");
    if (plan.execution !== "host") return;
    expect(plan.hostSpec.command).toBe("/usr/local/bin/codex");
    expect(plan.hostSpec.args).toContain("exec");
    expect(plan.hostSpec.args).toContain("--json");
    expect(plan.hostSpec.args).toContain("-m");
    expect(plan.hostSpec.args).toContain("gpt-test");
    expect(plan.hostSpec.args.join(" ")).toContain('model_reasoning_effort="low"');
    expect(plan.hostSpec.args).toContain("--approve-for-me");
    expect(plan.hostSpec.args).not.toContain("workspace-write");
    expect(plan.hostSpec.args.join(" ")).not.toMatch(/sk-|Bearer|auth\.json/);
  });

  it("parses session id from jsonl", () => {
    const id = parseCodexSessionFromJsonl(
      '{"type":"thread","thread_id":"abc-123"}\n',
    );
    expect(id).toBe("abc-123");
  });
});
