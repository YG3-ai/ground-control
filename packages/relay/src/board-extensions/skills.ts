import type { BoardExtensionPaths } from "./paths.js";
import { runBrain } from "./brain.js";

export type SkillBranch = "Engineering" | "Growth" | "Publishing" | "Operations";

export type SkillNode = {
  id: string;
  name: string;
  branch: SkillBranch;
  status: "verified" | "partial" | "not_assessed";
  evidence: string;
  authority: string;
  health: string;
  /** ids this node composes; composites never add to the level themselves */
  compositeOf?: string[];
};

export type SkillsPayload = {
  ok: boolean;
  health: "ok" | "unavailable";
  level: number | null;
  levelRule: string;
  source: "brain" | "none";
  measuredAt: string | null;
  branches: SkillBranch[];
  nodes: SkillNode[];
  error?: string;
};

const LEVEL_RULE =
  "Level = count of distinct verified reusable capabilities recorded in the Second Brain. Unverified capabilities do not count; repeated runs of the same capability do not inflate it; composite capabilities are not double-counted.";

/** Canonical Brain note holding deduped capability evidence. */
export const SKILLS_NOTE_SLUG = "projects/ground-capabilities";

const BRANCHES: SkillBranch[] = [
  "Engineering",
  "Growth",
  "Publishing",
  "Operations",
];

const FIELD_RE = /^-\s*(id|branch|status|proof|authority|health|composite_of):\s*(.*)$/i;

function parseCapabilityNote(body: string): SkillNode[] {
  const nodes: SkillNode[] = [];
  let current: Partial<SkillNode> | null = null;
  const push = () => {
    if (!current) return;
    if (!current.id || !current.name || !current.branch) return;
    if (!BRANCHES.includes(current.branch)) return;
    const status =
      current.status === "verified" || current.status === "partial"
        ? current.status
        : "not_assessed";
    nodes.push({
      id: current.id,
      name: current.name,
      branch: current.branch,
      status,
      evidence: current.evidence ?? "",
      authority: current.authority ?? "",
      health: current.health ?? "Not assessed",
      compositeOf: current.compositeOf,
    });
  };
  for (const line of body.split("\n")) {
    const h = line.match(/^##\s+(.+)$/);
    if (h && h[1] !== undefined) {
      push();
      current = { name: h[1].trim() };
      continue;
    }
    if (!current) continue;
    const f = line.match(FIELD_RE);
    if (!f || f[1] === undefined || f[2] === undefined) continue;
    const key = f[1].toLowerCase();
    const value = f[2].trim();
    if (key === "id") current.id = value;
    else if (key === "branch") current.branch = value as SkillBranch;
    else if (key === "status") current.status = value as SkillNode["status"];
    else if (key === "proof") current.evidence = value;
    else if (key === "authority") current.authority = value;
    else if (key === "health") current.health = value;
    else if (key === "composite_of") {
      current.compositeOf = value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  push();
  /* Dedupe by id — first occurrence wins, repeats never double-score. */
  const seen = new Set<string>();
  return nodes.filter((n) => {
    if (seen.has(n.id)) return false;
    seen.add(n.id);
    return true;
  });
}

export function computeLevel(nodes: SkillNode[]): number {
  return nodes.filter((n) => n.status === "verified" && !n.compositeOf?.length)
    .length;
}

let cache: { at: number; payload: SkillsPayload } | null = null;
const TTL_MS = 60_000;

export async function getSkillsPayload(
  pathsCfg: BoardExtensionPaths,
): Promise<SkillsPayload> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.payload;

  const result = await runBrain(pathsCfg, ["read", SKILLS_NOTE_SLUG]);
  if (result.code !== 0) {
    const payload: SkillsPayload = {
      ok: false,
      health: "unavailable",
      level: null,
      levelRule: LEVEL_RULE,
      source: "none",
      measuredAt: null,
      branches: BRANCHES,
      nodes: [],
      error: (result.stderr || "capability note unavailable").slice(0, 160),
    };
    cache = { at: now, payload };
    return payload;
  }

  const nodes = parseCapabilityNote(result.stdout);
  const payload: SkillsPayload = {
    ok: true,
    health: "ok",
    level: computeLevel(nodes),
    levelRule: LEVEL_RULE,
    source: "brain",
    measuredAt: new Date().toISOString(),
    branches: BRANCHES,
    nodes,
  };
  cache = { at: now, payload };
  return payload;
}

export function clearSkillsCache(): void {
  cache = null;
}
