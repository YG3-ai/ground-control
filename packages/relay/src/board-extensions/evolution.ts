import type { Express } from "express";
import type { RelayConfig } from "../config.js";
import { boardWriteAuth } from "../board-auth.js";
import type { WorkerHub } from "../worker-hub.js";

const ID_RE = /^[a-zA-Z0-9-]{1,64}$/;
const CANDIDATE_KINDS = new Set([
  "capability",
  "turning_point",
  "chapter",
  "badge",
]);
const CANDIDATE_STATUSES = new Set([
  "proposed",
  "accepted",
  "dismissed",
  "corrected",
  "superseded",
]);
const DECISION_ACTIONS = new Set(["accept", "dismiss", "correct"]);

/**
 * Ground Life Mirror — Phase 4 presentation seam. Owner-only: every route
 * requires a valid board key via boardWriteAuth (public read-only audiences
 * never qualify; a missing/invalid key gets a bare 401 before any data is
 * touched). There is intentionally NO rebuild route here — the phone can
 * read candidates and record decisions, nothing more.
 */
export function registerEvolutionRoutes(
  app: Express,
  cfg: RelayConfig,
  hub: WorkerHub,
): void {
  app.get("/api/board/evolution/summary", async (req, res) => {
    if (!boardWriteAuth(req, res, cfg)) return;
    if (!hub.connected) {
      res.status(503).json({ error: "worker_offline" });
      return;
    }
    try {
      res.json(await hub.request("meaning_summary", {}, cfg.ownerId, 15_000));
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get("/api/board/evolution/candidates", async (req, res) => {
    if (!boardWriteAuth(req, res, cfg)) return;
    const kind = String(req.query.kind ?? "").trim();
    const status = String(req.query.status ?? "").trim();
    if (kind && !CANDIDATE_KINDS.has(kind)) {
      res.status(400).json({ error: "invalid_kind" });
      return;
    }
    if (status && !CANDIDATE_STATUSES.has(status)) {
      res.status(400).json({ error: "invalid_status" });
      return;
    }
    if (!hub.connected) {
      res.status(503).json({ error: "worker_offline" });
      return;
    }
    try {
      res.json(
        await hub.request(
          "list_meaning_candidates",
          {
            ...(kind ? { kind } : {}),
            ...(status ? { status } : {}),
          },
          cfg.ownerId,
          15_000,
        ),
      );
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get("/api/board/evolution/candidates/:id", async (req, res) => {
    if (!boardWriteAuth(req, res, cfg)) return;
    const id = String(req.params.id ?? "").trim();
    if (!ID_RE.test(id)) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    if (!hub.connected) {
      res.status(503).json({ error: "worker_offline" });
      return;
    }
    try {
      const got = await hub.request(
        "get_meaning_candidate",
        { id },
        cfg.ownerId,
        15_000,
      );
      if (got == null) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json(got);
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post("/api/board/evolution/candidates/:id", async (req, res) => {
    if (!boardWriteAuth(req, res, cfg)) return;
    const id = String(req.params.id ?? "").trim();
    if (!ID_RE.test(id)) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const body = req.body as {
      action?: unknown;
      label?: unknown;
      note?: unknown;
    };
    const action = String(body?.action ?? "").trim();
    if (!DECISION_ACTIONS.has(action)) {
      res.status(400).json({ error: "invalid_action" });
      return;
    }
    const label =
      body?.label != null ? String(body.label).slice(0, 200) : undefined;
    const note =
      body?.note != null ? String(body.note).slice(0, 2000) : undefined;
    if (action === "correct" && !label && !note) {
      res.status(400).json({ error: "correct_requires_label_or_note" });
      return;
    }
    if (!hub.connected) {
      res.status(503).json({ error: "worker_offline" });
      return;
    }
    try {
      res.json(
        await hub.request(
          "decide_meaning_candidate",
          { id, action, label, note },
          cfg.ownerId,
          15_000,
        ),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("candidate not found")) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.status(502).json({ error: msg });
    }
  });
}
