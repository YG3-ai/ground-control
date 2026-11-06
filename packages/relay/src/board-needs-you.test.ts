import { describe, expect, it } from "vitest";
import { buildNeedsYouGroundRows } from "./board-needs-you.js";

describe("board needs you rail", () => {
  it("maps owner actions into Ground mission rows", () => {
    const rows = buildNeedsYouGroundRows([
      {
        mission_id: "m1",
        title: "Ship",
        display_state: "ready_for_review",
        display_state_label: "Ready for review",
        next_owner_action: "Review the implementation and authorize release when satisfied.",
        blocker: null,
      },
    ]);
    expect(rows[0]?.statusLabel).toBe("Ready for review");
    expect(rows[0]?.detailLabel).toMatch(/Review the implementation/i);
  });
});
