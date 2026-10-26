import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  armoryBranchesWithStats,
  armoryStatusTier,
  pickArmoryNodeId,
} from "./board-armory-present.js";

describe("board-armory-present", () => {
  const nodes = [
    {
      id: "a",
      name: "Deploy relay",
      branch: "Engineering",
      status: "verified",
    },
    {
      id: "b",
      name: "Draft post",
      branch: "Publishing",
      status: "partial",
    },
    {
      id: "c",
      name: "CRM sync",
      branch: "Engineering",
      status: "not_assessed",
    },
  ];

  it("labels tiers without RPG copy", () => {
    expect(armoryStatusTier("verified")).toBe("Reliable");
    expect(armoryStatusTier("partial")).toBe("Emerging");
    expect(armoryStatusTier("not_assessed")).toBe("Not assessed");
  });

  it("groups branches with verified counts not percentages", () => {
    const stats = armoryBranchesWithStats(nodes);
    expect(stats.find((s) => s.branch === "Engineering")).toEqual({
      branch: "Engineering",
      verified: 1,
      total: 2,
    });
  });

  it("picks focal capability in branch", () => {
    expect(pickArmoryNodeId(nodes, "Engineering", "c")).toBe("c");
    expect(pickArmoryNodeId(nodes, "Engineering", null)).toBe("a");
  });
});

describe("board.html armory present markers", () => {
  const html = readFileSync(join(import.meta.dirname, "board.html"), "utf8");

  it("uses loadout focal model without progress bars", () => {
    expect(html).toContain("/* __armory_present_start__ */");
    expect(html).toContain("arm-focal");
    expect(html).not.toContain("arm-fill");
    expect(html).not.toContain("Loadout bays");
  });
});
