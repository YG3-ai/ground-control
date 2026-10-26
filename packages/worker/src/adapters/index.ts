import type { AgentKind } from "@agent-control/shared";
import type { AgentAdapter } from "./types.js";
import { MockAdapter } from "./mock.js";
import { CursorAdapter } from "./cursor.js";
import { KimiAdapter } from "./kimi.js";

const adapters: Record<AgentKind, AgentAdapter> = {
  mock: new MockAdapter(),
  cursor: new CursorAdapter(),
  kimi: new KimiAdapter(),
};

export function getAdapter(kind: AgentKind): AgentAdapter {
  const a = adapters[kind];
  if (!a) throw new Error(`unknown adapter: ${kind}`);
  return a;
}

export type { AgentAdapter, AdapterContext, AdapterPlan } from "./types.js";
