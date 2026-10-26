import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  evidenceRowView,
  evidenceVerbLabel,
  missionIdFromEvidence,
  missionIdFromEntityAliases,
  turningPointListMeta,
} from "./board-evolution-resolve.js";

function loadShippedResolve() {
  const html = readFileSync(join(import.meta.dirname, "board.html"), "utf8");
  const m = html.match(
    /\/\* __evolution_resolve_start__ \*\/([\s\S]*?)\/\* __evolution_resolve_end__ \*\//,
  );
  if (!m) throw new Error("evolution resolve block not found in board.html");
  return new Function(
    `"use strict";${m[1]}; return { missionIdFromEvidence, evidenceRowView, turningPointListMeta };`,
  )() as {
    missionIdFromEvidence: (e: Record<string, unknown>) => string | null;
    evidenceRowView: (e: Record<string, unknown>, title: string | null) => {
      actionable: boolean;
      title: string;
    };
    turningPointListMeta: (
      c: Record<string, unknown>,
      title: string | null,
    ) => string;
  };
}

describe("evolution evidence resolution", () => {
  it("resolves mission id from source_ref when object_id missing", () => {
    expect(
      missionIdFromEvidence({
        source: "missions",
        source_ref: "m-uuid-1",
        verb: "mission.status_changed",
      }),
    ).toBe("m-uuid-1");
  });

  it("builds state transition label instead of duplicating verb", () => {
    expect(
      evidenceVerbLabel({
        verb: "mission.status_changed",
        object_type: "mission",
        from_state: "implementing",
        to_state: "done",
      }),
    ).toBe("Mission implementing → done");
  });

  it("marks row actionable when mission id resolves", () => {
    const row = evidenceRowView(
      {
        source: "missions",
        source_ref: "m-1",
        object_type: "mission",
        object_id: "m-1",
        verb: "mission.status_changed",
        to_state: "done",
      },
      "Outbound polish",
    );
    expect(row.actionable).toBe(true);
    expect(row.title).toBe("Outbound polish");
    expect(row.subtitle).toContain("done");
  });

  it("non-actionable rows omit chevron semantics via actionable=false", () => {
    const row = evidenceRowView(
      { verb: "usage.limit_reached", source: "usage", source_ref: "x" },
      null,
    );
    expect(row.actionable).toBe(false);
  });

  it("entity aliases map to mission id", () => {
    expect(missionIdFromEntityAliases(["actor:owner", "mission:abc-123"])).toBe(
      "abc-123",
    );
  });

  it("turning point list meta shows proposed + mission", () => {
    expect(
      turningPointListMeta(
        { status: "proposed", proposed_description: "Job failed then completed." },
        "Life Mirror",
      ),
    ).toBe("Life Mirror · Proposed");
  });

  it("shipped board.html resolve block stays aligned", () => {
    const shipped = loadShippedResolve();
    const e = {
      source: "missions",
      source_ref: "m-1",
      object_type: "mission",
      object_id: "m-1",
      verb: "mission.status_changed",
      to_state: "done",
    };
    expect(shipped.missionIdFromEvidence(e)).toBe(missionIdFromEvidence(e));
    expect(shipped.evidenceRowView(e, "T").actionable).toBe(true);
  });
});
