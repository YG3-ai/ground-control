/**
 * Evolution tab + Home preview grouping (proposed turning points).
 * Duplicated in board.html between __evolution_present__ markers — keep in sync.
 */

export type EvolutionCandidateLike = {
  candidate_id: string;
  kind?: string;
  status?: string;
  proposed_label?: string | null;
  corrected_label?: string | null;
};

export function turningPointDisplayLabel(c: EvolutionCandidateLike): string {
  return String(c.corrected_label || c.proposed_label || "Change").trim();
}

export function groupProposedTurningPoints<T extends EvolutionCandidateLike>(
  candidates: T[],
): { label: string; items: T[] }[] {
  const turns = candidates.filter(
    (c) => c.status === "proposed" && c.kind === "turning_point",
  );
  const map = new Map<string, T[]>();
  const order: string[] = [];
  for (const c of turns) {
    const label = turningPointDisplayLabel(c);
    if (!map.has(label)) {
      map.set(label, []);
      order.push(label);
    }
    map.get(label)!.push(c);
  }
  return order.map((label) => ({ label, items: map.get(label)! }));
}

export function homeEvolutionPreviewGroups<T extends EvolutionCandidateLike>(
  candidates: T[],
  maxGroups = 2,
): { label: string; count: number }[] {
  return groupProposedTurningPoints(candidates)
    .map((g) => ({ label: g.label, count: g.items.length }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, maxGroups);
}

const RECOVERY_LABEL_RE = /^recovered after failure$/i;

export type HomeEvolutionPreview = {
  title: string;
  subtitle: string;
};

/** Prefer capability proposals; avoid elevating repeated recovery patterns on Home. */
export function pickHomeEvolutionPreview(
  candidates: EvolutionCandidateLike[] | undefined | null,
): HomeEvolutionPreview | null {
  const proposed = (candidates || []).filter(
    (c) =>
      c.status === "proposed" &&
      c.kind !== "badge" &&
      c.kind !== "chapter",
  );
  if (!proposed.length) return null;

  const capability = proposed.find((c) => c.kind === "capability");
  if (capability) {
    return {
      title: turningPointDisplayLabel(capability),
      subtitle: "Capability interpretation proposed",
    };
  }

  const turns = proposed.filter((c) => c.kind === "turning_point");
  const named = turns.find(
    (c) => !RECOVERY_LABEL_RE.test(turningPointDisplayLabel(c)),
  );
  if (named) {
    return {
      title: turningPointDisplayLabel(named),
      subtitle: "Turning point proposed",
    };
  }

  if (turns.length) {
    return {
      title: "Review proposed changes",
      subtitle:
        turns.length === 1
          ? "One item in Evolution"
          : turns.length + " similar items in Evolution",
    };
  }

  const any = proposed[0];
  if (!any) return null;
  return {
    title: turningPointDisplayLabel(any),
    subtitle: "New interpretation proposed",
  };
}

export function proposedReviewCount(
  candidates: EvolutionCandidateLike[] | undefined | null,
): number {
  if (!candidates?.length) return 0;
  return candidates.filter(
    (c) =>
      c.status === "proposed" &&
      c.kind !== "badge" &&
      c.kind !== "chapter",
  ).length;
}
