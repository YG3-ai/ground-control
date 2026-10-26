const PII_KEY = /email|message|body|html|markdown|phone|name|title|subject|reply/i;

export function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function pickNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return null;
}

export function clampInt(n: number | null, max = 1_000_000): number | null {
  if (n === null) return null;
  const v = Math.max(0, Math.min(max, Math.floor(n)));
  return v;
}

export function clampString(s: string, max = 160): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

export function extractClientIds(payload: unknown, max: number): string[] {
  const root = asRecord(payload);
  const candidates = [
    ...asArray(root.clients),
    ...asArray(root.connections),
    ...asArray(root.items),
    ...asArray(root.data),
    ...asArray(payload),
  ];
  const ids: string[] = [];
  for (const row of candidates) {
    const o = asRecord(row);
    const id =
      (typeof o.client_id === "string" && o.client_id) ||
      (typeof o.clientId === "string" && o.clientId) ||
      (typeof o.id === "string" && o.id) ||
      "";
    if (!id || ids.includes(id)) continue;
    ids.push(id);
    if (ids.length >= max) break;
  }
  return ids;
}

export function countRows(payload: unknown): number {
  const root = asRecord(payload);
  for (const key of ["items", "projects", "tasks", "data", "results"]) {
    const arr = asArray(root[key]);
    if (arr.length) return arr.length;
  }
  if (Array.isArray(payload)) return payload.length;
  return 0;
}

export function countOpenTasks(payload: unknown): number {
  const root = asRecord(payload);
  const arr = asArray(root.tasks ?? root.items ?? payload);
  let open = 0;
  for (const row of arr) {
    const o = asRecord(row);
    const status = String(o.status ?? o.state ?? "").toLowerCase();
    if (!status || status.includes("open") || status.includes("active")) {
      open += 1;
    }
  }
  return open;
}

export function connectionStatusCounts(payload: unknown): {
  clientCount: number;
  connectedCount: number;
  statusCounts: Record<string, number>;
} {
  const root = asRecord(payload);
  const arr = asArray(
    root.connections ?? root.clients ?? root.items ?? payload,
  );
  const statusCounts: Record<string, number> = {};
  let connected = 0;
  for (const row of arr) {
    const o = asRecord(row);
    const status = String(
      o.status ?? o.connection_status ?? o.state ?? "unknown",
    )
      .toLowerCase()
      .slice(0, 32);
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    if (status.includes("connect") && !status.includes("disconnect")) {
      connected += 1;
    }
  }
  return {
    clientCount: arr.length,
    connectedCount: connected,
    statusCounts,
  };
}

export function sumNumericFields(payload: unknown, keys: string[]): number | null {
  const root = asRecord(payload);
  for (const k of keys) {
    const n = pickNumber(root[k]);
    if (n !== null) return clampInt(n);
  }
  const totals = asRecord(root.totals);
  for (const k of keys) {
    const n = pickNumber(totals[k]);
    if (n !== null) return clampInt(n);
  }
  return null;
}

export function extractTrafficRows(
  payload: unknown,
  max = 8,
): { key: string; label: string; count: number }[] {
  const root = asRecord(payload);
  const arr = asArray(
    root.channels ?? root.breakdown ?? root.rows ?? root.items ?? payload,
  );
  const out: { key: string; label: string; count: number }[] = [];
  for (const row of arr) {
    const o = asRecord(row);
    const key = String(o.key ?? o.channel ?? o.source ?? `ch-${out.length}`)
      .slice(0, 32);
    const label = clampString(
      String(o.label ?? o.name ?? o.channel ?? key),
      48,
    );
    const count = clampInt(
      pickNumber(o.count ?? o.visits ?? o.sessions ?? o.value),
      1_000_000,
    );
    if (count === null) continue;
    out.push({ key, label, count });
    if (out.length >= max) break;
  }
  return out;
}

export function safeInsightLines(
  payload: unknown,
  max = 3,
): { id: string; kicker: string; body: string; tone: string }[] {
  const root = asRecord(payload);
  const arr = asArray(root.insights ?? root.highlights ?? root.items);
  const out: { id: string; kicker: string; body: string; tone: string }[] = [];
  for (const row of arr) {
    const o = asRecord(row);
    const body = clampString(String(o.body ?? o.summary ?? o.text ?? ""), 120);
    if (!body || PII_KEY.test(body)) continue;
    const kicker = clampString(String(o.kicker ?? o.title ?? "Insight"), 48);
    if (PII_KEY.test(kicker)) continue;
    out.push({
      id: clampString(String(o.id ?? `insight-${out.length}`), 32),
      kicker,
      body,
      tone: clampString(String(o.tone ?? "neutral"), 16),
    });
    if (out.length >= max) break;
  }
  return out;
}

export function safeRecommendations(
  payload: unknown,
  max = 3,
): Yg3SnapshotV1Recommendation[] {
  const insights = safeInsightLines(payload, max);
  return insights.map((i, idx) => ({
    id: `yg3-rec-${idx}`,
    title: i.kicker,
    metric: "workspace",
    kind: "decision" as const,
    detail: {},
  }));
}

export type Yg3SnapshotV1Recommendation = {
  id: string;
  title: string;
  metric: string;
  kind: "decision" | "build" | "proof";
  detail: Record<string, unknown>;
};
