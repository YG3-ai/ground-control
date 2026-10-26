import {
  BRAIN_CORPUS_METRIC,
  BRAIN_CORPUS_SOURCE,
  parseBrainStatsStdout,
  type BrainCorpusAggregate,
} from "../board-brain-corpus.js";
import { profilePurposeFromNoteBody } from "../board-home-mission.js";
import type { BoardExtensionPaths } from "./paths.js";
import { brainAdapterConfigured } from "./paths.js";
import {
  clampText,
  isSafeBrainSlug,
  runBounded,
} from "./safe-exec.js";

export type BrainNoteItem = {
  slug: string;
  title: string;
  updated?: string;
  excerpt?: string;
};

export type BrainFeedPayload = {
  ok: boolean;
  health: "ok" | "unavailable";
  measuredAt: string | null;
  items: BrainNoteItem[];
  error?: string;
};

export type BrainReadPayload = {
  ok: boolean;
  slug: string;
  title?: string;
  body?: string;
  error?: string;
};

export type BrainCapturePayload = {
  ok: boolean;
  message: string;
  location?: string;
  error?: string;
};

const MAX_CAPTURE = 8000;
const MAX_SEARCH = 200;
const MAX_TITLE = 200;

export const BRAIN_LIMITS = { capture: MAX_CAPTURE, title: MAX_TITLE, search: MAX_SEARCH };

export type BrainCorpusPayload = BrainCorpusAggregate & {
  health: "ok" | "unavailable";
};

let corpusCache: { at: number; payload: BrainCorpusPayload } | null = null;
const CORPUS_CACHE_MS = 120_000;

export function clearBrainCorpusCache(): void {
  corpusCache = null;
}

export async function getBrainCorpus(
  pathsCfg: BoardExtensionPaths,
): Promise<BrainCorpusPayload> {
  const now = Date.now();
  if (corpusCache && now - corpusCache.at < CORPUS_CACHE_MS) {
    return corpusCache.payload;
  }
  const result = await runBrain(pathsCfg, ["stats"]);
  if (result.code !== 0) {
    const payload: BrainCorpusPayload = {
      ok: false,
      source: BRAIN_CORPUS_SOURCE,
      metric: BRAIN_CORPUS_METRIC,
      health: "unavailable",
      measuredAt: null,
      documents: 0,
      words: 0,
      error: result.stderr.slice(0, 160) || "brain stats failed",
    };
    return payload;
  }
  const parsed = parseBrainStatsStdout(result.stdout);
  if (!parsed) {
    return {
      ok: false,
      source: BRAIN_CORPUS_SOURCE,
      metric: BRAIN_CORPUS_METRIC,
      health: "unavailable",
      measuredAt: null,
      documents: 0,
      words: 0,
      error: "invalid_stats",
    };
  }
  const payload: BrainCorpusPayload = {
    ...parsed,
    health: "ok",
    measuredAt: new Date().toISOString(),
  };
  corpusCache = { at: now, payload };
  return payload;
}

function toLimit(n: unknown, fallback: number, max: number): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(Math.max(Math.floor(v), 1), max);
}

export async function runBrain(
  pathsCfg: BoardExtensionPaths,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  if (!brainAdapterConfigured(pathsCfg)) {
    return {
      code: 1,
      stdout: "",
      stderr: "brain_adapter_not_configured",
    };
  }
  const result = await runBounded(pathsCfg.brainPython!, [pathsCfg.brainScript!, ...args], {
    cwd: pathsCfg.brainRoot!,
    timeoutMs: 25_000,
    maxBuffer: 1_500_000,
    env: {
      ...process.env,
      HOME: process.env.HOME,
      /* brain.py resolves its vault from BRAIN_VAULT, not cwd — always pin it */
      BRAIN_VAULT: pathsCfg.brainVault!,
    },
  });
  return result;
}

function parseRecent(stdout: string): BrainNoteItem[] {
  const items: BrainNoteItem[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split("\t");
    const p0 = parts[0];
    const p1 = parts[1];
    if (parts.length >= 2 && p0 !== undefined && p1 !== undefined) {
      items.push({
        slug: p0.trim(),
        title: p1.trim(),
        updated: parts[2]?.trim(),
      });
      continue;
    }
    const m = t.match(/^(.+?)\s+\(([^)]+)\)\s*$/);
    if (m && m[1] !== undefined && m[2] !== undefined) {
      items.push({ title: m[1].trim(), slug: m[2].trim() });
      continue;
    }
    items.push({ title: t, slug: t });
  }
  return items.slice(0, 30);
}

export async function getBrainRecent(
  pathsCfg: BoardExtensionPaths,
  n: number,
): Promise<BrainFeedPayload> {
  const limit = toLimit(n, 12, 30);
  const result = await runBrain(pathsCfg, ["recent", String(limit)]);
  if (result.code !== 0) {
    return {
      ok: false,
      health: "unavailable",
      measuredAt: null,
      items: [],
      error: result.stderr.slice(0, 160) || "brain recent failed",
    };
  }
  return {
    ok: true,
    health: "ok",
    measuredAt: new Date().toISOString(),
    items: parseRecent(result.stdout),
  };
}

export async function searchBrain(
  pathsCfg: BoardExtensionPaths,
  query: string,
  n: number,
): Promise<BrainFeedPayload> {
  const q = clampText(query, MAX_SEARCH);
  if (!q) {
    return {
      ok: false,
      health: "unavailable",
      measuredAt: null,
      items: [],
      error: "empty_query",
    };
  }
  const limit = toLimit(n, 10, 20);
  const result = await runBrain(pathsCfg, ["search", q, "-n", String(limit)]);
  if (result.code !== 0) {
    return {
      ok: false,
      health: "unavailable",
      measuredAt: null,
      items: [],
      error: result.stderr.slice(0, 160) || "brain search failed",
    };
  }
  const items: BrainNoteItem[] = [];
  const seenSlug = new Set<string>();
  for (const line of result.stdout.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("No matches")) continue;
    /* brain.py prints: <folder/slug>\t<title>\ttags=...\t[kw|sem|kw+sem] */
    const parts = t.split("\t");
    const p0 = parts[0];
    const p1 = parts[1];
    if (parts.length >= 2 && p0 !== undefined && p0.includes("/") && p1 !== undefined) {
      const slug = p0.trim();
      if (seenSlug.has(slug)) continue;
      seenSlug.add(slug);
      const excerpt = parts.slice(2).join(" ").trim() || undefined;
      items.push({
        slug,
        title: p1.trim(),
        excerpt,
      });
    } else {
      const slug = t;
      if (seenSlug.has(slug)) continue;
      seenSlug.add(slug);
      items.push({ title: t, slug: t });
    }
  }
  return {
    ok: true,
    health: "ok",
    measuredAt: new Date().toISOString(),
    items: items.slice(0, limit),
  };
}

export type BrainProfilePayload = {
  ok: boolean;
  configured: boolean;
  title?: string;
  purpose?: string;
  error?: string;
};

export async function getOwnerBrainProfile(
  pathsCfg: BoardExtensionPaths,
): Promise<BrainProfilePayload> {
  const slug = pathsCfg.brainOwnerProfileSlug;
  if (!slug) {
    return { ok: true, configured: false };
  }
  const note = await readBrainNote(pathsCfg, slug);
  if (!note.ok) {
    return { ok: false, configured: true, error: note.error || "not_found" };
  }
  return {
    ok: true,
    configured: true,
    title: note.title,
    purpose: profilePurposeFromNoteBody(note.body || ""),
  };
}

export async function readBrainNote(
  pathsCfg: BoardExtensionPaths,
  slug: string,
): Promise<BrainReadPayload> {
  if (!isSafeBrainSlug(slug)) {
    return { ok: false, slug, error: "invalid_slug" };
  }
  const result = await runBrain(pathsCfg, ["read", slug]);
  if (result.code !== 0) {
    return { ok: false, slug, error: result.stderr.slice(0, 160) || "not_found" };
  }
  const body = result.stdout;
  const titleLine = body.split("\n").find((l) => l.startsWith("# "));
  return {
    ok: true,
    slug,
    title: titleLine?.slice(2).trim(),
    body,
  };
}

export async function captureBrainNote(
  pathsCfg: BoardExtensionPaths,
  text: string,
  title?: string,
): Promise<BrainCapturePayload> {
  const content = text.trim();
  if (!content) {
    return { ok: false, message: "", error: "empty_body" };
  }
  /* Reject over-limit input rather than silently truncating the owner's words. */
  if (content.length > MAX_CAPTURE) {
    return { ok: false, message: "", error: "body_too_long" };
  }
  if (title?.trim()) {
    const t = title.trim();
    if (t.length > MAX_TITLE) {
      return { ok: false, message: "", error: "title_too_long" };
    }
    const result = await runBrain(pathsCfg, [
      "add",
      t,
      "-t",
      "ground",
      "-f",
      "projects",
      "-c",
      content,
    ]);
    if (result.code !== 0) {
      return {
        ok: false,
        message: "",
        error: result.stderr.slice(0, 160) || "capture_failed",
      };
    }
    const loc = result.stdout.trim().split("\n").pop() || "projects";
    return { ok: true, message: `Saved “${t}”`, location: loc };
  }
  const result = await runBrain(pathsCfg, ["capture", content]);
  if (result.code !== 0) {
    return {
      ok: false,
      message: "",
      error: result.stderr.slice(0, 160) || "capture_failed",
    };
  }
  return {
    ok: true,
    message: "Captured to inbox",
    location: "inbox/captures.md",
  };
}
