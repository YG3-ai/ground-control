import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function loadBoardPollScheduler() {
  const html = readFileSync(join(import.meta.dirname, "board.html"), "utf8");
  const m = html.match(
    /\/\* __board_poll_start__ \*\/([\s\S]*?)\/\* __board_poll_end__ \*\//,
  );
  if (!m) throw new Error("board poll block not found in board.html");
  return new Function(
    `"use strict";${m[1]}; return { boardPollDelayMs, notePollSuccess, notePollOffline, POLL_VISIBLE_MS, POLL_OFFLINE_BASE_MS, POLL_OFFLINE_MAX_MS, get pollOfflineBackoffMs(){ return pollOfflineBackoffMs; }, set pollOfflineBackoffMs(v){ pollOfflineBackoffMs = v; } };`,
  )() as {
    boardPollDelayMs: (visible: boolean, offline: boolean) => number;
    notePollSuccess: () => void;
    notePollOffline: () => void;
    POLL_VISIBLE_MS: number;
    POLL_OFFLINE_BASE_MS: number;
    POLL_OFFLINE_MAX_MS: number;
    pollOfflineBackoffMs: number;
  };
}

describe("board poll scheduler (shipped board.html)", () => {
  it("uses a conservative visible interval", () => {
    const s = loadBoardPollScheduler();
    expect(s.POLL_VISIBLE_MS).toBeGreaterThanOrEqual(10_000);
    expect(s.boardPollDelayMs(true, false)).toBe(s.POLL_VISIBLE_MS);
  });

  it("does not schedule while hidden", () => {
    const s = loadBoardPollScheduler();
    expect(s.boardPollDelayMs(false, false)).toBe(0);
  });

  it("applies exponential backoff after offline", () => {
    const s = loadBoardPollScheduler();
    s.pollOfflineBackoffMs = 0;
    s.notePollOffline();
    expect(s.pollOfflineBackoffMs).toBe(s.POLL_OFFLINE_BASE_MS);
    expect(s.boardPollDelayMs(true, true)).toBe(s.POLL_OFFLINE_BASE_MS);
    s.notePollOffline();
    expect(s.pollOfflineBackoffMs).toBe(s.POLL_OFFLINE_BASE_MS * 2);
    s.notePollSuccess();
    expect(s.pollOfflineBackoffMs).toBe(0);
  });

  it("caps offline backoff", () => {
    const s = loadBoardPollScheduler();
    s.pollOfflineBackoffMs = s.POLL_OFFLINE_MAX_MS;
    s.notePollOffline();
    expect(s.pollOfflineBackoffMs).toBe(s.POLL_OFFLINE_MAX_MS);
  });
});
