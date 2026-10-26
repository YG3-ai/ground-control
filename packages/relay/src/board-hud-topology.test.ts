import { describe, expect, it } from "vitest";
import { buildHudTopology } from "./board-hud-topology.js";

describe("board-hud-topology", () => {
  it("redacts slot names for public preview", () => {
    const topo = buildHudTopology(
      {
        health: { worker: true },
        terminal_sessions: [
          { id: "a", state: "running", workspace: "/Users/o/secret-project", kind: "cursor" },
        ],
      },
      { owner: false, maxSatellites: 5 },
    );
    const slot = topo.satellites.find((n) => n.kind === "slot");
    expect(slot?.label).toBe("S1");
    expect(slot?.status).toBe("running");
  });

  it("shows workspace basename for owner", () => {
    const topo = buildHudTopology(
      {
        health: { worker: true },
        terminal_sessions: [
          { id: "a", state: "waiting", workspace: "/Users/o/proj", kind: "cursor" },
        ],
      },
      { owner: true, maxSatellites: 5 },
    );
    const slot = topo.satellites.find((n) => n.kind === "slot");
    expect(slot?.label).toBe("proj");
    expect(slot?.status).toBe("waiting");
  });

  it("caps satellites on mobile budget", () => {
    const topo = buildHudTopology(
      {
        health: { worker: true },
        terminal_sessions: [
          { id: "1", state: "running" },
          { id: "2", state: "running" },
          { id: "3", state: "waiting" },
        ],
      },
      { owner: true, maxSatellites: 5 },
    );
    expect(topo.satellites.length).toBeLessThanOrEqual(5);
  });
});
