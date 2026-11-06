import type { AgentKind } from "@agent-control/shared";

const HOST_AGENTS = new Set<AgentKind>(["cursor", "kimi", "codex"]);

export function isHostManagedAgent(agent: AgentKind): boolean {
  return HOST_AGENTS.has(agent);
}

export function hostBinaryFallback(agent: AgentKind): string {
  if (agent === "cursor") return "agent";
  if (agent === "codex") return "codex";
  return "kimi";
}
