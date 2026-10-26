import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  boardShowsWorkerOffline,
  isAuditLikeProse,
  missionHeroSubtitle,
  missionHomeSubline,
  profileOrientationFromTitle,
  profilePurposeFromNoteBody,
} from "./board-home-mission.js";

function loadShippedMissionHomeSubline() {
  const html = readFileSync(join(import.meta.dirname, "board.html"), "utf8");
  const m = html.match(
    /\/\* __mission_home_line_start__ \*\/([\s\S]*?)\/\* __mission_home_line_end__ \*\//,
  );
  if (!m) throw new Error("mission home line block not found in board.html");
  return new Function(
    `"use strict";${m[1]}; return missionHomeSubline;`,
  )() as (m: Record<string, unknown>) => string | null;
}

function loadShippedBoardWorkerOffline() {
  const html = readFileSync(join(import.meta.dirname, "board.html"), "utf8");
  const m = html.match(
    /\/\* __board_worker_offline_start__ \*\/([\s\S]*?)\/\* __board_worker_offline_end__ \*\//,
  );
  if (!m) throw new Error("board worker offline block not found in board.html");
  return new Function(
    `"use strict";${m[1]}; return boardShowsWorkerOffline;`,
  )() as (
    board: { error?: string; health?: { worker?: boolean } } | null,
    world: { ok?: boolean } | null,
  ) => boolean;
}

describe("board worker offline presentation", () => {
  const shipped = loadShippedBoardWorkerOffline();

  it("matches shipped board.html helper", () => {
    const board = { error: "worker_offline" as const };
    const world = { ok: true };
    expect(shipped(board, world)).toBe(boardShowsWorkerOffline(board, world));
  });

  it("suppresses offline when world index is live", () => {
    expect(boardShowsWorkerOffline({ error: "worker_offline" }, { ok: true })).toBe(
      false,
    );
  });

  it("shows offline when board stub has no contradicting feeds", () => {
    expect(boardShowsWorkerOffline({ error: "worker_offline" }, null)).toBe(true);
  });
});

describe("mission hero subtitle", () => {
  it("uses board status and goal, not PM markers", () => {
    expect(
      missionHeroSubtitle({
        col: "implementing",
        goal: "Calm owner cockpit for decisions",
        markers: { status_detail: "implementing visual simplicity pass" },
      }),
    ).toBe("Building · Calm owner cockpit for decisions");
  });
});

describe("mission home subline", () => {
  it("prefers status_detail marker over audit summary", () => {
    const m = {
      summary: "Meta audit: packages/relay/src/board.html checkpoint GO",
      markers: { status_detail: "Ship owner home copy before worker GO" },
    };
    expect(missionHomeSubline(m)).toBe("Ship owner home copy before worker GO");
  });

  it("skips audit-like summary and uses plan step", () => {
    const m = {
      summary: "Phase 4 audit — verify-board-shell and public_preview fixes",
      plan: "1) Fix session restore\n2) Polish home identity",
      markers: { current_step: 2 },
    };
    expect(missionHomeSubline(m)).toBe("2) Polish home identity");
  });

  it("uses findings when markers absent", () => {
    expect(
      missionHomeSubline({
        findings: "Reply rate flat; test two subject lines this week.",
        summary: "audit checkpoint",
      }),
    ).toBe("Reply rate flat; test two subject lines this week.");
  });

  it("shipped board.html block stays aligned", () => {
    const shipped = loadShippedMissionHomeSubline();
    const sample = {
      markers: { status_detail: "Waiting on owner GO for worker" },
      summary: "ignored audit text",
    };
    expect(shipped(sample)).toBe(missionHomeSubline(sample));
  });
});

describe("audit-like prose", () => {
  it("flags meta audit phrasing", () => {
    expect(isAuditLikeProse("Meta audit for Phase 4 board shell")).toBe(true);
    expect(isAuditLikeProse("Raise outbound reply rate 10%")).toBe(false);
  });
});

describe("profile orientation from title", () => {
  it("strips dossier prefix and uses the personal name", () => {
    expect(profileOrientationFromTitle("Second Brain Dossier — Partha")).toEqual({
      name: "Partha",
    });
    expect(profileOrientationFromTitle("Life Mirror — Ada")).toEqual({
      name: "Ada",
      descriptor: "Life Mirror",
    });
  });

  it("falls back to You when title empty", () => {
    expect(profileOrientationFromTitle("")).toEqual({ name: "You" });
  });
});

describe("profile purpose from brain note", () => {
  it("skips audit paragraphs and picks the next", () => {
    const body = `# Owner

Meta audit of Ground Life Mirror Phase 4.

Build a calm owner cockpit for decisions and missions.`;
    expect(profilePurposeFromNoteBody(body)).toBe(
      "Build a calm owner cockpit for decisions and missions.",
    );
  });
});
