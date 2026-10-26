import type { Express, Request, Response } from "express";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RelayConfig } from "../config.js";
import {
  captureBrainNote,
  getBrainCorpus,
  getBrainRecent,
  getOwnerBrainProfile,
  readBrainNote,
  searchBrain,
  BRAIN_LIMITS,
} from "./brain.js";
import { getGrowthFeed } from "./growth.js";
import { getLifecycleFeed } from "./lifecycle.js";
import { getYg3AccountsFeed } from "./yg3-accounts.js";
import { getYg3SyncStatus, triggerYg3ManualSync } from "./yg3-sync.js";
import { resolveBoardExtensionPaths } from "./paths.js";
import { getSkillsPayload } from "./skills.js";
import {
  publicGrowthFeedDemo,
  publicLifecycleFeedDemo,
  publicNotesFictionFeed,
  publicNoteFictionRead,
  publicYg3AccountsFiction,
  publicYg3SyncStatusDemo,
} from "./public-demo.js";
import {
  isPublicBoardAudience,
  redactBrainReadForPublic,
} from "./public-redact.js";

const RELAY_SRC = dirname(fileURLToPath(import.meta.url));

export type BoardAuthFn = (
  req: Request,
  res: Response,
  cfg: RelayConfig,
) => string | null;

export function registerBoardExtensionRoutes(
  app: Express,
  cfg: RelayConfig,
  boardReadAuth: BoardAuthFn,
  boardWriteAuth: BoardAuthFn,
): void {
  const pathsCfg = resolveBoardExtensionPaths(join(RELAY_SRC, "..", ".."));

  app.get("/api/board/extensions/growth", async (req, res) => {
    const audience = boardReadAuth(req, res, cfg);
    if (!audience) return;
    const w = String(req.query.w ?? "7d").trim();
    if (!/^[a-zA-Z0-9_-]{1,24}$/.test(w)) {
      res.status(400).json({ error: "invalid_window" });
      return;
    }
    try {
      if (isPublicBoardAudience(audience)) {
        res.json(publicGrowthFeedDemo(w));
        return;
      }
      res.json(await getGrowthFeed(w, pathsCfg, RELAY_SRC));
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get("/api/board/extensions/yg3-sync/status", async (req, res) => {
    const audience = boardReadAuth(req, res, cfg);
    if (!audience) return;
    try {
      if (isPublicBoardAudience(audience)) {
        res.json(publicYg3SyncStatusDemo());
        return;
      }
      res.json(
        await getYg3SyncStatus(audience, join(RELAY_SRC, "..", "..")),
      );
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post("/api/board/extensions/yg3-sync/trigger", async (req, res) => {
    const audience = boardWriteAuth(req, res, cfg);
    if (!audience) return;
    if (isPublicBoardAudience(audience)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    try {
      res.json(
        await triggerYg3ManualSync(audience, join(RELAY_SRC, "..", "..")),
      );
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get("/api/board/extensions/yg3-accounts", async (req, res) => {
    const audience = boardReadAuth(req, res, cfg);
    if (!audience) return;
    if (isPublicBoardAudience(audience)) {
      res.json(publicYg3AccountsFiction());
      return;
    }
    try {
      res.json(await getYg3AccountsFeed(pathsCfg, RELAY_SRC));
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get("/api/board/extensions/lifecycle", async (req, res) => {
    const audience = boardReadAuth(req, res, cfg);
    if (!audience) return;
    try {
      if (isPublicBoardAudience(audience)) {
        res.json(publicLifecycleFeedDemo());
        return;
      }
      res.json(await getLifecycleFeed(pathsCfg, RELAY_SRC));
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get("/api/board/extensions/skills", async (req, res) => {
    const audience = boardReadAuth(req, res, cfg);
    if (!audience) return;
    if (isPublicBoardAudience(audience)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    try {
      res.json(await getSkillsPayload(pathsCfg));
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get("/api/board/extensions/notes/profile", async (req, res) => {
    const audience = boardReadAuth(req, res, cfg);
    if (!audience) return;
    try {
      if (isPublicBoardAudience(audience)) {
        res.json({ ok: true, configured: false });
        return;
      }
      res.json(await getOwnerBrainProfile(pathsCfg));
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get("/api/board/extensions/notes/corpus", async (req, res) => {
    const audience = boardReadAuth(req, res, cfg);
    if (!audience) return;
    if (isPublicBoardAudience(audience)) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return;
    }
    try {
      res.json(await getBrainCorpus(pathsCfg));
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get("/api/board/extensions/notes/recent", async (req, res) => {
    const audience = boardReadAuth(req, res, cfg);
    if (!audience) return;
    const nRaw = req.query.n ?? "12";
    const n = Number(nRaw);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      res.status(400).json({ error: "invalid_n" });
      return;
    }
    try {
      if (isPublicBoardAudience(audience)) {
        res.json(publicNotesFictionFeed());
        return;
      }
      res.json(await getBrainRecent(pathsCfg, n));
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get("/api/board/extensions/notes/search", async (req, res) => {
    const audience = boardReadAuth(req, res, cfg);
    if (!audience) return;
    const q = String(req.query.q ?? "").trim();
    const nRaw = req.query.n ?? "10";
    const n = Number(nRaw);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      res.status(400).json({ error: "invalid_n" });
      return;
    }
    try {
      if (isPublicBoardAudience(audience)) {
        const all = publicNotesFictionFeed().items ?? [];
        const filtered = q
          ? all.filter((it) =>
              `${it.title} ${it.slug}`.toLowerCase().includes(q.toLowerCase()),
            )
          : all;
        res.json({
          ok: true,
          items: filtered.slice(0, n).map((it) => ({
            slug: it.slug,
            title: it.title,
            excerpt: "Demo memory",
          })),
        });
        return;
      }
      res.json(await searchBrain(pathsCfg, q, n));
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get("/api/board/extensions/notes/read", async (req, res) => {
    const audience = boardReadAuth(req, res, cfg);
    if (!audience) return;
    if (isPublicBoardAudience(audience)) {
      const slug = String(req.query.slug ?? "");
      const payload = redactBrainReadForPublic(slug);
      if (!payload.ok) {
        res.status(401).json(payload);
        return;
      }
      res.json(payload);
      return;
    }
    const slug = String(req.query.slug ?? "").trim();
    try {
      res.json(await readBrainNote(pathsCfg, slug));
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post("/api/board/extensions/notes/capture", async (req, res) => {
    if (!boardWriteAuth(req, res, cfg)) return;
    const body = req.body as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      res.status(400).json({ ok: false, error: "invalid_body" });
      return;
    }
    const rawText = (body as { text?: unknown }).text;
    const rawTitle = (body as { title?: unknown }).title;
    if (typeof rawText !== "string" || rawText.trim().length === 0) {
      res.status(400).json({ ok: false, error: "empty_body" });
      return;
    }
    if (rawText.length > BRAIN_LIMITS.capture) {
      res.status(413).json({ ok: false, error: "body_too_long" });
      return;
    }
    if (rawTitle != null && (typeof rawTitle !== "string" || rawTitle.length > BRAIN_LIMITS.title)) {
      res.status(400).json({ ok: false, error: "invalid_title" });
      return;
    }
    const text = rawText.trim();
    const title = typeof rawTitle === "string" && rawTitle.trim() ? rawTitle.trim() : undefined;
    try {
      const payload = await captureBrainNote(pathsCfg, text, title);
      if (!payload.ok) {
        res.status(400).json(payload);
        return;
      }
      res.json(payload);
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
