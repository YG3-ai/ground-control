/**
 * Terminal / agent session activity — duplicated in board.html suit + home blocks.
 */

export type TerminalSessionRow = {
  state?: string;
  kind?: string;
  last_activity_at?: string;
};

const ACTIVE_AGENT_KIND = new Set(["cursor", "kimi", "agent", "claude"]);

/** Staleness window for agent PTY cognitive activity (worker last_activity_at). */
export const COGNITIVE_TERMINAL_ACTIVITY_MS = 120_000;

/** Genuinely active agent work (not idle shells waiting on a PTY). */
export function isActiveAgentSession(session: TerminalSessionRow): boolean {
  if (session.state !== "running") return false;
  const kind = String(session.kind || "").toLowerCase();
  return ACTIVE_AGENT_KIND.has(kind);
}

export function openTerminalSessions(
  sessions: TerminalSessionRow[] | null | undefined,
): TerminalSessionRow[] {
  return (sessions || []).filter((s) => s.state !== "exited");
}

export function isCognitivelyActiveTerminal(
  session: TerminalSessionRow,
  nowMs = Date.now(),
  maxAgeMs = COGNITIVE_TERMINAL_ACTIVITY_MS,
): boolean {
  if (!isActiveAgentSession(session)) return false;
  const at = session.last_activity_at;
  if (!at) return false;
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return false;
  return nowMs - t >= 0 && nowMs - t <= maxAgeMs;
}

export function countCognitivelyActiveTerminals(
  sessions: TerminalSessionRow[] | null | undefined,
  nowMs = Date.now(),
): number {
  return openTerminalSessions(sessions).filter((s) =>
    isCognitivelyActiveTerminal(s, nowMs),
  ).length;
}

export type GroundSessionSummary = {
  active: number;
  idle: number;
  terminalsOpen: number;
  jobs: number;
};

export function summarizeGroundSessions(
  sessions: TerminalSessionRow[] | null | undefined,
  activeJobCount: number,
): GroundSessionSummary {
  const open = openTerminalSessions(sessions);
  const active = countCognitivelyActiveTerminals(sessions);
  return {
    active,
    idle: Math.max(0, open.length - active),
    terminalsOpen: open.length,
    jobs: activeJobCount,
  };
}
