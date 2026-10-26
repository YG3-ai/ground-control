/**
 * Home “System pulse” copy from live board/worker/task/session state.
 * Duplicated in board.html between __system_pulse_start__ markers — keep in sync.
 */

const ACTIVE_JOB = new Set([
  "queued",
  "preparing",
  "running",
  "awaiting_followup",
  "cancelling",
]);

export type SystemPulseTask = {
  id?: string;
  status?: string;
  agent?: string;
  mission_id?: string;
};

export type SystemPulseSession = {
  state?: string;
  kind?: string;
  workspace?: string;
};

export type SystemPulseHealth = {
  worker?: boolean;
  open_terminals?: number;
};

export type SystemPulseView = {
  connected: boolean;
  headline: string;
  subline: string;
};

export type SystemCoreMode = "OFFLINE" | "ACTIVE" | "QUIET" | "ATTENTION";

export type SystemCoreView = SystemPulseView & { mode: SystemCoreMode };

export function systemPulseView(
  health: SystemPulseHealth | null | undefined,
  tasks: SystemPulseTask[] | null | undefined,
  sessions: SystemPulseSession[] | null | undefined,
  missionTitle: (missionId: string) => string,
): SystemPulseView {
  const connected = !!(health && health.worker);
  if (!connected) {
    return { connected: false, headline: "Link down", subline: "Worker not connected" };
  }

  const activeJobs = (tasks || []).filter((t) =>
    ACTIVE_JOB.has(String(t.status || "")),
  );
  const liveTerms = (sessions || []).filter((s) => s.state === "running");
  const bits: string[] = [];

  if (activeJobs.length) {
    const j = activeJobs[0]!;
    const agent = j.agent ? String(j.agent) : "Agent";
    const mid = j.mission_id ? String(j.mission_id) : "";
    const mt = mid ? missionTitle(mid) : "";
    if (mt) bits.push(agent + " · " + mt);
    else bits.push(agent + " job · " + String(j.status || "running").replace(/_/g, " "));
    if (activeJobs.length > 1) bits.push("+" + (activeJobs.length - 1) + " job");
  }
  if (liveTerms.length) {
    const s = liveTerms[0]!;
    const kind = s.kind ? String(s.kind) : "Terminal";
    const ws = s.workspace ? String(s.workspace) : "";
    bits.push(ws ? kind + " · " + ws : kind + " live");
    if (liveTerms.length > 1) bits.push("+" + (liveTerms.length - 1) + " terminal");
  }

  if (bits.length) {
    return {
      connected: true,
      headline: "System active",
      subline: bits.slice(0, 2).join(" · "),
    };
  }
  return {
    connected: true,
    headline: "System ready",
    subline: "Quiet — no jobs or live terminals",
  };
}

/** Living-system core label — derived from link, attention queue, and live ops only. */
export type SystemTopologyNode = {
  key: string;
  label: string;
  tone: "good" | "bad" | "warn" | "idle";
};

/** Relay ↔ worker ↔ live agents/sessions — labels from real link state only. */
export function systemTopologyNodes(
  health: SystemPulseHealth | null | undefined,
  tasks: SystemPulseTask[] | null | undefined,
  sessions: SystemPulseSession[] | null | undefined,
): SystemTopologyNode[] {
  const linked = !!(health && health.worker);
  const activeJobs = (tasks || []).filter((t) =>
    ACTIVE_JOB.has(String(t.status || "")),
  );
  const liveTerms = (sessions || []).filter((s) => s.state === "running");
  const agents = new Set<string>();
  for (const j of activeJobs) {
    if (j.agent) agents.add(String(j.agent));
  }
  let agentLabel = "Agents";
  let agentTone: SystemTopologyNode["tone"] = "idle";
  if (agents.size === 1) agentLabel = [...agents][0]!;
  else if (agents.size > 1) agentLabel = `${agents.size} agents`;
  if (activeJobs.length) agentTone = "good";
  else if (liveTerms.length) {
    agentLabel = liveTerms.length === 1 ? "Session" : `${liveTerms.length} sessions`;
    agentTone = "good";
  }
  return [
    { key: "relay", label: "Relay", tone: "good" },
    {
      key: "worker",
      label: linked ? "Worker" : "Worker offline",
      tone: linked ? "good" : "bad",
    },
    { key: "agents", label: agentLabel, tone: agentTone },
  ];
}

export function systemCoreView(
  health: SystemPulseHealth | null | undefined,
  tasks: SystemPulseTask[] | null | undefined,
  sessions: SystemPulseSession[] | null | undefined,
  missionTitle: (missionId: string) => string,
  attentionPending = 0,
): SystemCoreView {
  const pulse = systemPulseView(health, tasks, sessions, missionTitle);
  if (!pulse.connected) {
    return { ...pulse, mode: "OFFLINE", headline: "OFFLINE" };
  }
  if (attentionPending > 0) {
    return {
      connected: true,
      mode: "ATTENTION",
      headline: "ATTENTION",
      subline:
        attentionPending === 1
          ? "One decision waiting"
          : `${attentionPending} decisions waiting`,
    };
  }
  const activeJobs = (tasks || []).filter((t) =>
    ACTIVE_JOB.has(String(t.status || "")),
  );
  const liveTerms = (sessions || []).filter((s) => s.state === "running");
  if (activeJobs.length || liveTerms.length) {
    return { ...pulse, mode: "ACTIVE", headline: "ACTIVE" };
  }
  return {
    ...pulse,
    mode: "QUIET",
    headline: "QUIET",
    subline: pulse.subline,
  };
}
