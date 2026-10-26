import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  archiveChronicleItems,
  archiveMonthLabel,
  archiveReviewGroups,
} from "./board-archive-present.js";

describe("board-archive-present", () => {
  it("formats month chapters", () => {
    expect(archiveMonthLabel("2026-10-25T12:00:00.000Z")).toBe("October 2026");
  });

  it("separates confirmed chronicle from proposed review", () => {
    const items = archiveChronicleItems([
      {
        candidate_id: "1",
        kind: "turning_point",
        status: "accepted",
        proposed_label: "Shipped",
        updated_at: "2026-10-01T00:00:00Z",
      },
      {
        candidate_id: "2",
        kind: "turning_point",
        status: "proposed",
        proposed_label: "Maybe",
      },
    ]);
    expect(items).toHaveLength(1);
    const groups = archiveReviewGroups([
      {
        candidate_id: "2",
        kind: "turning_point",
        status: "proposed",
        proposed_label: "Maybe",
      },
    ]);
    expect(groups[0].label).toBe("Maybe");
  });
});

describe("board.html archive present markers", () => {
  const html = readFileSync(join(import.meta.dirname, "board.html"), "utf8");

  it("ships archive chronicle helpers", () => {
    expect(html).toContain("/* __archive_present_start__ */");
    expect(html).toContain("archiveChronicleItems");
    expect(html).toContain("evo-chronicle");
  });
});
