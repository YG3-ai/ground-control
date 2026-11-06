import { describe, expect, it } from "vitest";
import {
  buildMissionQueueRows,
  missionQueueDetailLine,
  missionQueueStatusLabel,
} from "./board-mission-queue.js";

describe("board mission queue", () => {
  it("labels queue states for the Ground HUD", () => {
    expect(missionQueueStatusLabel("ready_for_review")).toBe("Ready for review");
    expect(missionQueueStatusLabel("queued")).toBe("Queued");
  });

  it("keeps raw blocker text out of the owner-facing detail line", () => {
    const line = missionQueueDetailLine({
      id: "1",
      mission_id: "m",
      queue_state: "blocked",
      blocker_detail: "waiting on mission x",
    });
    expect(line).toBeNull();
  });

  it("uses truthful display_state labels on queue rows", () => {
    const rows = buildMissionQueueRows([
      {
        id: "e1",
        mission_id: "m1",
        mission_title: "Alpha",
        queue_state: "running",
        display_state: "verifying",
        display_state_label: "Verifying",
      },
    ]);
    expect(rows[0]?.statusLabel).toBe("Verifying");
  });

  it("puts plain blocker copy and the supported next action on a blocked queue card", () => {
    const rows = buildMissionQueueRows([{
      id: "e1", mission_id: "m1", mission_title: "Alpha", queue_state: "blocked",
      blocker_detail: "acceptance_terminal_not_review failed after 2 retries",
    }]);
    expect(rows[0]).toMatchObject({
      detailLabel: "An automated verification step failed.",
      technicalDetail: "acceptance_terminal_not_review failed after 2 retries",
    });
    expect(rows[0]?.kind === "mission" && rows[0].ownerActionLabel).toMatch(/job output/i);
  });
});
