/**
 * Mission filters for the board. No id/title suppression: a mission's own
 * authoritative status decides where it shows. Terminal statuses
 * (done/cancelled) live in History only.
 */
const IN_PROGRESS_COLUMNS = [
  "implementing",
  "in_progress",
  "verifying",
  "plan_ready",
] as const;

export function isInProgressMission(m: { status?: string }): boolean {
  const s = String(m.status ?? "");
  return (
    s === "implementing" || s === "in_progress" || s === "verifying" || s === "plan_ready"
  );
}

export function inProgressMissions(
  columns: Record<string, unknown[]> | undefined,
): { id?: string; title?: string; status?: string; workspace?: string }[] {
  if (!columns) return [];
  const out: { id?: string; title?: string; status?: string; workspace?: string }[] =
    [];
  for (const k of IN_PROGRESS_COLUMNS) {
    for (const m of columns[k] || []) {
      const row = m as { id?: string; title?: string; status?: string; workspace?: string };
      out.push({ ...row, status: row.status || k });
    }
  }
  return out.slice(0, 8);
}
