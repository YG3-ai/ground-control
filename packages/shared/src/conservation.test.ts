import { describe, expect, it } from "vitest";
import {
  buildConservationPlan,
  DEFAULT_CONSERVATION_CONFIG,
  tierToTaskClass,
} from "./conservation.js";
import type { AppConfig } from "./types.js";

function cfg(agents: AppConfig["agents"]): AppConfig {
  return {
    owner: { id: "o", display_name: "O" },
    relay: { url: "ws://x" },
    worker: {
      data_dir: "/tmp",
      policy_dir: "/tmp",
      max_output_bytes: 1,
      default_timeout_sec: 60,
      agent_execution: "host",
      allowed_roots: ["/tmp"],
      isolation: {
        backend: "mock-fail",
        image: "x",
        network: "none",
        run_as_user: "0",
        read_only_rootfs: true,
        memory_mb: 1,
        cpus: 1,
      },
      conservation: { enabled: true },
    },
    supervisor: { enabled: false },
    agents,
    projects: [],
  };
}

describe("conservation", () => {
  it("maps tiers to task classes", () => {
    expect(tierToTaskClass("triage")).toBe("lookup_triage");
    expect(tierToTaskClass("bugfix")).toBe("implementation");
  });

  it("prefers codex for implementation when enabled", () => {
    const plan = buildConservationPlan({
      config: cfg({
        codex: { enabled: true, adapter: "codex" },
        cursor: { enabled: true, adapter: "cursor" },
      }),
      tier: "implement",
      explicitAgent: "codex",
    });
    expect(plan.agent).toBe("codex");
    expect(plan.task_class).toBe("implementation");
  });

  it("rejects explicit kimi", () => {
    expect(() =>
      buildConservationPlan({
        config: cfg({
          codex: { enabled: true, adapter: "codex" },
          cursor: { enabled: true, adapter: "cursor" },
        }),
        explicitAgent: "kimi",
      }),
    ).toThrow(/kimi_retired/);
  });
});
