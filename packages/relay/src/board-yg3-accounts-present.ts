/**
 * YG3 NEW ACCOUNTS feed — owner HUD rows (duplicated in board.html suit block).
 */

export type Yg3AccountRow = {
  id: string;
  name: string;
  email: string;
  /** ISO 8601 from clients.created_at */
  createdAt: string;
};

export type Yg3AccountsFeedPayload = {
  ok: boolean;
  health: "ok" | "unavailable" | "stale";
  measuredAt: string | null;
  items: Yg3AccountRow[];
  error?: string;
};

export function sortYg3AccountsByCreatedDesc(items: Yg3AccountRow[]): Yg3AccountRow[] {
  return [...items].sort((a, b) => {
    const ta = Date.parse(a.createdAt);
    const tb = Date.parse(b.createdAt);
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) {
      return tb - ta;
    }
    if (a.createdAt !== b.createdAt) {
      return a.createdAt < b.createdAt ? 1 : -1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export function mapYg3AccountRows(
  raw: Array<{ id?: string; name?: string; email?: string; createdAt?: string }>,
): Yg3AccountRow[] {
  const out: Yg3AccountRow[] = [];
  for (const row of raw) {
    const id = row.id ? String(row.id).trim() : "";
    const name = row.name ? String(row.name).trim() : "";
    const createdAt = row.createdAt ? String(row.createdAt).trim() : "";
    if (!id || !name || !createdAt) continue;
    const email = row.email ? String(row.email).trim() : "";
    out.push({ id, name, email, createdAt });
  }
  return sortYg3AccountsByCreatedDesc(out);
}

/** Format creation instant for HUD (local wall time). */
export function formatYg3AccountCreatedAt(
  iso: string,
  locale = "en-US",
  timeZone?: string,
): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const opts: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  };
  if (timeZone) opts.timeZone = timeZone;
  return new Intl.DateTimeFormat(locale, opts).format(new Date(t));
}
