import type { AgentKind, JobRecord } from "@agent-control/shared";
import type { IsolationRunSpec } from "../isolation/types.js";
import type { HostRunSpec } from "../isolation/host.js";

export interface AdapterContext {
  job: JobRecord;
  workPath: string;
  followupMessages: string[];
  execution: "host" | "docker";
  isolationImage: string;
  network: string;
  runAsUser: string;
  readOnlyRootfs: boolean;
  memoryMb: number;
  cpus: number;
  timeoutSec: number;
  /** Host binary for cursor/kimi */
  binary?: string;
  /** Resolved model id/alias for --model / -m */
  model?: string | null;
  /** research|triage|implement|bugfix */
  tier?: string | null;
  /** Cursor --mode ask|plan for cheap research passes */
  cursorMode?: "ask" | "plan" | null;
}

export type AdapterPlan =
  | {
      kind: AgentKind;
      execution: "docker";
      runSpec: IsolationRunSpec;
      parseSessionId?: (stdout: string, stderr: string) => string | null;
      summarize?: (stdout: string, stderr: string) => string;
      /** When true, do not delete/copy worktrees — use live workspace */
      liveWorkspace?: boolean;
    }
  | {
      kind: AgentKind;
      execution: "host";
      hostSpec: HostRunSpec;
      parseSessionId?: (stdout: string, stderr: string) => string | null;
      summarize?: (stdout: string, stderr: string) => string;
      liveWorkspace: true;
    };

export interface AgentAdapter {
  readonly kind: AgentKind;
  plan(ctx: AdapterContext): AdapterPlan;
  readonly acceptsLiveFollowup: boolean;
}
