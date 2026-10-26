import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  missionLampClass,
  pickWorkbenchMissionId,
  workbenchBlueprint,
  workbenchMissionQueue,
} from "./board-workbench-present.js";

describe("board-workbench-present", () => {
  it("orders queue active then blocked and keeps selection", () => {
    const active = [{ id: "a", title: "Alpha", col: "implementing" }];
    const blocked = [{ id: "b", title: "Beta", col: "blocked" }];
    const q = workbenchMissionQueue(active, blocked);
    expect(q.map((m) => m.id)).toEqual(["a", "b"]);
    expect(pickWorkbenchMissionId(q, "b")).toBe("b");
    expect(pickWorkbenchMissionId(q, "missing")).toBe("a");
  });

  it("builds blueprint from real mission fields only", () => {
    const bp = workbenchBlueprint({
      id: "1",
      col: "verifying",
      markers: { status_detail: "Running relay tests" },
      summary: "Evidence from last run",
    });
    expect(bp.status).toBe("Checking");
    expect(bp.workLine).toContain("Running relay tests");
    expect(bp.evidenceLine).toContain("Evidence");
  });

  it("maps lamp classes from column state", () => {
    expect(missionLampClass({ id: "1", col: "blocked" })).toBe("warn");
    expect(missionLampClass({ id: "2", col: "implementing" })).toBe("run");
  });
});

describe("board.html workbench present markers", () => {
  const html = readFileSync(join(import.meta.dirname, "board.html"), "utf8");

  it("ships workbench blueprint helpers", () => {
    expect(html).toContain("/* __workbench_present_start__ */");
    expect(html).toContain("workbenchBlueprint");
    expect(html).toContain("wb-blueprint");
    expect(html).toContain("wb-rail");
    expect(html).not.toContain("Active rack");
  });
});
