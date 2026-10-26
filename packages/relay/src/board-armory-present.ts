/**
 * Armory capability loadout model — duplicated in board.html between
 * __armory_present__ markers. Keep in sync.
 */

export type ArmoryNode = {
  id: string;
  name: string;
  branch: string;
  status: "verified" | "partial" | "not_assessed" | string;
  evidence?: string;
  authority?: string;
  health?: string;
};

export type ArmoryBranchStat = {
  branch: string;
  verified: number;
  total: number;
};

/** Map note status to loadout tier — no invented hardened/RPG labels. */
export function armoryStatusTier(status: string): string {
  if (status === "verified") return "Reliable";
  if (status === "partial") return "Emerging";
  return "Not assessed";
}

export function armoryBranchesWithStats(nodes: ArmoryNode[]): ArmoryBranchStat[] {
  const map = new Map<string, ArmoryBranchStat>();
  for (const n of nodes) {
    const branch = String(n.branch || "").trim();
    if (!branch) continue;
    let row = map.get(branch);
    if (!row) {
      row = { branch, verified: 0, total: 0 };
      map.set(branch, row);
    }
    row.total += 1;
    if (n.status === "verified") row.verified += 1;
  }
  return [...map.values()].sort((a, b) => a.branch.localeCompare(b.branch));
}

export function armoryNodesInBranch(
  nodes: ArmoryNode[],
  branch: string | null,
): ArmoryNode[] {
  if (!branch) return [];
  const rank = (s: string) =>
    s === "verified" ? 0 : s === "partial" ? 1 : 2;
  return nodes
    .filter((n) => n.branch === branch)
    .slice()
    .sort(
      (a, b) =>
        rank(String(a.status)) - rank(String(b.status)) ||
        a.name.localeCompare(b.name),
    );
}

export function pickArmoryNodeId(
  nodes: ArmoryNode[],
  branch: string | null,
  selectedId: string | null | undefined,
): string | null {
  const inBranch = armoryNodesInBranch(nodes, branch);
  if (!inBranch.length) return null;
  if (selectedId && inBranch.some((n) => n.id === selectedId)) return selectedId;
  return inBranch[0]!.id;
}

export function armoryFocalHasDisclosure(node: ArmoryNode | null): boolean {
  if (!node) return false;
  return !!(node.evidence || node.authority || node.health);
}
