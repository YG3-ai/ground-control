import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  groupProposedTurningPoints,
  homeEvolutionPreviewGroups,
  pickHomeEvolutionPreview,
  proposedReviewCount,
} from "./board-evolution-present.js";

describe("board-evolution-present", () => {
  it("prefers capability on home preview over recovery turning points", () => {
    const pick = pickHomeEvolutionPreview([
      {
        candidate_id: "cap",
        kind: "capability",
        status: "proposed",
        proposed_label: "Reliable mission delivery",
      },
      {
        candidate_id: "t1",
        kind: "turning_point",
        status: "proposed",
        proposed_label: "Recovered after failure",
      },
    ]);
    expect(pick?.title).toBe("Reliable mission delivery");
    expect(pick?.subtitle).toMatch(/Capability/);
  });

  it("groups proposed turning points by display label", () => {
    const candidates = [
      {
        candidate_id: "a",
        kind: "turning_point",
        status: "proposed",
        proposed_label: "Recovered after failure",
      },
      {
        candidate_id: "b",
        kind: "turning_point",
        status: "proposed",
        proposed_label: "Recovered after failure",
      },
      {
        candidate_id: "c",
        kind: "turning_point",
        status: "accepted",
        proposed_label: "Recovered after failure",
      },
    ];
    const groups = groupProposedTurningPoints(candidates);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe("Recovered after failure");
    expect(groups[0]?.items).toHaveLength(2);
    expect(proposedReviewCount(candidates)).toBe(2);
    expect(homeEvolutionPreviewGroups(candidates)).toEqual([
      { label: "Recovered after failure", count: 2 },
    ]);
  });
});

describe("board.html evolution present markers", () => {
  const html = readFileSync(join(import.meta.dirname, "board.html"), "utf8");

  it("ships grouping helpers and calmer evolution nav dot", () => {
    expect(html).toContain("/* __evolution_present_start__ */");
    expect(html).toContain("groupProposedTurningPoints");
    expect(html).not.toContain("lm-ground-evolution-link");
    expect(html).toContain("cap-collectible");
    expect(html).toContain("pickHomeEvolutionPreview");
    expect(html).toContain("badge-evolution");
  });
});
