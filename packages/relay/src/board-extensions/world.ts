import type { Express, Request, Response } from "express";
import type { RelayConfig } from "../config.js";
import type { WorkerHub } from "../worker-hub.js";
import { publicWorldFeedDemo } from "./public-demo.js";
import { isPublicBoardAudience, type WorldListPayload } from "./public-redact.js";

const ENTITY_TYPES = new Set([
  "person",
  "agent",
  "organization",
  "mission",
  "service",
]);
const ID_RE = /^[a-zA-Z0-9:_-]{1,128}$/;

export type BoardAuthFn = (
  req: Request,
  res: Response,
  cfg: RelayConfig,
) => string | null;

/**
 * Board-safe world projection (owner key). Public read-only audiences receive
 * a redacted entity list with no private rows or org detail.
 */
export function registerWorldRoutes(
  app: Express,
  cfg: RelayConfig,
  hub: WorkerHub,
  boardReadAuth: BoardAuthFn,
): void {
  app.get("/api/board/world", async (req, res) => {
    const audience = boardReadAuth(req, res, cfg);
    if (!audience) return;
    const type = String(req.query.type ?? "").trim();
    const state = String(req.query.state ?? "").trim();
    if (type && !ENTITY_TYPES.has(type)) {
      res.status(400).json({ error: "invalid_type" });
      return;
    }
    if (isPublicBoardAudience(audience)) {
      res.json(publicWorldFeedDemo());
      return;
    }
    if (!hub.connected) {
      res.status(503).json({ error: "worker_offline" });
      return;
    }
    const includePrivate = true;
    try {
      const summary = await hub.request(
        "world_summary",
        { includePrivate },
        cfg.ownerId,
        15_000,
      );
      const listed = await hub.request(
        "list_world_entities",
        {
          ...(type ? { type } : {}),
          ...(state ? { state } : {}),
          includePrivate,
        },
        cfg.ownerId,
        15_000,
      );
      const payload: WorldListPayload = {
        ok: true,
        summary,
        entities: (listed as { entities?: WorldListPayload["entities"] }).entities ?? [],
      };
      res.json(payload);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("unknown method")) {
        res.status(503).json({ error: "world_unavailable" });
        return;
      }
      res.status(502).json({ error: msg });
    }
  });

  app.get("/api/board/world/entity", async (req, res) => {
    const audience = boardReadAuth(req, res, cfg);
    if (!audience) return;
    const id = String(req.query.id ?? "").trim();
    if (!ID_RE.test(id)) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    if (isPublicBoardAudience(audience)) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (!hub.connected) {
      res.status(503).json({ error: "worker_offline" });
      return;
    }
    try {
      const got = await hub.request(
        "get_world_entity",
        { id, includePrivate: true },
        cfg.ownerId,
        15_000,
      );
      if (got == null) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json(got);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("unknown method")) {
        res.status(503).json({ error: "world_unavailable" });
        return;
      }
      res.status(502).json({ error: msg });
    }
  });
}
