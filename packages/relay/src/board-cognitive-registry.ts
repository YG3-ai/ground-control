/**
 * Declarative cognitive regions for HOME full-viewport HUD (duplicated in board.html).
 */

export type CognitiveRegionStatus =
  | "active"
  | "waiting"
  | "idle"
  | "offline"
  | "dormant";

export type CognitiveRegionDef = {
  id: string;
  label: string;
  shortLabel: string;
  /** Anatomical anchor on stock brain art, normalized 0–1 */
  anchor: { x: number; y: number };
  /** Future passive layer — never faked active */
  dormant?: boolean;
  effectorParent?: string;
};

export const COGNITIVE_REGIONS: CognitiveRegionDef[] = [
  { id: "perception", label: "Perception", shortLabel: "INTAKE", anchor: { x: 0.68, y: 0.2 } },
  { id: "working_memory", label: "Working memory", shortLabel: "CONTEXT", anchor: { x: 0.52, y: 0.3 } },
  { id: "processing", label: "Processing", shortLabel: "PROCESS", anchor: { x: 0.48, y: 0.4 } },
  { id: "executive", label: "Executive", shortLabel: "EXEC", anchor: { x: 0.36, y: 0.26 } },
  {
    id: "long_term_memory",
    label: "Long-term memory",
    shortLabel: "MEMORY",
    anchor: { x: 0.26, y: 0.52 },
  },
  { id: "world_model", label: "World model", shortLabel: "WORLD", anchor: { x: 0.62, y: 0.55 } },
  { id: "meaning", label: "Meaning", shortLabel: "MEANING", anchor: { x: 0.34, y: 0.66 } },
  { id: "execution", label: "Execution", shortLabel: "EXECUTE", anchor: { x: 0.54, y: 0.7 } },
  { id: "homeostasis", label: "Homeostasis", shortLabel: "SYSTEM", anchor: { x: 0.5, y: 0.82 } },
  {
    id: "background_thinking",
    label: "Background",
    shortLabel: "BG",
    anchor: { x: 0.2, y: 0.38 },
    dormant: true,
  },
];

const ACTIVE_TASK = new Set([
  "queued",
  "preparing",
  "running",
  "awaiting_followup",
  "cancelling",
]);

export type CognitiveRegionView = {
  id: string;
  label: string;
  shortLabel: string;
  anchor: { x: number; y: number };
  status: CognitiveRegionStatus;
  glow: number;
};

export type CognitiveEffectorView = {
  id: string;
  label: string;
  status: CognitiveRegionStatus;
  parentId: string;
};

export type CognitiveHudModel = {
  regions: CognitiveRegionView[];
  effectors: CognitiveEffectorView[];
  energyPaths: Array<{ from: string; to: string; strength: number }>;
  primaryRegionId: string | null;
};

type BoardCtx = {
  board: Record<string, unknown> | null | undefined;
  owner: boolean;
  attention: number;
  decisions: number;
};

function tasks(board: Record<string, unknown> | null | undefined): unknown[] {
  if (!board) return [];
  return (board.tasks || board.active_tasks || []) as unknown[];
}

function sessions(board: Record<string, unknown> | null | undefined): Array<Record<string, unknown>> {
  if (!board) return [];
  return (board.terminal_sessions || []) as Array<Record<string, unknown>>;
}

function activeMissions(board: Record<string, unknown> | null | undefined): number {
  if (!board) return 0;
  const cols = board.columns as Record<string, unknown[]> | undefined;
  if (!cols) return (board.missions as unknown[] | undefined)?.length ?? 0;
  const keys = ["active", "in_progress", "researching", "plan_ready", "implementing"];
  let n = 0;
  keys.forEach((k) => {
    n += (cols[k] || []).length;
  });
  return n;
}

function glowFor(status: CognitiveRegionStatus): number {
  if (status === "active") return 1;
  if (status === "waiting") return 0.72;
  if (status === "offline") return 0.2;
  if (status === "dormant") return 0.08;
  return 0.35;
}

function resolveRegionStatus(id: string, ctx: BoardCtx): CognitiveRegionStatus {
  const def = COGNITIVE_REGIONS.find((r) => r.id === id);
  if (def?.dormant) return "dormant";
  const health = ctx.board?.health as { worker?: boolean } | undefined;
  const linked = !!(health && health.worker);
  if (!linked && id === "homeostasis") return "offline";
  if (!linked) return "idle";

  const ts = tasks(ctx.board);
  const activeJobs = ts.filter((t) => ACTIVE_TASK.has((t as { status?: string }).status || ""));
  const liveTerms = sessions(ctx.board).filter((s) => s.state === "running" || s.state === "waiting");
  const waitingTerms = sessions(ctx.board).filter((s) => s.state === "waiting");

  switch (id) {
    case "perception":
      return activeJobs.some((t) => (t as { status?: string }).status === "queued") ? "waiting" : "idle";
    case "working_memory":
      return activeMissions(ctx.board) > 0 ? "active" : "idle";
    case "processing":
      return activeJobs.length > 0 ? "active" : "idle";
    case "executive":
      if (ctx.attention > 0 || ctx.decisions > 0) return "active";
      return "idle";
    case "long_term_memory":
      return (ctx.board?.missions as unknown[] | undefined)?.length ? "idle" : "idle";
    case "world_model":
      return ctx.board && !ctx.board.public_preview ? "idle" : "idle";
    case "meaning":
      return "idle";
    case "execution":
      if (liveTerms.some((s) => s.state === "running")) return "active";
      if (waitingTerms.length) return "waiting";
      if (activeJobs.length) return "waiting";
      return "idle";
    case "homeostasis":
      return linked ? "idle" : "offline";
    default:
      return "idle";
  }
}

function effectorLabel(sess: Record<string, unknown>, idx: number, owner: boolean): string {
  if (!owner) return "S" + (idx + 1);
  const note = String(sess.note || "").trim();
  if (note) return note.length > 12 ? note.slice(0, 11) + "…" : note;
  const ws = sess.workspace ? String(sess.workspace) : "";
  const base = ws.split("/").filter(Boolean).pop() || "";
  if (base) return base.length > 12 ? base.slice(0, 11) + "…" : base;
  if (sess.kind) return String(sess.kind);
  return "S" + (idx + 1);
}

function effectorStatus(sess: Record<string, unknown>): CognitiveRegionStatus {
  if (sess.state === "running") return "active";
  if (sess.state === "waiting") return "waiting";
  if (sess.state === "error") return "offline";
  return "idle";
}

export function buildCognitiveHudModel(ctx: BoardCtx): CognitiveHudModel {
  const regions: CognitiveRegionView[] = COGNITIVE_REGIONS.map((def) => {
    const status = resolveRegionStatus(def.id, ctx);
    const label = ctx.owner ? def.shortLabel : def.shortLabel.slice(0, 4);
    return {
      id: def.id,
      label,
      shortLabel: def.shortLabel,
      anchor: def.anchor,
      status,
      glow: glowFor(status),
    };
  });

  const effectors: CognitiveEffectorView[] = [];
  if (ctx.owner) {
    sessions(ctx.board)
      .filter((s) => s.state !== "exited")
      .slice(0, 3)
      .forEach((s, i) => {
        effectors.push({
          id: "slot:" + (s.id || i),
          label: effectorLabel(s, i, true),
          status: effectorStatus(s),
          parentId: "execution",
        });
      });
  } else {
    sessions(ctx.board)
      .filter((s) => s.state === "running" || s.state === "waiting")
      .slice(0, 2)
      .forEach((s, i) => {
        effectors.push({
          id: "slot:" + (s.id || i),
          label: "S" + (i + 1),
          status: effectorStatus(s),
          parentId: "execution",
        });
      });
  }

  const energyPaths: Array<{ from: string; to: string; strength: number }> = [];
  const st = (id: string) => regions.find((r) => r.id === id)?.status;
  const link = (from: string, to: string) => {
    const a = st(from);
    const b = st(to);
    if (!a || !b) return;
    const live = (s: CognitiveRegionStatus) => s === "active" || s === "waiting";
    if (!live(a) || !live(b)) return;
    energyPaths.push({ from, to, strength: a === "active" && b === "active" ? 0.85 : 0.5 });
  };
  link("perception", "working_memory");
  link("working_memory", "processing");
  link("processing", "execution");
  link("execution", "long_term_memory");
  link("executive", "processing");
  if (ctx.attention > 0) link("executive", "working_memory");

  const ranked = regions
    .filter((r) => r.status === "active" || r.status === "waiting")
    .sort((a, b) => b.glow - a.glow);
  const primaryRegionId = ranked[0]?.id ?? (ctx.attention > 0 ? "executive" : null);

  return { regions, effectors, energyPaths, primaryRegionId };
}

export function cognitiveStatusLabel(status: CognitiveRegionStatus): string {
  const map: Record<CognitiveRegionStatus, string> = {
    active: "ACTIVE",
    waiting: "WAITING",
    idle: "STANDBY",
    offline: "OFFLINE",
    dormant: "RESERVED",
  };
  return map[status] ?? "STANDBY";
}

const READOUT_NAMES: Record<string, string> = {
  perception: "Intake",
  working_memory: "Context",
  processing: "Process",
  executive: "Executive",
  long_term_memory: "Memory",
  world_model: "World",
  meaning: "Meaning",
  execution: "Execute",
  homeostasis: "System",
  background_thinking: "Background",
};

export function regionDisplayName(id: string, owner: boolean): string {
  const def = COGNITIVE_REGIONS.find((r) => r.id === id);
  if (!def) return id;
  if (!owner) return def.shortLabel.slice(0, 4);
  return READOUT_NAMES[id] ?? def.shortLabel;
}

export function buildRegionReadout(
  regionId: string,
  ctx: BoardCtx & { model: CognitiveHudModel },
): { name: string; state: string; fact: string | null } {
  const region = ctx.model.regions.find((r) => r.id === regionId);
  const status = region?.status ?? "idle";
  const name = regionDisplayName(regionId, ctx.owner);
  const state = cognitiveStatusLabel(status);
  if (!ctx.owner) {
    const fact =
      regionId === "execution" && ctx.model.effectors[0] ? ctx.model.effectors[0].label : null;
    return { name, state, fact };
  }
  const board = ctx.board;
  const ts = tasks(board);
  const activeJobs = ts.filter((t) => ACTIVE_TASK.has((t as { status?: string }).status || ""));
  let fact: string | null = null;
  switch (regionId) {
    case "perception": {
      const q = activeJobs.filter((t) => (t as { status?: string }).status === "queued").length;
      if (q) fact = `${q} queued`;
      break;
    }
    case "working_memory": {
      const m = activeMissions(board);
      if (m) fact = `${m} mission${m > 1 ? "s" : ""}`;
      break;
    }
    case "processing":
      if (activeJobs.length) fact = `${activeJobs.length} job${activeJobs.length > 1 ? "s" : ""}`;
      break;
    case "executive":
      if (ctx.attention > 0) fact = `${ctx.attention} pending`;
      break;
    case "execution": {
      const live = ctx.model.effectors.find((e) => e.status === "active");
      fact = live?.label ?? ctx.model.effectors[0]?.label ?? null;
      break;
    }
    case "homeostasis": {
      const linked = !!(board?.health as { worker?: boolean } | undefined)?.worker;
      if (linked) fact = "Worker linked";
      break;
    }
    default:
      break;
  }
  return { name, state, fact };
}

export function rankFocusCandidates(
  regions: CognitiveRegionView[],
  attention: number,
  changedAt: Record<string, number>,
): CognitiveRegionView[] {
  return regions
    .filter((r) => r.status === "active" || r.status === "waiting")
    .sort((a, b) => {
      const pri = (r: CognitiveRegionView) => {
        let p = r.status === "active" ? 300 : 200;
        if (r.id === "executive" && attention > 0) p += 50;
        return p;
      };
      const d = pri(b) - pri(a);
      if (d) return d;
      return (changedAt[b.id] ?? 0) - (changedAt[a.id] ?? 0);
    });
}

export function pickVisibleLabels(
  model: CognitiveHudModel,
  mobile: boolean,
): Array<{ text: string; status: CognitiveRegionStatus; kind: "region" | "effector" }> {
  const out: Array<{ text: string; status: CognitiveRegionStatus; kind: "region" | "effector" }> = [];
  const max = mobile ? 3 : 6;
  if (model.primaryRegionId) {
    const p = model.regions.find((r) => r.id === model.primaryRegionId);
    if (p) out.push({ text: p.label, status: p.status, kind: "region" });
  }
  model.effectors.slice(0, mobile ? 2 : 3).forEach((e) => {
    if (out.length >= max) return;
    out.push({ text: e.label, status: e.status, kind: "effector" });
  });
  model.regions.forEach((r) => {
    if (out.length >= max) return;
    if (r.id === model.primaryRegionId) return;
    if (r.status === "active" || r.status === "waiting") {
      out.push({ text: r.label, status: r.status, kind: "region" });
    }
  });
  return out.slice(0, max);
}
