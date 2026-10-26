/**
 * Archive chronology rail — duplicated in board.html between
 * __archive_present__ markers. Keep in sync.
 */

import {
  groupProposedTurningPoints,
  turningPointDisplayLabel,
  type EvolutionCandidateLike,
} from "./board-evolution-present.js";

export function archiveMonthLabel(iso: string | null | undefined): string {
  const t = Date.parse(String(iso || ""));
  if (!Number.isFinite(t)) return "Earlier";
  const d = new Date(t);
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  return `${months[d.getMonth()]} ${d.getFullYear()}`;
}

export type ArchiveTimelineItem = EvolutionCandidateLike & {
  candidate_id: string;
  updated_at?: string;
  proposed_at?: string;
};

/** Confirmed turning points and capabilities for the chronicle rail (no badges/chapters). */
export function archiveChronicleItems(
  candidates: ArchiveTimelineItem[],
): ArchiveTimelineItem[] {
  return candidates
    .filter(
      (c) =>
        c.status !== "dismissed" &&
        c.kind !== "badge" &&
        c.kind !== "chapter" &&
        c.status !== "proposed",
    )
    .slice()
    .sort((a, b) =>
      String(b.updated_at || b.proposed_at || "").localeCompare(
        String(a.updated_at || a.proposed_at || ""),
      ),
    );
}

export function archiveReviewGroups<T extends EvolutionCandidateLike>(
  candidates: T[],
): { label: string; items: T[] }[] {
  const proposed = candidates.filter(
    (c) => c.status === "proposed" && c.kind === "turning_point",
  );
  return groupProposedTurningPoints(proposed);
}

export function archiveItemTitle(c: EvolutionCandidateLike): string {
  return turningPointDisplayLabel(c);
}
