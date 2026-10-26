/**
 * Evolution evidence + entity resolution for the owner board shell.
 * Duplicated in board.html between __evolution_resolve__ markers.
 */

export type EvidenceLike = {
  verb?: string;
  source?: string;
  source_ref?: string;
  object_type?: string | null;
  object_id?: string | null;
  from_state?: string | null;
  to_state?: string | null;
};

export function missionIdFromAlias(alias: string): string | null {
  if (!alias) return null;
  if (alias.startsWith("mission:")) return alias.slice("mission:".length);
  return null;
}

export function missionIdFromEntityAliases(aliases: string[] | undefined): string | null {
  if (!aliases?.length) return null;
  for (const a of aliases) {
    const id = missionIdFromAlias(a);
    if (id) return id;
  }
  return null;
}

export function missionIdFromEvidence(e: EvidenceLike): string | null {
  if (e.object_type === "mission" && e.object_id) return String(e.object_id);
  if (e.source === "missions" && e.source_ref) return String(e.source_ref);
  return null;
}

export function jobIdFromEvidence(e: EvidenceLike): string | null {
  if (e.object_type === "job" && e.object_id) return String(e.object_id);
  if (e.source === "jobs" && e.source_ref) return String(e.source_ref);
  return null;
}

function stateTransition(e: EvidenceLike): string | null {
  const from = e.from_state ? String(e.from_state).replace(/_/g, " ") : "";
  const to = e.to_state ? String(e.to_state).replace(/_/g, " ") : "";
  if (from && to) return from + " → " + to;
  if (to) return to;
  if (from) return "from " + from;
  return null;
}

export function evidenceVerbLabel(e: EvidenceLike): string {
  const tr = stateTransition(e);
  if (e.object_type === "mission" && tr) return "Mission " + tr;
  if (e.object_type === "job" && tr) return "Job " + tr;
  const v = String(e.verb || "").replace(/_/g, " ").trim();
  if (tr && v) return v + " · " + tr;
  return tr || v || "Event";
}

export type EvidenceRowView = {
  title: string;
  subtitle: string;
  actionable: boolean;
  missionId: string | null;
  jobId: string | null;
};

export function evidenceRowView(
  e: EvidenceLike,
  missionTitle: string | null,
): EvidenceRowView {
  const missionId = missionIdFromEvidence(e);
  const jobId = jobIdFromEvidence(e);
  const verbLabel = evidenceVerbLabel(e);
  const title = missionTitle || (missionId ? "Mission " + missionId.slice(0, 8) : verbLabel);
  const subtitleParts: string[] = [];
  if (missionTitle && verbLabel !== title) subtitleParts.push(verbLabel);
  else if (!missionTitle && missionId && verbLabel !== title) subtitleParts.push(verbLabel);
  if (e.source && e.source !== "missions" && e.source !== "jobs") {
    subtitleParts.push(String(e.source));
  }
  const subtitle = subtitleParts.filter(Boolean).join(" · ") || verbLabel;
  const actionable = Boolean(missionId || jobId);
  return { title, subtitle, actionable, missionId, jobId };
}

export function turningPointListMeta(
  c: {
    status?: string;
    proposed_description?: string | null;
    proposed_at?: string;
    updated_at?: string;
  },
  missionTitle: string | null,
): string {
  const parts: string[] = [];
  if (missionTitle) parts.push(missionTitle);
  if (c.status === "proposed") parts.push("Proposed");
  else if (c.status === "accepted" || c.status === "corrected") parts.push("Confirmed");
  else if (c.status) parts.push(String(c.status));
  if (!missionTitle && c.proposed_description) {
    const line = c.proposed_description.split("\n")[0]?.trim();
    if (line) parts.push(line.length > 72 ? line.slice(0, 71) + "…" : line);
  }
  return parts.join(" · ");
}
