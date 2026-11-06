import type { AgentKind, AppConfig } from "./types.js";
import { isAgentEnabled } from "./config.js";

export const KIMI_RETIRED_MESSAGE =
  "kimi_retired: Kimi is retired for new work. Use codex or cursor. Historical Kimi jobs remain readable.";

/** Kimi adapter files stay installed; only new orchestration is blocked. */
export function isKimiNewWorkBlocked(_config?: AppConfig): boolean {
  return true;
}

export function assertAgentAllowedForNewWork(
  config: AppConfig,
  agent: AgentKind,
): void {
  if (agent === "kimi" && isKimiNewWorkBlocked(config)) {
    throw new Error(KIMI_RETIRED_MESSAGE);
  }
  if (!isAgentEnabled(config, agent)) {
    throw new Error(`agent not enabled: ${agent}`);
  }
}

/** Map legacy mission steps / callers that still say kimi → codex (never auto-fallback to kimi). */
export function normalizeHostAgentForNewWork(
  agent: AgentKind | undefined,
  config: AppConfig,
): AgentKind {
  if (!agent || agent === "mock") return agent ?? "mock";
  if (agent === "kimi") {
    if (isAgentEnabled(config, "codex")) return "codex";
    if (isAgentEnabled(config, "cursor")) return "cursor";
    throw new Error(KIMI_RETIRED_MESSAGE);
  }
  return agent;
}
