import { describe, expect, it } from "vitest";
import {
  countCognitivelyActiveTerminals,
  isActiveAgentSession,
  isCognitivelyActiveTerminal,
  summarizeGroundSessions,
} from "./board-session-activity.js";

describe("isActiveAgentSession", () => {
  it("counts running cursor/kimi agent sessions only", () => {
    expect(isActiveAgentSession({ state: "running", kind: "cursor" })).toBe(true);
    expect(isActiveAgentSession({ state: "waiting", kind: "cursor" })).toBe(false);
    expect(isActiveAgentSession({ state: "running", kind: "shell" })).toBe(false);
  });
});

describe("isCognitivelyActiveTerminal", () => {
  const now = Date.parse("2026-03-22T12:00:00.000Z");
  it("requires recent last_activity_at on running agent sessions", () => {
    const recent = new Date(now - 10_000).toISOString();
    const stale = new Date(now - 600_000).toISOString();
    expect(isCognitivelyActiveTerminal({ state: "running", kind: "cursor", last_activity_at: recent }, now)).toBe(true);
    expect(isCognitivelyActiveTerminal({ state: "running", kind: "cursor", last_activity_at: stale }, now)).toBe(false);
    expect(countCognitivelyActiveTerminals([{ state: "running", kind: "cursor", last_activity_at: stale }], now)).toBe(0);
  });
});

describe("summarizeGroundSessions", () => {
  const recent = new Date(Date.now() - 30_000).toISOString();

  it("splits cognitively active agents from open idle terminals and jobs", () => {
    const summary = summarizeGroundSessions(
      [
        { state: "running", kind: "cursor", last_activity_at: recent },
        { state: "running", kind: "cursor" },
        { state: "running", kind: "shell" },
        { state: "waiting", kind: "shell" },
        { state: "running", kind: "shell" },
        { state: "waiting", kind: "shell" },
      ],
      0,
    );
    expect(summary).toEqual({
      active: 1,
      idle: 5,
      terminalsOpen: 6,
      jobs: 0,
    });
  });
});
