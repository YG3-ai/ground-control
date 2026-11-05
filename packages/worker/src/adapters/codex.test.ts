import { describe, expect, it } from "vitest";
import type { JobRecord } from "@agent-control/shared";
import { CodexAdapter } from "./codex.js";

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job-1",
    owner_id: "owner-test",
    project_id: "project",
    agent: "codex",
    mission_id: null,
    prompt: "Implement the approved change",
    tier: "implement",
    model: null,
    cursor_mode: null,
    status: "queued",
    idempotency_key: null,
    session_id: null,
    work_path: "/tmp/project",
    container_id: null,
    exit_code: null,
    error: null,
    summary: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    started_at: null,
    finished_at: null,
    timeout_sec: 600,
    ...overrides,
  };
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    job: job(),
    workPath: "/tmp/project",
    followupMessages: [],
    execution: "host" as const,
    isolationImage: "unused",
    network: "none",
    runAsUser: "1000:1000",
    readOnlyRootfs: true,
    memoryMb: 512,
    cpus: 1,
    timeoutSec: 600,
    binary: "/usr/local/bin/codex",
    model: null,
    tier: "implement",
    cursorMode: null,
    ...overrides,
  };
}

describe("CodexAdapter", () => {
  it("uses JSONL and workspace-write for implementation", () => {
    const plan = new CodexAdapter().plan(context());
    expect(plan.execution).toBe("host");
    if (plan.execution !== "host") return;
    expect(plan.hostSpec.args).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "Implement the approved change",
    ]);
  });

  it("keeps research read-only and resumes the recorded thread", () => {
    const plan = new CodexAdapter().plan(
      context({
        job: job({ session_id: "thread-123" }),
        tier: "research",
        followupMessages: ["Check the remaining question"],
      }),
    );
    if (plan.execution !== "host") return;
    expect(plan.hostSpec.args).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "read-only",
      "resume",
      "thread-123",
      "Check the remaining question",
    ]);
  });

  it("extracts thread id and final agent message from JSONL", () => {
    const plan = new CodexAdapter().plan(context());
    const output = [
      JSON.stringify({ type: "thread.started", thread_id: "thread-456" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Completed the requested work." },
      }),
      JSON.stringify({ type: "turn.completed" }),
    ].join("\n");
    expect(plan.parseSessionId?.(output, "")).toBe("thread-456");
    expect(plan.summarize?.(output, "")).toBe("Completed the requested work.");
  });
});
