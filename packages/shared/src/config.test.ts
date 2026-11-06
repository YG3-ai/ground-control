import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";

describe("Advisor configuration", () => {
  it("preserves Advisor bounds and lets explicit advisor false override supervisor", () => {
    const config = parseConfig({
      owner: { id: "owner", display_name: "Owner" },
      relay: { url: "ws://localhost" },
      worker: {
        data_dir: "./data", policy_dir: "./policy",
        isolation: { backend: "mock-fail", image: "test", network: "none", run_as_user: "1", read_only_rootfs: true, memory_mb: 1, cpus: 1 },
      },
      supervisor: { enabled: true, queue_max_concurrent: 7 },
      advisor: { enabled: false, poll_missions_sec: 9, queue_max_concurrent: 2, job_stale_sec: 45, connection_retry_limit: 4 },
      agents: {}, projects: [],
    });
    expect(config.advisor).toMatchObject({ enabled: false, poll_missions_sec: 9, queue_max_concurrent: 2, job_stale_sec: 45, connection_retry_limit: 4 });
    expect(config.supervisor.queue_max_concurrent).toBe(7);
  });
});
