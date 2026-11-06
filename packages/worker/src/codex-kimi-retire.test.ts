import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KIMI_RETIRED_MESSAGE, assertAgentAllowedForNewWork } from "@agent-control/shared";
import { WorkerService } from "./service.js";
import { buildTestConfig, initGitFixture } from "./test-utils.js";

describe("kimi retirement", () => {
  it("rejects kimi start_task", () => {
    const root = mkdtempSync(join(tmpdir(), "ac-kimi-"));
    const fixture = join(root, "fixture");
    mkdirSync(fixture, { recursive: true });
    initGitFixture(fixture);
    const config = buildTestConfig(root, fixture);
    config.worker.agent_execution = "host";
    config.agents.kimi = { enabled: true, adapter: "kimi" };
    config.agents.codex = { enabled: true, adapter: "codex", binary: "/bin/echo" };
    const service = new WorkerService({
      config,
      dbPath: join(root, "data", "worker", "jobs.db"),
      configRoot: root,
    });
    expect(() =>
      service.startTask({
        ownerId: "owner-test",
        agent: "kimi",
        workspace: fixture,
        prompt: "nope",
      }),
    ).toThrow(KIMI_RETIRED_MESSAGE);
    service.close();
  });

  it("rejects kimi terminal sessions", () => {
    const root = mkdtempSync(join(tmpdir(), "ac-kimi-"));
    const fixture = join(root, "fixture");
    mkdirSync(fixture, { recursive: true });
    initGitFixture(fixture);
    const config = buildTestConfig(root, fixture);
    config.worker.agent_execution = "host";
    config.agents.codex = { enabled: true, adapter: "codex" };
    const service = new WorkerService({
      config,
      dbPath: join(root, "data", "worker", "jobs.db"),
      configRoot: root,
    });
    expect(() =>
      service.createTerminalSession({
        ownerId: "owner-test",
        kind: "kimi",
        workspace: fixture,
      }),
    ).toThrow(/kimi_retired/);
    service.close();
  });
});

describe("agent gate", () => {
  it("blocks kimi at gate", () => {
    const config = buildTestConfig("/tmp", "/tmp");
    expect(() => assertAgentAllowedForNewWork(config, "kimi")).toThrow(
      /kimi_retired/,
    );
  });
});
