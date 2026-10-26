/**
 * Owner Home copy helpers (mission subline + brain profile purpose).
 * Shipped UI duplicates missionHomeSubline in board.html between
 * __mission_home_line__ markers — keep in sync; tests cover both.
 */

const AUDIT_RE =
  /\b(audit|checkpoint|meta audit|workstream|launchctl|verify-board|public_preview|conversation transcript)\b/i;
const AUDIT_PATH_RE = /packages\/[a-z0-9_-]+\//i;

export function isAuditLikeProse(text: string): boolean {
  const s = String(text || "").trim();
  if (!s) return true;
  if (s.length > 280 && (s.includes("```") || AUDIT_PATH_RE.test(s))) return true;
  if (AUDIT_RE.test(s)) return true;
  if (/^#{1,3}\s*(summary|changed paths|test plan|scope)\b/i.test(s)) return true;
  if (/^\s*[-*]\s+`[^`]+`/m.test(s) && AUDIT_PATH_RE.test(s)) return true;
  const pathHits = (s.match(/\.[a-z]{2,4}(?:\s|,|$)/gi) || []).length;
  if (pathHits >= 4 && s.includes("/")) return true;
  return false;
}

const MARKER_SKIP = new Set([
  "execution_started",
  "plan_approved",
  "update_drafted",
  "client",
  "bugfix",
  "board",
]);

const MARKER_PREFERRED = [
  "status_detail",
  "current_step",
  "step",
  "focus",
  "next",
  "status",
  "phase",
];

function firstLine(text: string, max = 96): string | null {
  const line = String(text || "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

function markerHomeLine(
  markers: Record<string, string | number | boolean | null> | undefined,
): string | null {
  if (!markers || typeof markers !== "object") return null;
  for (const key of MARKER_PREFERRED) {
    const v = markers[key];
    if (v == null || v === "") continue;
    if (typeof v === "boolean") continue;
    if (key === "current_step" && (typeof v === "number" || /^\d+$/.test(String(v)))) continue;
    const val = String(v).trim();
    if (!val || isAuditLikeProse(val)) continue;
    if (key === "status_detail" || key === "current_step") return val.length > 96 ? val.slice(0, 95) + "…" : val;
    return `${key.replace(/_/g, " ")}: ${val}`.slice(0, 96);
  }
  const extras: string[] = [];
  for (const [key, v] of Object.entries(markers)) {
    if (MARKER_SKIP.has(key) || MARKER_PREFERRED.includes(key)) continue;
    if (v == null || typeof v === "boolean") continue;
    const val = String(v).trim();
    if (!val || isAuditLikeProse(val)) continue;
    extras.push(`${key.replace(/_/g, " ")}: ${val}`);
    if (extras.length >= 2) break;
  }
  if (!extras.length) return null;
  return extras.join(" · ").slice(0, 96);
}

function planStepLine(
  plan: string | null | undefined,
  markers: Record<string, string | number | boolean | null> | undefined,
): string | null {
  if (!plan) return null;
  const lines = plan
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const numbered = lines.filter((l) => /^\d+[\).\]:]/.test(l));
  if (!numbered.length) return firstLine(plan);
  const stepN = markers?.current_step;
  if (typeof stepN === "number" && stepN >= 1 && stepN <= numbered.length) {
    return firstLine(numbered[stepN - 1]!);
  }
  if (typeof stepN === "string" && /^\d+$/.test(stepN)) {
    const n = Number(stepN);
    if (n >= 1 && n <= numbered.length) return firstLine(numbered[n - 1]!);
  }
  return firstLine(numbered[numbered.length - 1]!);
}

export type MissionHomeFields = {
  summary?: string | null;
  goal?: string | null;
  plan?: string | null;
  findings?: string | null;
  markers?: Record<string, string | number | boolean | null>;
};

/** Home Now hero: human status + optional goal line — not internal PM markers. */
export function missionHeroSubtitle(
  m: MissionHomeFields & { col?: string | null; status?: string | null },
): string {
  const key = String(m.col || m.status || "");
  const st = (
    {
      intake: "New",
      researching: "Researching",
      plan_ready: "Plan ready",
      approved: "Approved",
      implementing: "Building",
      in_progress: "Working",
      verifying: "Checking",
      blocked: "Blocked",
      done: "Done",
      cancelled: "Cancelled",
    } as Record<string, string>
  )[key] || "Active";
  if (m.goal) {
    const g = firstLine(m.goal, 80);
    if (g && !isAuditLikeProse(g)) return st + " · " + g;
  }
  return st;
}

export function missionHomeSubline(m: MissionHomeFields): string | null {
  const fromMarkers = markerHomeLine(m.markers);
  if (fromMarkers) return fromMarkers;
  const fromFindings = m.findings ? firstLine(m.findings) : null;
  if (fromFindings && !isAuditLikeProse(fromFindings)) return fromFindings;
  const fromPlan = planStepLine(m.plan, m.markers);
  if (fromPlan && !isAuditLikeProse(fromPlan)) return fromPlan;
  const fromGoal = m.goal ? firstLine(m.goal) : null;
  if (fromGoal && !isAuditLikeProse(fromGoal)) return fromGoal;
  if (m.summary) {
    const fromSummary = firstLine(m.summary);
    if (fromSummary && !isAuditLikeProse(fromSummary)) return fromSummary;
  }
  return null;
}

/** True when the board payload says offline and live feeds do not contradict it. */
export function boardShowsWorkerOffline(
  board: { error?: string; health?: { worker?: boolean } } | null | undefined,
  world: { ok?: boolean } | null | undefined,
): boolean {
  if (!board || board.error !== "worker_offline") return false;
  if (board.health?.worker) return false;
  if (world?.ok) return false;
  return true;
}

/** Owner Home greeting derived from brain profile title (no note body on Home). */
export function profileOrientationFromTitle(title: string): {
  name: string;
  descriptor?: string;
} {
  const raw = String(title || "").trim();
  if (!raw) return { name: "You" };
  let t = raw
    .replace(/^(second\s+brain\s+)?dossier\s*[—–-]\s*/i, "")
    .trim();
  const parts = t
    .split(/\s*[—–-]\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length >= 2) {
    const name = parts[parts.length - 1]!;
    const descriptor = parts.slice(0, -1).join(" · ");
    if (name.length <= 48) {
      return { name, descriptor: descriptor || undefined };
    }
  }
  if (t.length > 56) return { name: t.slice(0, 53) + "…" };
  return { name: t };
}

export function profilePurposeFromNoteBody(body: string): string | undefined {
  const stripped = body
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")
    .replace(/^# [^\n]+\n+/, "");
  const paras = stripped
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith("#"));
  for (const para of paras) {
    const line = para.split("\n")[0]?.trim();
    if (!line || isAuditLikeProse(line)) continue;
    return line.length > 220 ? line.slice(0, 217) + "…" : line;
  }
  return undefined;
}
