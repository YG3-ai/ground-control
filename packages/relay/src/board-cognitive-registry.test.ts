import { describe, expect, it } from "vitest";
import {
  buildCognitiveHudModel,
  buildRegionReadout,
  COGNITIVE_REGIONS,
  rankFocusCandidates,
  pickVisibleLabels,
} from "./board-cognitive-registry.js";

describe("board-cognitive-registry", () => {
  it("keeps background thinking dormant", () => {
    const m = buildCognitiveHudModel({
      board: { health: { worker: true }, terminal_sessions: [{ state: "running" }] },
      owner: true,
      attention: 0,
      decisions: 0,
    });
    const bg = m.regions.find((r) => r.id === "background_thinking");
    expect(bg?.status).toBe("dormant");
  });

  it("limits mobile labels", () => {
    const m = buildCognitiveHudModel({
      board: {
        health: { worker: true },
        tasks: [{ status: "running" }],
        columns: { implementing: [{ id: "1" }] },
        terminal_sessions: [{ state: "running", kind: "cursor" }],
      },
      owner: true,
      attention: 1,
      decisions: 0,
    });
    expect(pickVisibleLabels(m, true).length).toBeLessThanOrEqual(3);
  });

  it("has extensible region registry", () => {
    expect(COGNITIVE_REGIONS.length).toBeGreaterThanOrEqual(8);
  });

  it("builds compact region readout from real state", () => {
    const model = buildCognitiveHudModel({
      board: {
        health: { worker: true },
        tasks: [{ status: "running" }],
        columns: { implementing: [{ id: "1" }] },
      },
      owner: true,
      attention: 2,
      decisions: 0,
    });
    const ro = buildRegionReadout("executive", { board: {}, owner: true, attention: 2, decisions: 0, model });
    expect(ro.name).toBe("Executive");
    expect(ro.state).toBe("ACTIVE");
    expect(ro.fact).toBe("2 pending");
  });

  it("ranks active before waiting for focus cycle", () => {
    const regions = [
      { id: "a", label: "A", shortLabel: "A", anchor: { x: 0, y: 0 }, status: "waiting" as const, glow: 0.7 },
      { id: "b", label: "B", shortLabel: "B", anchor: { x: 0, y: 0 }, status: "active" as const, glow: 1 },
    ];
    expect(rankFocusCandidates(regions, 0, {})[0].id).toBe("b");
  });
});
