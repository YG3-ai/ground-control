import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  boardOwnerHydrated,
  buildHomeSuitHud,
  HOME_STATUS_LABEL,
  HOME_STATUS_READY,
  HOME_STATUS_WORKING,
  homeReadoutUsesLiveCopy,
  resolveHomeStatusTitle,
} from "./board-home-instrument.js";

const NOW = Date.parse("2026-03-22T12:00:00.000Z");
const RECENT = new Date(NOW - 30_000).toISOString();
const STALE = new Date(NOW - 600_000).toISOString();

function loadShippedHomeSuitHud() {
  const html = readFileSync(join(import.meta.dirname, "board.html"), "utf8");
  const m = html.match(
    /\/\* __home_suit_hud_start__ \*\/([\s\S]*?)\/\* __home_suit_hud_end__ \*\//,
  );
  if (!m) throw new Error("home suit hud block not found in board.html");
  return new Function(
    `"use strict";${m[1]}; return { buildHomeSuitHud, homeReadoutUsesLiveCopy, boardOwnerHydrated };`,
  )() as {
    buildHomeSuitHud: typeof buildHomeSuitHud;
    homeReadoutUsesLiveCopy: typeof homeReadoutUsesLiveCopy;
    boardOwnerHydrated: typeof boardOwnerHydrated;
  };
}

describe("boardOwnerHydrated", () => {
  it("is false when owner still has public_preview board", () => {
    expect(boardOwnerHydrated({ public_preview: true, health: { worker: true } }, true)).toBe(
      false,
    );
  });
  it("is false for anonymous public shell", () => {
    expect(boardOwnerHydrated({ health: { worker: true }, tasks: [{ status: "running" }] }, false)).toBe(
      false,
    );
  });
  it("is true when owner board is full", () => {
    expect(boardOwnerHydrated({ health: { worker: true } }, true)).toBe(true);
  });
});

describe("buildHomeSuitHud", () => {
  it("hides numeric placeholders on stale public_preview owner board", () => {
    const model = buildHomeSuitHud({
      board: {
        public_preview: true,
        health: { worker: true },
        tasks: [],
        terminal_sessions: [],
      },
      owner: true,
      attention: 0,
      decisions: 0,
      boardHydrated: false,
      brainCorpusState: "unavailable",
    });
    expect(model.signals).toEqual([]);
    expect(model.conn).toBe("sync");
    expect(homeReadoutUsesLiveCopy(model)).toBe(true);
  });

  it("shows active jobs at zero without SYSTEM row on Home", () => {
    const model = buildHomeSuitHud({
      board: {
        health: { worker: true },
        tasks: [],
        terminal_sessions: [
          { state: "running", kind: "cursor", last_activity_at: STALE },
          { state: "waiting", kind: "shell" },
        ],
      },
      owner: true,
      attention: 0,
      decisions: 0,
      boardHydrated: true,
      brainCorpusState: "ready",
      brainCorpus: {
        ok: true,
        source: "brain_stats",
        metric: "words",
        documents: 10,
        words: 50_000,
        measuredAt: null,
      },
      nowMs: NOW,
    });
    expect(model.project).toEqual({
      label: HOME_STATUS_LABEL,
      title: HOME_STATUS_READY,
      detail: null,
      attention: false,
    });
    expect(model.signals.find((s) => s.id === "intelligence")).toBeUndefined();
    expect(model.signals.find((s) => s.id === "active_jobs")).toEqual({
      id: "active_jobs",
      label: "ACTIVE JOBS",
      value: "0",
      unit: "JOBS",
      tone: "idle",
    });
    expect(model.signals.some((s) => s.id === "processing")).toBe(false);
    expect(model.signals.some((s) => s.id === "active_terminals")).toBe(false);
    expect(model.signals.some((s) => s.value === "QUIET")).toBe(false);
    expect(homeReadoutUsesLiveCopy(model)).toBe(true);
  });

  it("stays COOLING when jobs or terminals run without an active project", () => {
    const fromJob = buildHomeSuitHud({
      board: {
        health: { worker: true },
        tasks: [{ status: "running" }],
        terminal_sessions: [],
      },
      owner: true,
      attention: 0,
      decisions: 0,
      boardHydrated: true,
      brainCorpusState: "ready",
      brainCorpus: {
        ok: true,
        source: "brain_stats",
        metric: "words",
        documents: 1,
        words: 10_000,
        measuredAt: null,
      },
      nowMs: NOW,
    });
    expect(fromJob.signals.find((s) => s.id === "intelligence")).toBeUndefined();
    expect(fromJob.signals.find((s) => s.id === "active_jobs")?.value).toBe("1");

    const fromTerm = buildHomeSuitHud({
      board: {
        health: { worker: true },
        tasks: [],
        terminal_sessions: [
          { state: "running", kind: "cursor", last_activity_at: RECENT },
        ],
      },
      owner: true,
      attention: 0,
      decisions: 0,
      boardHydrated: true,
      brainCorpusState: "ready",
      brainCorpus: {
        ok: true,
        source: "brain_stats",
        metric: "words",
        documents: 1,
        words: 10_000,
        measuredAt: null,
      },
      nowMs: NOW,
    });
    expect(fromTerm.signals.find((s) => s.id === "intelligence")).toBeUndefined();
    expect(fromTerm.signals.find((s) => s.id === "active_jobs")?.value).toBe("0");
    expect(fromTerm.signals.some((s) => s.id === "active_terminals")).toBe(false);
  });

  it("active managed jobs show STATUS WORKING never mission title", () => {
    const model = buildHomeSuitHud({
      board: {
        health: { worker: true },
        missions: [
          {
            id: "m1",
            title: "Mirror HUD",
            status: "implementing",
            updated_at: "2026-03-02T00:00:00Z",
            linked_job_ids: ["j1"],
            markers: { project_origin: "user_led", project_active: true },
          },
        ],
        system_state: {
          state: "on_a_project",
          label: "ON A PROJECT",
          origin: "user_led",
          mission_id: "m1",
          title: "Mirror HUD",
        },
        user_led_project: {
          active: true,
          origin: "user_led",
          mission_id: "m1",
          title: "Mirror HUD",
        },
        tasks: [{ id: "j1", status: "running" }],
        terminal_sessions: [],
      },
      owner: true,
      attention: 0,
      decisions: 0,
      boardHydrated: true,
      nowMs: NOW,
    });
    expect(model.project?.label).toBe(HOME_STATUS_LABEL);
    expect(model.project?.title).toBe(HOME_STATUS_WORKING);
    expect(model.project?.title).not.toBe("Mirror HUD");
    expect(model.signals.find((s) => s.id === "active_jobs")?.value).toBe("1");
  });

  it("resolveHomeStatusTitle maps job count to READY or WORKING", () => {
    expect(resolveHomeStatusTitle(0)).toBe(HOME_STATUS_READY);
    expect(resolveHomeStatusTitle(1)).toBe(HOME_STATUS_WORKING);
    expect(resolveHomeStatusTitle(3)).toBe(HOME_STATUS_WORKING);
  });

  it("owner zero active jobs shows STATUS READY dominant readout", () => {
    const model = buildHomeSuitHud({
      board: { health: { worker: true }, tasks: [], terminal_sessions: [] },
      owner: true,
      attention: 0,
      decisions: 0,
      boardHydrated: true,
      brainCorpusState: "ready",
      nowMs: NOW,
    });
    expect(model.project?.label).toBe("STATUS");
    expect(model.project?.title).toBe("READY");
    expect(model.signals.find((s) => s.id === "active_jobs")?.value).toBe("0");
  });

  it("focus title from project_active while jobs idle stays COOLING semantically", () => {
    const model = buildHomeSuitHud({
      board: {
        health: { worker: true },
        missions: [
          {
            id: "m1",
            title: "Mirror HUD",
            status: "implementing",
            linked_job_ids: ["j1"],
            markers: { project_origin: "user_led" },
          },
        ],
        system_state: {
          state: "on_a_project",
          label: "ON A PROJECT",
          origin: "user_led",
          mission_id: "m1",
          title: "Mirror HUD",
        },
        tasks: [],
        terminal_sessions: [],
      },
      owner: true,
      attention: 0,
      decisions: 0,
      boardHydrated: true,
      nowMs: NOW,
    });
    expect(model.project?.label).toBe(HOME_STATUS_LABEL);
    expect(model.project?.title).toBe(HOME_STATUS_READY);
    expect(model.signals.find((s) => s.id === "active_jobs")?.value).toBe("0");
  });

  it("active job without linked mission shows STATUS WORKING not stale mission title", () => {
    const model = buildHomeSuitHud({
      board: {
        health: { worker: true },
        missions: [
          {
            id: "m1",
            title: "Stale board marker",
            status: "implementing",
            linked_job_ids: [],
            markers: { project_active: true },
          },
        ],
        system_state: {
          state: "on_a_project",
          label: "ON A PROJECT",
          mission_id: "m1",
          title: "Stale board marker",
        },
        tasks: [{ id: "orphan", status: "running" }],
        terminal_sessions: [],
      },
      owner: true,
      attention: 0,
      decisions: 0,
      boardHydrated: true,
      nowMs: NOW,
    });
    expect(model.project?.label).toBe(HOME_STATUS_LABEL);
    expect(model.project?.title).toBe(HOME_STATUS_WORKING);
    expect(model.signals.find((s) => s.id === "active_jobs")?.value).toBe("1");
  });

  it("autonomous learning job shows STATUS WORKING not mission title", () => {
    const model = buildHomeSuitHud({
      board: {
        health: { worker: true },
        missions: [
          {
            id: "l1",
            title: "Vault sleep",
            status: "implementing",
            linked_job_ids: ["j1"],
            markers: { project_origin: "autonomous_learning" },
          },
        ],
        system_state: {
          state: "learning",
          label: "LEARNING",
          origin: "autonomous_learning",
          mission_id: "l1",
          title: "Vault sleep",
        },
        learning_activity: {
          active: true,
          origin: "autonomous_learning",
          mission_id: "l1",
          title: "Vault sleep",
          source: "cron:brain_sleep",
        },
        tasks: [{ id: "j1", status: "queued" }],
        terminal_sessions: [{ state: "running", kind: "cursor", last_activity_at: STALE }],
      },
      owner: true,
      attention: 0,
      decisions: 0,
      boardHydrated: true,
      nowMs: NOW,
    });
    expect(model.project?.title).toBe(HOME_STATUS_WORKING);
    expect(model.project?.title).not.toBe("Vault sleep");
    expect(model.signals.find((s) => s.id === "active_jobs")?.value).toBe("1");
    expect(model.signals.some((s) => s.id === "active_terminals")).toBe(false);
  });

  it("shows corpus loading then read time when ready", () => {
    const loading = buildHomeSuitHud({
      board: { health: { worker: true }, tasks: [], terminal_sessions: [] },
      owner: true,
      attention: 0,
      decisions: 0,
      boardHydrated: true,
      brainCorpusState: "loading",
      nowMs: NOW,
    });
    expect(loading.signals.find((s) => s.id === "long_term_memory")?.value).toBe("LOADING");

    const ready = buildHomeSuitHud({
      board: { health: { worker: true }, tasks: [], terminal_sessions: [] },
      owner: true,
      attention: 0,
      decisions: 0,
      boardHydrated: true,
      brainCorpusState: "ready",
      brainCorpus: {
        ok: true,
        source: "brain_stats",
        metric: "words",
        documents: 2,
        words: 450,
        measuredAt: null,
      },
      nowMs: NOW,
    });
    expect(ready.signals.find((s) => s.id === "long_term_memory")).toEqual({
      id: "long_term_memory",
      label: "LONG-TERM MEMORY",
      value: "2",
      unit: "MINS TO READ",
      tone: "live",
    });
  });

  it("public shell omits job telemetry and corpus size", () => {
    const board = {
      health: { worker: true },
      public_preview: true,
      tasks: [{ status: "running" }],
      terminal_sessions: [{ state: "running", kind: "cursor" }],
    };
    const model = buildHomeSuitHud({
      board,
      owner: false,
      attention: 0,
      decisions: 0,
      boardHydrated: boardOwnerHydrated(board, false),
      brainCorpusState: "ready",
      brainCorpus: {
        ok: true,
        source: "brain_stats",
        metric: "words",
        documents: 99,
        words: 99_999,
        measuredAt: null,
      },
      nowMs: NOW,
    });
    expect(model.signals).toEqual([]);
    expect(model.signals.find((s) => s.id === "long_term_memory")).toBeUndefined();
  });

  it("shipped board.html block stays aligned", () => {
    const shipped = loadShippedHomeSuitHud();
    const ctx = {
      board: {
        health: { worker: true },
        tasks: [{ status: "running" }],
        terminal_sessions: [{ state: "running", kind: "cursor", last_activity_at: RECENT }],
      },
      owner: true,
      attention: 0,
      decisions: 0,
      boardHydrated: true,
      brainCorpusState: "ready" as const,
      brainCorpus: {
        ok: true,
        source: "brain_stats",
        metric: "words",
        documents: 4,
        words: 12_000,
        measuredAt: null,
      },
      nowMs: NOW,
    };
    expect(shipped.buildHomeSuitHud(ctx)).toEqual(buildHomeSuitHud(ctx));
  });
});

describe("board.html home suit hud markers", () => {
  const html = readFileSync(join(import.meta.dirname, "board.html"), "utf8");

  it("ships system state helper and no PROCESSING stat", () => {
    expect(html).toContain("resolveSystemStateFromBoard");
    expect(html).toContain("PROJECT_ORIGIN_AUTONOMOUS_LEARNING");
    expect(html).not.toContain("DORMANT");
    expect(html).not.toContain("THINKING");
    expect(html).not.toMatch(/label:\s*owner\s*\?\s*"PROCESSING"/);
    expect(html).not.toMatch(/value:\s*"QUIET"/);
  });

  it("Home HUD has no project tap-through to Control", () => {
    expect(html).not.toContain("lm-home-project-tap");
    expect(html).toContain('id="lm-home-project-readout"');
  });

  it("Home uses 15% black veil above media below HUD", () => {
    expect(html).toContain('id="lm-home-background-veil"');
    expect(html).toMatch(/#lm-world-view\.lm-world-home-on \.lm-home-background-veil\s*\{[^}]*opacity:\s*0\.15/);
    expect(html).toContain("syncHomeBackgroundVeil");
  });

  it("Home HUD uses stacked full-width instrument rows without SYSTEM readout", () => {
    const hudBlock = html.match(
      /\/\* __home_suit_hud_start__ \*\/([\s\S]*?)\/\* __home_suit_hud_end__ \*\//,
    )?.[1];
    expect(hudBlock).toBeDefined();
    expect(hudBlock).not.toMatch(/id:\s*"intelligence"/);
    expect(hudBlock).toContain('id: "active_jobs"');
    expect(html).toMatch(/\.lm-home-instruments\s*\{[^}]*flex-direction:\s*column/);
    expect(html).toMatch(/\.lm-home-sig\s*\{[^}]*width:\s*100%/);
    expect(html).toMatch(/\.lm-home-sig\s*\{[^}]*border-bottom:/);
    expect(html).toContain("lm-home-sig-measure");
    expect(html).not.toMatch(/lm-home-sig-lbl[^}]*grid-column:\s*1\s*\/\s*-1/);
    expect(html).not.toMatch(/<span class="lm-home-sig-lbl">SYSTEM<\/span>/);
    expect(html).not.toMatch(/lm-home-sig-lbl[^}]*>\s*ON A PROJECT/);
  });
});
