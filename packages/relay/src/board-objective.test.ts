import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The current-objective selection lives in the inline JS of board.html (the
 * file served to phones and hot-reloaded by the relay). These tests extract
 * the exact shipped priority block between the __objective_priority_start__
 * / __objective_priority_end__ markers and evaluate it, so the test fails if
 * the served logic regresses — not just a copy of it.
 */
function loadObjectivePriority() {
  const html = readFileSync(join(import.meta.dirname, "board.html"), "utf8");
  const m = html.match(
    /\/\* __objective_priority_start__ \*\/([\s\S]*?)\/\* __objective_priority_end__ \*\//,
  );
  if (!m) throw new Error("objective priority block not found in board.html");
  return new Function(
    `"use strict";${m[1]}; return { missionObjectiveRank, sortByObjectivePriority };`,
  )() as {
    missionObjectiveRank: (m: { status?: string; col?: string }) => number;
    sortByObjectivePriority: <T>(rows: T[]) => T[];
  };
}

type Row = {
  id: string;
  status: string;
  col: string;
  updated_at: string;
  markers?: Record<string, unknown>;
};

function row(id: string, status: string, updated_at: string): Row {
  return { id, status, col: status, updated_at };
}

describe("board current-objective priority", () => {
  const { sortByObjectivePriority } = loadObjectivePriority();

  it("a verifying mission beats a newer intake-only mission", () => {
    const intakeOnly = {
      ...row("intake-1", "intake", "2026-10-24T15:53:51Z"),
      markers: { mode: "intake only", execution_started: false },
    };
    const verifying = row("verify-1", "verifying", "2026-10-24T15:41:39Z");
    // intake column is listed first in ACTIVE_COLS; the sort must still win.
    expect(sortByObjectivePriority([intakeOnly, verifying])[0]?.id).toBe("verify-1");
  });

  it("implementing also beats intake", () => {
    const sorted = sortByObjectivePriority([
      row("intake-1", "intake", "2026-10-24T16:00:00Z"),
      row("impl-1", "implementing", "2026-10-24T10:00:00Z"),
    ]);
    expect(sorted[0]?.id).toBe("impl-1");
  });

  it("approved/plan_ready/researching sit between execution and intake", () => {
    const sorted = sortByObjectivePriority([
      row("intake-1", "intake", "2026-10-24T16:00:00Z"),
      row("research-1", "researching", "2026-10-24T11:00:00Z"),
      row("approved-1", "approved", "2026-10-24T11:30:00Z"),
      row("plan-1", "plan_ready", "2026-10-24T11:15:00Z"),
    ]);
    expect(sorted.map((r) => r.id)).toEqual([
      "approved-1",
      "plan-1",
      "research-1",
      "intake-1",
    ]);
  });

  it("within a tier, most recently updated wins", () => {
    const sorted = sortByObjectivePriority([
      row("impl-old", "implementing", "2026-10-24T10:00:00Z"),
      row("impl-new", "implementing", "2026-10-24T12:00:00Z"),
    ]);
    expect(sorted[0]?.id).toBe("impl-new");
  });

  it("does not mutate the input array", () => {
    const input = [row("a", "intake", "2026-10-24T16:00:00Z"), row("b", "verifying", "2026-10-24T10:00:00Z")];
    const sorted = sortByObjectivePriority(input);
    expect(input[0]?.id).toBe("a");
    expect(sorted).not.toBe(input);
  });
});
