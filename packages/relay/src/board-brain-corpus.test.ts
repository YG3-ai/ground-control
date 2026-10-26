import { describe, expect, it } from "vitest";
import {
  BRAIN_READ_WPM,
  brainCorpusPresentation,
  formatBrainReadTime,
  formatCorpusWordCount,
  parseBrainStatsStdout,
  resolveBrainCorpusLoadState,
  resolveBrainCorpusLongTermSignal,
} from "./board-brain-corpus.js";

const SAMPLE_STATS = `{
  "vault": "/Users/partha/second-brain/vault",
  "notes": 2294,
  "words": 4948877
}`;

describe("parseBrainStatsStdout", () => {
  it("parses brain stats JSON (same metric as second-brain graph UI)", () => {
    const agg = parseBrainStatsStdout(SAMPLE_STATS);
    expect(agg).toMatchObject({
      ok: true,
      source: "brain_stats",
      metric: "words",
      documents: 2294,
      words: 4948877,
    });
  });
});

describe("resolveBrainCorpusLoadState", () => {
  it("marks settled ok payload ready even before client cache", () => {
    const agg = parseBrainStatsStdout(SAMPLE_STATS)!;
    expect(resolveBrainCorpusLoadState(agg, "settled")).toBe("ready");
    expect(resolveBrainCorpusLoadState(null, "loading")).toBe("loading");
    expect(resolveBrainCorpusLoadState({ ok: false, source: "brain_stats", metric: "words", documents: 0, words: 0, measuredAt: null }, "settled")).toBe("unavailable");
  });
});

describe("formatBrainReadTime", () => {
  it("uses 225 wpm and rounds hours for large corpora", () => {
    const words = 84 * 60 * BRAIN_READ_WPM;
    expect(formatBrainReadTime(words)).toEqual({ value: "84", unit: "H TO READ" });
    expect(formatBrainReadTime(4_948_877)).toEqual({ value: "367", unit: "H TO READ" });
  });

  it("shows minutes below one hour", () => {
    expect(formatBrainReadTime(112)).toEqual({ value: "1", unit: "MIN TO READ" });
    expect(formatBrainReadTime(450)).toEqual({ value: "2", unit: "MINS TO READ" });
  });
});

describe("brainCorpusPresentation", () => {
  it("keeps Home LTM and Archive word line on the same words total", () => {
    const corpus = parseBrainStatsStdout(SAMPLE_STATS)!;
    const pres = brainCorpusPresentation("ready", corpus);
    expect(pres?.archiveWordCountLabel).toBe("4,948,877 words");
    expect(pres?.words).toBe(4_948_877);
    expect(pres?.readTime).toEqual({ value: "367", unit: "H TO READ" });
    expect(pres?.homeLongTermMemory).toEqual({
      id: "long_term_memory",
      label: "LONG-TERM MEMORY",
      value: "367",
      unit: "H TO READ",
      tone: "live",
    });
    const viaResolver = resolveBrainCorpusLongTermSignal(true, "ready", corpus);
    expect(viaResolver).toEqual(pres?.homeLongTermMemory);
  });
});

describe("formatCorpusWordCount", () => {
  it("formats exact deduped word total for archive secondary copy", () => {
    expect(formatCorpusWordCount(4_948_877)).toBe("4,948,877 words");
    expect(formatCorpusWordCount(0)).toBe("0 words");
  });
});

describe("resolveBrainCorpusLongTermSignal", () => {
  it("is owner-only and redacts public", () => {
    expect(resolveBrainCorpusLongTermSignal(false, "ready", parseBrainStatsStdout(SAMPLE_STATS)!)).toBeNull();
  });

  it("surfaces loading and unavailable", () => {
    expect(resolveBrainCorpusLongTermSignal(true, "loading", null)?.value).toBe("LOADING");
    expect(resolveBrainCorpusLongTermSignal(true, "unavailable", null)?.value).toBe("UNAVAILABLE");
  });
});
