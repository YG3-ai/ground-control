/**
 * HOME suit HUD — STATUS readout + compact telemetry (duplicated in board.html).
 */

import {
  type BrainCorpusAggregate,
  type BrainCorpusSignalState,
  resolveBrainCorpusLongTermSignal,
} from "./board-brain-corpus.js";
import { GROUND_CURRENT_PROJECT_RESTING_LABEL } from "./board-ground-present.js";

const ACTIVE_JOB = new Set([
  "queued",
  "preparing",
  "running",
  "awaiting_followup",
  "cancelling",
]);

export const HOME_PROJECT_OWNER_TITLE = "GROUND LIFE MIRROR";
export const HOME_PROJECT_PUBLIC_TITLE = "LIFE MIRROR";
export const HOME_STATUS_LABEL = "STATUS";
export const HOME_STATUS_READY = GROUND_CURRENT_PROJECT_RESTING_LABEL;
export const HOME_STATUS_WORKING = "WORKING";
/** @deprecated use HOME_STATUS_LABEL */
export const HOME_OWNER_RESTING_LABEL = HOME_STATUS_LABEL;
/** @deprecated use HOME_STATUS_READY */
export const HOME_OWNER_RESTING_TITLE = HOME_STATUS_READY;

export type HomeInstrumentTone = "live" | "wait" | "idle" | "off" | "warn";

export type HomeInstrumentSignal = {
  id: "intelligence" | "active_jobs" | "active_terminals" | "long_term_memory";
  label: string;
  value: string;
  unit: string;
  tone: HomeInstrumentTone;
};

export type HomeProjectReadout = {
  label: string;
  title: string;
  detail: string | null;
  attention: boolean;
};

export type HomeSuitHudModel = {
  project: HomeProjectReadout | null;
  signals: HomeInstrumentSignal[];
  /** Understated connectivity — never a labeled stat. */
  conn: "live" | "offline" | "sync";
};

export type HomeSuitHudCtx = {
  board: Record<string, unknown> | null | undefined;
  owner: boolean;
  attention: number;
  decisions: number;
  /** Owner board has left public_preview redaction. */
  boardHydrated: boolean;
  brainCorpusState?: BrainCorpusSignalState;
  brainCorpus?: BrainCorpusAggregate | null;
  /** Optional clock for cognitive terminal staleness (tests). */
  nowMs?: number;
};

export function boardOwnerHydrated(
  board: Record<string, unknown> | null | undefined,
  owner: boolean,
): boolean {
  if (!owner) return false;
  if (!board) return false;
  return !board.public_preview;
}

function tasks(board: Record<string, unknown> | null | undefined): Array<{ status?: string }> {
  if (!board) return [];
  return (board.tasks || board.active_tasks || []) as Array<{ status?: string }>;
}

function workerLinked(board: Record<string, unknown> | null | undefined): boolean {
  const health = board?.health as { worker?: boolean } | undefined;
  return !!(health && health.worker);
}

export function countHomeActiveManagedJobs(
  board: Record<string, unknown> | null | undefined,
): number {
  return tasks(board).filter((t) => ACTIVE_JOB.has(String(t.status || ""))).length;
}

export function resolveHomeStatusTitle(activeJobCount: number): string {
  return activeJobCount > 0 ? HOME_STATUS_WORKING : HOME_STATUS_READY;
}

export function buildHomeStatusReadout(
  activeJobCount: number,
  attention: boolean,
): HomeProjectReadout {
  return {
    label: HOME_STATUS_LABEL,
    title: resolveHomeStatusTitle(activeJobCount),
    detail: null,
    attention,
  };
}

export function buildHomeSuitHud(ctx: HomeSuitHudCtx): HomeSuitHudModel {
  const board = ctx.board;
  const linked = workerLinked(board);
  const hydrated = ctx.boardHydrated;
  const attentionTotal = ctx.attention + ctx.decisions;

  let conn: HomeSuitHudModel["conn"] = "offline";
  if (ctx.owner && board && board.public_preview) {
    conn = "sync";
  } else if (linked) {
    conn = "live";
  }

  const signals: HomeInstrumentSignal[] = [];
  const activeJobCount = countHomeActiveManagedJobs(board);
  const project = buildHomeStatusReadout(
    activeJobCount,
    ctx.owner && attentionTotal > 0 && activeJobCount > 0,
  );

  if (hydrated && linked) {
    signals.push({
      id: "active_jobs",
      label: ctx.owner ? "ACTIVE JOBS" : "JOBS",
      value: String(activeJobCount),
      unit: activeJobCount === 1 ? "JOB" : "JOBS",
      tone: activeJobCount > 0 ? "live" : "idle",
    });
  }

  if (ctx.owner && hydrated) {
    const corpusState: BrainCorpusSignalState = ctx.brainCorpusState ?? "loading";
    const ltm = resolveBrainCorpusLongTermSignal(true, corpusState, ctx.brainCorpus);
    if (ltm) signals.push(ltm);
  }

  return {
    project,
    signals,
    conn,
  };
}

/** HOME readout must never show placeholder telemetry. */
export function homeReadoutUsesLiveCopy(model: HomeSuitHudModel): boolean {
  const bad = /standby/i;
  if (
    model.project &&
    (bad.test(model.project.title) || bad.test(model.project.detail || ""))
  ) {
    return false;
  }
  const banned = /^(0|—|-|OFF|LINK|QUIET)$/i;
  for (const s of model.signals) {
    if (bad.test(s.value) || bad.test(s.unit)) return false;
    if (banned.test(s.value.trim()) && s.id !== "active_jobs") return false;
    if (/\bLINE\b/i.test(s.unit)) return false;
    if (s.id === "long_term_memory" && s.value === "0") return false;
  }
  return true;
}
