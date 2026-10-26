/**
 * HOME suit HUD — live system topology from board payload (duplicated in board.html).
 */

export type HudNodeStatus = "running" | "waiting" | "idle" | "offline" | "attention";

export type HudTopologyNode = {
  id: string;
  kind: "brain" | "slot" | "dest" | "infra";
  label: string;
  status: HudNodeStatus;
};

export type HudTopology = {
  core: HudTopologyNode;
  satellites: HudTopologyNode[];
};

type TerminalRow = {
  id?: string;
  state?: string;
  kind?: string;
  workspace?: string;
  note?: string;
};

const ACTIVE_TASK = new Set([
  "queued",
  "preparing",
  "running",
  "awaiting_followup",
  "cancelling",
]);

function sessionStatus(state: string | undefined): HudNodeStatus {
  if (state === "running") return "running";
  if (state === "waiting") return "waiting";
  if (state === "error") return "offline";
  return "idle";
}

function slotLabel(sess: TerminalRow, idx: number, owner: boolean): string {
  if (!owner) return "S" + (idx + 1);
  const note = (sess.note || "").trim();
  if (note) return note.length > 12 ? note.slice(0, 11) + "…" : note;
  const ws = sess.workspace ? String(sess.workspace) : "";
  const base = ws.split("/").filter(Boolean).pop() || "";
  if (base) return base.length > 12 ? base.slice(0, 11) + "…" : base;
  if (sess.kind) return String(sess.kind);
  return "S" + (idx + 1);
}

function coreFromBoard(
  health: { worker?: boolean } | undefined,
  tasks: unknown[] | undefined,
  attention: number,
): HudTopologyNode {
  const linked = !!(health && health.worker);
  if (!linked) {
    return { id: "brain", kind: "brain", label: "BRAIN", status: "offline" };
  }
  if (attention > 0) {
    return { id: "brain", kind: "brain", label: "BRAIN", status: "attention" };
  }
  const active = (tasks || []).filter((t) => {
    const st = (t as { status?: string }).status;
    return st && ACTIVE_TASK.has(st);
  });
  if (active.length) {
    return { id: "brain", kind: "brain", label: "BRAIN", status: "running" };
  }
  return { id: "brain", kind: "brain", label: "BRAIN", status: "idle" };
}

/** Build satellite ring for HOME HUD (real data only). */
export function buildHudTopology(
  board: Record<string, unknown> | null | undefined,
  opts: { owner: boolean; maxSatellites: number; attention?: number },
): HudTopology {
  const owner = opts.owner;
  const max = Math.max(3, opts.maxSatellites);
  const health = board?.health as { worker?: boolean } | undefined;
  const tasks = (board?.tasks || board?.active_tasks) as unknown[] | undefined;
  const sessions = (board?.terminal_sessions || []) as TerminalRow[];
  const attention = opts.attention ?? 0;

  const core = coreFromBoard(health, tasks, attention);

  const satellites: HudTopologyNode[] = [];

  const slotCandidates = [...sessions]
    .sort((a, b) => {
      const rank = (s: TerminalRow) => {
        if (s.state === "running") return 0;
        if (s.state === "waiting") return 1;
        if (s.state === "error") return 2;
        return 3;
      };
      return rank(a) - rank(b);
    })
    .filter((s) => s.state !== "exited");

  const slotCap = owner ? Math.min(3, max) : Math.min(2, max);
  slotCandidates.slice(0, slotCap).forEach((s, i) => {
    satellites.push({
      id: "slot:" + (s.id || i),
      kind: "slot",
      label: slotLabel(s, i, owner),
      status: sessionStatus(s.state),
    });
  });

  const dests: { id: string; label: string }[] = [
    { id: "dest:ground", label: "GND" },
    { id: "dest:yg3", label: "YG3" },
    { id: "dest:archive", label: "ARC" },
  ];
  dests.forEach((d) => {
    if (satellites.length >= max) return;
    satellites.push({
      id: d.id,
      kind: "dest",
      label: d.label,
      status: health?.worker ? "idle" : "offline",
    });
  });

  if (!owner && satellites.length < max) {
    satellites.push({
      id: "infra:relay",
      kind: "infra",
      label: "LINK",
      status: health?.worker ? "idle" : "offline",
    });
  }

  return { core, satellites: satellites.slice(0, max) };
}

export function hudStatusColor(status: HudNodeStatus): string {
  switch (status) {
    case "running":
      return "#ffb86a";
    case "waiting":
      return "#8ec8ff";
    case "attention":
      return "#ff6b4a";
    case "offline":
      return "#6a7280";
    default:
      return "#c4b8a8";
  }
}
