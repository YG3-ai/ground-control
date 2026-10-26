/**
 * Second Brain textual corpus aggregate (owner-only) — duplicated in board.html.
 *
 * Canonical source: `brain stats` JSON (same totals as second-brain/web `/api/graph`
 * `stats.words` / `stats.notes` — whitespace-split word count on note bodies).
 */

/** Documented read-speed assumption for Home + Archive copy. */
export const BRAIN_READ_WPM = 225;

/** Metric name returned by `brain stats` and graph UI. */
export const BRAIN_CORPUS_METRIC = "words" as const;

export const BRAIN_CORPUS_SOURCE = "brain_stats" as const;

export type BrainCorpusAggregate = {
  ok: boolean;
  source: typeof BRAIN_CORPUS_SOURCE;
  metric: typeof BRAIN_CORPUS_METRIC;
  /** Note count (`brain stats` `notes`). */
  documents: number;
  words: number;
  measuredAt: string | null;
  error?: string;
};

export type BrainStatsJson = {
  notes?: number;
  words?: number;
  vault?: string;
};

/** Parse stdout from `brain stats` — single authoritative vault aggregate. */
export function parseBrainStatsStdout(stdout: string): BrainCorpusAggregate | null {
  try {
    const raw = JSON.parse(stdout.trim()) as BrainStatsJson;
    const documents = typeof raw.notes === "number" ? raw.notes : 0;
    const words = typeof raw.words === "number" ? raw.words : 0;
    if (!Number.isFinite(documents) || !Number.isFinite(words)) return null;
    return {
      ok: true,
      source: BRAIN_CORPUS_SOURCE,
      metric: BRAIN_CORPUS_METRIC,
      documents,
      words,
      measuredAt: null,
    };
  } catch {
    return null;
  }
}

export function formatBrainReadTime(words: number): { value: string; unit: string } {
  if (!Number.isFinite(words) || words <= 0) {
    return { value: "UNAVAILABLE", unit: "" };
  }
  const minutes = words / BRAIN_READ_WPM;
  if (minutes < 60) {
    const m = Math.max(1, Math.round(minutes));
    return { value: String(m), unit: m === 1 ? "MIN TO READ" : "MINS TO READ" };
  }
  const hours = Math.round(minutes / 60);
  return { value: String(hours), unit: "H TO READ" };
}

export function formatCorpusWordCount(words: number): string {
  if (!Number.isFinite(words) || words < 0) return "";
  if (words === 0) return "0 words";
  return words.toLocaleString("en-US") + " words";
}

export type BrainCorpusSignalState = "loading" | "ready" | "unavailable";

export function resolveBrainCorpusLoadState(
  corpus: BrainCorpusAggregate | null | undefined,
  phase: "loading" | "settled",
): BrainCorpusSignalState {
  if (phase === "loading") return "loading";
  if (!corpus || !corpus.ok) return "unavailable";
  if (!Number.isFinite(corpus.words) || corpus.words < 0) return "unavailable";
  return "ready";
}

export type BrainCorpusPresentation = {
  archiveWordCountLabel: string;
  homeLongTermMemory: {
    id: "long_term_memory";
    label: string;
    value: string;
    unit: string;
    tone: "live" | "wait" | "off" | "idle";
  };
  words: number;
  readTime: { value: string; unit: string };
};

/** Home + Archive must derive from the same aggregate — regression anchor. */
export function brainCorpusPresentation(
  state: BrainCorpusSignalState,
  corpus: BrainCorpusAggregate | null | undefined,
): BrainCorpusPresentation | null {
  if (state === "loading") {
    return {
      words: 0,
      readTime: { value: "LOADING", unit: "" },
      archiveWordCountLabel: "",
      homeLongTermMemory: {
        id: "long_term_memory",
        label: "LONG-TERM MEMORY",
        value: "LOADING",
        unit: "",
        tone: "wait",
      },
    };
  }
  if (state !== "ready" || !corpus || !corpus.ok) return null;
  const words = corpus.words;
  const readTime = formatBrainReadTime(words);
  const homeValue =
    words > 0 ? readTime.value : "0";
  const homeUnit =
    words > 0 ? readTime.unit : "WORDS";
  return {
    words,
    readTime,
    archiveWordCountLabel: formatCorpusWordCount(words),
    homeLongTermMemory: {
      id: "long_term_memory",
      label: "LONG-TERM MEMORY",
      value: homeValue,
      unit: homeUnit,
      tone: words > 0 ? "live" : "idle",
    },
  };
}

export function resolveBrainCorpusLongTermSignal(
  owner: boolean,
  state: BrainCorpusSignalState,
  corpus: BrainCorpusAggregate | null | undefined,
): {
  id: "long_term_memory";
  label: string;
  value: string;
  unit: string;
  tone: "live" | "wait" | "off" | "idle";
} | null {
  if (!owner) return null;
  const pres = brainCorpusPresentation(state, corpus);
  if (!pres) {
    return {
      id: "long_term_memory",
      label: "LONG-TERM MEMORY",
      value: "UNAVAILABLE",
      unit: "",
      tone: "off",
    };
  }
  return pres.homeLongTermMemory;
}
