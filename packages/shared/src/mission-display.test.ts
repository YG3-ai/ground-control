import { describe, expect, it } from "vitest";
import {
  buildNeedsYouRail,
  deriveMissionDeliveryPresentation,
  presentBlockReason,
} from "./mission-display.js";

describe("deriveMissionDeliveryPresentation", () => {
  it("shows verifying without an active supervisor job", () => {
    const p = deriveMissionDeliveryPresentation(
      {
        id: "m1",
        status: "verifying",
        markers: { supervision_state: "idle", project_active: true },
      },
      { queue_state: "verifying" },
      false,
    );
    expect(p.display_state).toBe("verifying");
    expect(p.has_active_supervisor_job).toBe(false);
    expect(p.needs_owner).toBe(false);
  });

  it("surfaces ready_for_review owner action on the Needs You rail", () => {
    const p = deriveMissionDeliveryPresentation(
      { id: "m2", status: "ready_for_review", markers: {} },
      { queue_state: "ready_for_review" },
      false,
    );
    expect(p.needs_owner).toBe(true);
    expect(p.next_owner_action).toMatch(/Review the implementation/i);
    const rail = buildNeedsYouRail([
      { id: "m2", title: "Review me", status: "ready_for_review", ...p },
    ]);
    expect(rail).toHaveLength(1);
    expect(rail[0]?.display_state).toBe("ready_for_review");
  });

  it("marks blocked missions as needing the owner", () => {
    const p = deriveMissionDeliveryPresentation(
      {
        id: "m3",
        status: "blocked",
        markers: { block_reason: "step cancelled; waiting for an explicit resume" },
      },
      { queue_state: "blocked" },
      false,
    );
    expect(p.display_state).toBe("blocked");
    expect(p.needs_owner).toBe(true);
    expect(p.blocker).toContain("explicit resume");
  });

  it("prefers waiting supervision over stale implementing status", () => {
    const p = deriveMissionDeliveryPresentation(
      {
        id: "m4",
        status: "implementing",
        markers: { supervision_state: "waiting", supervision_wait_reason: "min_gap" },
      },
      { queue_state: "running" },
      false,
    );
    expect(p.display_state).toBe("waiting");
  });

  it("ignores stale queue ready_for_review when mission is done", () => {
    const p = deriveMissionDeliveryPresentation(
      { id: "m5", status: "done", markers: { review_state: "ready_for_review" } },
      { queue_state: "ready_for_review" },
      false,
    );
    expect(p.display_state).toBe("done");
    expect(p.needs_owner).toBe(false);
  });

  it("makes compact acceptance failure identifiers actionable without exposing them as copy", () => {
    const presentation = presentBlockReason(
      "acceptance_terminal_not_review failed after 2 retries",
    );
    expect(presentation?.summary).toBe("An automated verification step failed.");
    expect(presentation?.owner_step).toMatch(/job output.*failing check/i);
    expect(presentation?.technical).toContain("acceptance_terminal_not_review");
  });
});
