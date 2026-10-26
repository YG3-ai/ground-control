import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  codexNeighborsForCenter,
  codexOrbitPoints,
  pickDefaultCodexCenterId,
} from "./board-codex-present.js";

describe("board-codex-present", () => {
  it("places orbit nodes on a circle", () => {
    const pts = codexOrbitPoints(4, 100, 100, 50);
    expect(pts).toHaveLength(4);
    expect(pts[0].y).toBeLessThan(100);
  });

  it("prefers active mission as default center", () => {
    const id = pickDefaultCodexCenterId(
      [
        { entity_id: "m1", entity_type: "mission", label: "mission deadbeef", state: "done" },
        { entity_id: "m2", entity_type: "mission", label: "mission 0e860adc", state: "implementing" },
      ],
      {
        missions: [
          {
            id: "0e860adc-aaaa-bbbb-cccc-ddddeeeeffff",
            title: "Active",
            col: "implementing",
          },
        ],
      },
    );
    expect(id).toBe("m2");
  });

  it("walks real relations for neighbors", () => {
    const entities = new Map([
      ["a", { entity_id: "a", entity_type: "mission", label: "jobs" }],
      ["b", { entity_id: "b", entity_type: "service", label: "relay" }],
    ]);
    const neighbors = codexNeighborsForCenter(
      "a",
      [{ kind: "served_by", from_entity: "a", to_entity: "b" }],
      entities,
    );
    expect(neighbors).toHaveLength(1);
    expect(neighbors[0].kind).toBe("served_by");
  });
});

describe("board.html codex present markers", () => {
  const html = readFileSync(join(import.meta.dirname, "board.html"), "utf8");

  it("uses entity-centered constellation helpers", () => {
    expect(html).toContain("/* __codex_present_start__ */");
    expect(html).toContain("codexNeighborsForCenter");
    expect(html).toContain("codexCenterId");
    expect(html).not.toContain("Entity graph");
  });
});
