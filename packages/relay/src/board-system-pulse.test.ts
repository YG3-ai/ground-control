import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { systemPulseView, systemTopologyNodes } from "./board-system-pulse.js";

describe("systemPulseView", () => {
  it("reports quiet when linked but idle", () => {
    const v = systemPulseView({ worker: true }, [], [], () => "");
    expect(v.headline).toBe("System ready");
    expect(v.subline).toMatch(/Quiet/);
  });

  it("builds relay-worker-agent topology from live state", () => {
    const nodes = systemTopologyNodes(
      { worker: true },
      [{ status: "running", agent: "kimi" }],
      [],
    );
    expect(nodes.map((n) => n.key)).toEqual(["relay", "worker", "agents"]);
    expect(nodes[2].label).toBe("kimi");
  });

  it("names active job with mission title when available", () => {
    const v = systemPulseView(
      { worker: true },
      [{ status: "running", agent: "kimi", mission_id: "m-1" }],
      [],
      () => "Ship emails",
    );
    expect(v.headline).toBe("System active");
    expect(v.subline).toContain("kimi · Ship emails");
  });
});

describe("board.html system pulse markers", () => {
  const html = readFileSync(join(import.meta.dirname, "board.html"), "utf8");

  it("ships pulse helpers and live ops section", () => {
    expect(html).toContain("/* __system_pulse_start__ */");
    expect(html).toContain("renderSystemSurface");
    expect(html).toContain("home-system-ops");
    expect(html).not.toContain("lm-ground-evolution-link");
    expect(html).toContain("systemTopologyNodes");
    expect(html).toContain("ctrl-topology");
  });
});
