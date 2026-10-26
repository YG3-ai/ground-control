import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  missionIdPrefixFromWorldLabel,
  partitionWorldByRole,
  partitionWorldMissions,
  resolveWorldMissionId,
  worldEntityDisplayTitle,
  worldEntityIsInfrastructure,
  worldEntityRowMeta,
  worldHomePulseLine,
} from "./board-world-present.js";

const board = {
  missions: [
    {
      id: "0e860adc-aaaa-bbbb-cccc-ddddeeeeffff",
      title: "Build Ground's event-driven mission supervisor",
      col: "verifying",
      updated_at: "2026-10-25T12:00:00.000Z",
    },
  ],
  columns: {
    done: [
      {
        id: "02432637-1111-2222-3333-444455556666",
        title: "Older completed mission",
        status: "done",
      },
    ],
  },
};

describe("board-world-present", () => {
  it("parses mission prefix from world label", () => {
    expect(missionIdPrefixFromWorldLabel("mission 0e860adc")).toBe("0e860adc");
    expect(missionIdPrefixFromWorldLabel("jobs")).toBeNull();
  });

  it("resolves full mission id and canonical title", () => {
    const ent = {
      entity_type: "mission",
      label: "mission 0e860adc",
      state: "implementing",
    };
    expect(resolveWorldMissionId(ent, undefined, board)).toBe(
      "0e860adc-aaaa-bbbb-cccc-ddddeeeeffff",
    );
    expect(worldEntityDisplayTitle(ent, undefined, board)).toBe(
      "Build Ground's event-driven mission supervisor",
    );
  });

  it("puts active missions before completed history", () => {
    const entities = [
      {
        entity_type: "mission",
        label: "mission 02432637",
        state: "done",
        last_seen_at: "2026-10-20T00:00:00Z",
      },
      {
        entity_type: "mission",
        label: "mission 0e860adc",
        state: "implementing",
        last_seen_at: "2026-10-19T00:00:00Z",
      },
    ];
    const parts = partitionWorldMissions(entities, board);
    expect(parts.active).toHaveLength(1);
    expect(parts.history).toHaveLength(1);
    expect(worldEntityDisplayTitle(parts.active[0], undefined, board)).toContain(
      "supervisor",
    );
  });

  it("prefers board updated_at over world last_seen for mission rows", () => {
    const ent = {
      entity_type: "mission",
      label: "mission 0e860adc",
      state: "verifying",
      last_seen_at: "2026-10-24T10:00:00.000Z",
    };
    const line = worldEntityRowMeta(ent, board, (iso) => String(iso).slice(0, 10));
    expect(line).toContain("Checking");
    expect(line).toContain("updated 2026-10-25");
    expect(line).not.toContain("world index");
  });

  it("labels world index age when board mission is missing", () => {
    const ent = {
      entity_type: "mission",
      label: "mission deadbeef",
      state: "intake",
      last_seen_at: "2026-10-24T10:00:00.000Z",
    };
    const line = worldEntityRowMeta(ent, {}, (iso) => String(iso).slice(0, 10));
    expect(line).toContain("world index 2026-10-24");
  });

  it("separates infrastructure services from missions", () => {
    const entities = [
      { entity_type: "mission", label: "mission abc" },
      { entity_type: "service", label: "jobs" },
      { entity_type: "agent", label: "kimi" },
    ];
    const roles = partitionWorldByRole(entities);
    expect(roles.missions).toHaveLength(1);
    expect(roles.systems).toHaveLength(2);
    expect(worldEntityIsInfrastructure(entities[1]!)).toBe(true);
  });

  it("builds home pulse from active project names not entity counts", () => {
    const line = worldHomePulseLine(
      [
        { entity_type: "mission", label: "mission 0e860adc", state: "implementing" },
        { entity_type: "service", label: "jobs", state: null },
      ],
      board,
    );
    expect(line).toContain("supervisor");
    expect(line).not.toMatch(/\d+\s+in index/);
  });
});

describe("board.html world present markers", () => {
  const html = readFileSync(join(import.meta.dirname, "board.html"), "utf8");

  it("ships world presentation helpers in the shell", () => {
    expect(html).toContain("/* __world_present_start__ */");
    expect(html).toContain("partitionWorldMissions");
    expect(html).toContain("partitionWorldByRole");
    expect(html).toContain("codexSliceEntities");
    expect(html).toContain("codex-field");
    expect(html).toContain("codex-orbit-node");
    expect(html).toContain("world-tile");
    expect(html).toContain("worldEntityDisplayTitle");
    expect(html).not.toMatch(/rows\.slice\(0,\s*12\)/);
  });
});
