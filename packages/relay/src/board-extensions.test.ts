import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  clampText,
  isSafeBrainSlug,
  runBounded,
} from "./board-extensions/safe-exec.js";
import { inProgressMissions } from "./board-extensions/mission-filters.js";
import {
  clearSkillsCache,
  computeLevel,
  getSkillsPayload,
  SKILLS_NOTE_SLUG,
} from "./board-extensions/skills.js";
import {
  captureBrainNote,
  clearBrainCorpusCache,
  getBrainCorpus,
} from "./board-extensions/brain.js";
import { brainCorpusPresentation, formatBrainReadTime } from "./board-brain-corpus.js";
import { clearGrowthCache, getGrowthFeed } from "./board-extensions/growth.js";
import { resolveBoardExtensionPaths } from "./board-extensions/paths.js";

const REAL_BRAIN_ROOT = "/Users/partha/second-brain";
const haveRealBrainCli =
  existsSync(join(REAL_BRAIN_ROOT, ".venv/bin/python")) &&
  existsSync(join(REAL_BRAIN_ROOT, "brain.py"));

function tmpVault(tag: string): string {
  const root = join(tmpdir(), `ground-brain-${tag}-${Date.now()}`);
  for (const f of ["inbox", "notes", "daily", "projects"]) {
    mkdirSync(join(root, f), { recursive: true });
  }
  return root;
}

function pathsFor(vault: string) {
  return resolveBoardExtensionPaths(join(import.meta.dirname, ".."), {
    ...process.env,
    BRAIN_VAULT: vault,
    BRAIN_ROOT: REAL_BRAIN_ROOT,
  });
}

describe("board extension safety", () => {
  it("rejects unsafe brain slugs", () => {
    expect(isSafeBrainSlug("notes/foo-bar")).toBe(true);
    expect(isSafeBrainSlug("../etc/passwd")).toBe(false);
    expect(isSafeBrainSlug("a;rm -rf")).toBe(false);
  });

  it("clamps capture text", () => {
    expect(clampText("  hi  ", 10)).toBe("hi");
    expect(clampText("x".repeat(20), 5)).toHaveLength(5);
  });
});

describe("mission filters", () => {
  it("lists only active columns, never terminal ones", () => {
    const cols = {
      implementing: [{ id: "m1", title: "Mobile shell", status: "implementing" }],
      researching: [{ id: "r1", title: "Research only", status: "researching" }],
      done: [{ id: "d1", title: "Terrane prospect review", status: "done" }],
    };
    const rows = inProgressMissions(cols);
    expect(rows.some((r) => r.id === "m1")).toBe(true);
    expect(rows.some((r) => r.id === "r1")).toBe(false);
    expect(rows.some((r) => r.id === "d1")).toBe(false);
  });

  it("does not suppress by id or title", () => {
    const cols = {
      implementing: [
        { id: "f59b659f-f667-4249-8045-d0bb4a431ae0", title: "Terrane prospect", status: "implementing" },
      ],
    };
    const rows = inProgressMissions(cols);
    expect(rows).toHaveLength(1);
  });
});

describe("skills level rule", () => {
  it("counts distinct verified, excludes composites", () => {
    const nodes = [
      { id: "a", name: "A", branch: "Engineering" as const, status: "verified" as const, evidence: "", authority: "", health: "" },
      { id: "b", name: "B", branch: "Growth" as const, status: "verified" as const, evidence: "", authority: "", health: "" },
      { id: "ab", name: "AB", branch: "Growth" as const, status: "verified" as const, evidence: "", authority: "", health: "", compositeOf: ["a", "b"] },
      { id: "c", name: "C", branch: "Growth" as const, status: "partial" as const, evidence: "", authority: "", health: "" },
    ];
    expect(computeLevel(nodes)).toBe(2);
  });
});

describe.skipIf(!haveRealBrainCli)("brain-backed skills", () => {
  it("loads capability note from an isolated vault and dedupes ids", async () => {
    clearSkillsCache();
    const vault = tmpVault("skills");
    writeFileSync(
      join(vault, "projects", "ground-capabilities.md"),
      [
        "---",
        "title: Ground capabilities",
        "tags: [ground]",
        "created: 2026-10-23T00:00:00",
        "updated: 2026-10-23T00:00:00",
        "---",
        "",
        "# Ground capabilities",
        "",
        "## Thing one",
        "- id: one",
        "- branch: Engineering",
        "- status: verified",
        "- proof: seen",
        "- authority: test",
        "- health: ok",
        "",
        "## Thing one duplicate",
        "- id: one",
        "- branch: Engineering",
        "- status: verified",
        "",
        "## Thing two",
        "- id: two",
        "- branch: Growth",
        "- status: partial",
        "",
      ].join("\n"),
    );
    const payload = await getSkillsPayload(pathsFor(vault));
    expect(payload.ok).toBe(true);
    expect(payload.source).toBe("brain");
    expect(payload.nodes).toHaveLength(2);
    expect(payload.level).toBe(1);
    expect(payload.nodes[0]?.evidence).toBe("seen");
  });

  it("reports unavailable when the note is missing", async () => {
    clearSkillsCache();
    const vault = tmpVault("skills-empty");
    const payload = await getSkillsPayload(pathsFor(vault));
    expect(payload.ok).toBe(false);
    expect(payload.level).toBeNull();
    expect(payload.nodes).toHaveLength(0);
  });

  it("captures into the isolated vault only, never the real one", async () => {
    const vault = tmpVault("capture");
    const pathsCfg = pathsFor(vault);
    const result = await captureBrainNote(pathsCfg, `test capture ${Date.now()}`);
    expect(result.ok).toBe(true);
    const capPath = join(vault, "inbox", "captures.md");
    expect(existsSync(capPath)).toBe(true);
    expect(readFileSync(capPath, "utf8")).toContain("test capture");
    expect(pathsCfg.brainVault).toBe(vault);
  });

  it("rejects over-limit captures without truncation", async () => {
    const vault = tmpVault("capture-limit");
    const pathsCfg = pathsFor(vault);
    const long = "x".repeat(8001);
    const result = await captureBrainNote(pathsCfg, long);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("body_too_long");
    expect(existsSync(join(vault, "inbox", "captures.md"))).toBe(false);
    const titled = await captureBrainNote(pathsCfg, "ok body", "t".repeat(201));
    expect(titled.ok).toBe(false);
    expect(titled.error).toBe("title_too_long");
  });
});

describe.skipIf(!haveRealBrainCli)("brain corpus (canonical stats)", () => {
  it("getBrainCorpus matches brain stats word totals for Home and Archive", async () => {
    const pathsCfg = resolveBoardExtensionPaths(join(import.meta.dirname, ".."), {
      ...process.env,
      BRAIN_ROOT: REAL_BRAIN_ROOT,
    });
    const corpus = await getBrainCorpus(pathsCfg);
    expect(corpus.ok).toBe(true);
    expect(corpus.source).toBe("brain_stats");
    expect(corpus.metric).toBe("words");
    expect(corpus.documents).toBeGreaterThan(100);
    expect(corpus.words).toBeGreaterThan(100_000);
    const pres = brainCorpusPresentation("ready", corpus);
    expect(pres?.words).toBe(corpus.words);
    expect(pres?.homeLongTermMemory.value).toBe(formatBrainReadTime(corpus.words).value);
    expect(pres?.archiveWordCountLabel).toContain(String(corpus.words.toLocaleString("en-US")));
  });
});

describe("optional adapters", () => {
  it("brain corpus is unavailable when brain env is unset", async () => {
    const env = { ...process.env };
    for (const k of [
      "GROUND_CONTROL_WORK_ROOT",
      "PARTHA_WORK_ROOT",
      "BRAIN_ROOT",
      "BRAIN_VAULT",
      "BRAIN_PYTHON",
      "BRAIN_SCRIPT",
    ]) {
      delete env[k];
    }
    const pathsCfg = resolveBoardExtensionPaths(join(import.meta.dirname, ".."), env);
    clearBrainCorpusCache();
    const corpus = await getBrainCorpus(pathsCfg);
    expect(corpus.ok).toBe(false);
    expect(corpus.health).toBe("unavailable");
  });
});

describe("growth unavailable", () => {
  it("does not zero-fill when source missing", async () => {
    clearGrowthCache();
    const root = join(tmpdir(), `ground-growth-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, ".env.local"), "NEXT_PUBLIC_SUPABASE_URL=\n");
    const pathsCfg = resolveBoardExtensionPaths(join(import.meta.dirname, ".."), {
      ...process.env,
      GROUND_CONTROL_WORK_ROOT: root,
      FUNNELS_LOOPBACK_URL: "http://127.0.0.1:1",
    });
    const payload = await getGrowthFeed("7d", pathsCfg);
    expect(payload.ok).toBe(false);
    expect(payload.summary.visits).toBeNull();
    expect(payload.health).toBe("unavailable");
  });
});

describe("runBounded", () => {
  it("does not use shell interpolation", async () => {
    const node = process.execPath;
    const r = await runBounded(node, ["-e", "process.stdout.write('ok')"], {
      timeoutMs: 5000,
      maxBuffer: 1000,
    });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("ok");
  });
});
