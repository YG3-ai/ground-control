import { describe, expect, it } from "vitest";
import {
  collectGroundProjectHistory,
  parseMissionHistoryDetail,
  missionHistoryDetailAllowed,
} from "./board-ground-history.js";

describe("collectGroundProjectHistory", () => {
  it("includes only done and cancelled, newest first", () => {
    const rows = collectGroundProjectHistory(
      {
        columns: {
          done: [
            { id: "old", title: "Old ship", status: "done", completed_at: "2026-01-01T00:00:00Z" },
          ],
          cancelled: [
            {
              id: "new",
              title: "Recent cancel",
              status: "cancelled",
              updated_at: "2026-03-01T00:00:00Z",
            },
          ],
          implementing: [{ id: "open", title: "Still open", status: "implementing" }],
        },
      },
      Date.parse("2026-03-22T12:00:00Z"),
    );
    expect(rows.map((r) => r.id)).toEqual(["new", "old"]);
    expect(rows[0]?.statusLabel).toBe("Cancelled");
  });
});

describe("parseMissionHistoryDetail", () => {
  it("derives sections from summary and markers without inventing claims", () => {
    const detail = parseMissionHistoryDetail({
      id: "m1",
      title: "HUD polish",
      status: "done",
      completed_at: "2026-02-01T12:00:00Z",
      summary: "Shipped calmer home readout.",
      findings: "Removed duplicate control path.",
      markers: { verification: "npm test green" },
    });
    expect(detail.outcome).toContain("Shipped");
    expect(detail.whatChanged).toContain("Removed");
    expect(detail.verification).toBe("npm test green");
    expect(detail.statusLine).toMatch(/Completed/);
  });

  it("uses concise fallback when fields are missing", () => {
    const detail = parseMissionHistoryDetail({
      id: "m2",
      title: "Quiet",
      status: "cancelled",
    });
    expect(detail.outcome).toMatch(/set aside/i);
    expect(detail.whatChanged).toMatch(/No change log/);
  });
});

describe("missionHistoryDetailAllowed", () => {
  it("blocks public preview from mission bodies", () => {
    expect(missionHistoryDetailAllowed(true, false)).toBe(true);
    expect(missionHistoryDetailAllowed(true, true)).toBe(false);
    expect(missionHistoryDetailAllowed(false, false)).toBe(false);
  });
});
