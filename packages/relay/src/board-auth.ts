import { timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import type { RelayConfig } from "./config.js";

export const BOARD_COOKIE = "gc_board_v";
const BOARD_COOKIE_MAX_AGE = 60 * 60 * 24 * 400; // ~13 months

export function setBoardAuthCookie(res: Response, cfg: RelayConfig): void {
  res.setHeader(
    "Set-Cookie",
    `${BOARD_COOKIE}=${encodeURIComponent(cfg.boardViewSecret)}; Path=/; Max-Age=${BOARD_COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`,
  );
}

function boardKeyOk(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

export function boardKeyFromRequest(req: Request): string {
  const cookies = parseCookies(req.header("cookie"));
  return String(
    req.query.k ??
      req.header("x-ground-board-key") ??
      cookies[BOARD_COOKIE] ??
      "",
  ).trim();
}

export type BoardAuthFn = (
  req: Request,
  res: Response,
  cfg: RelayConfig,
) => string | null;

/** Requires a valid board key; sets remember-me cookie on success. */
export function boardWriteAuth(
  req: Request,
  res: Response,
  cfg: RelayConfig,
): string | null {
  const key = boardKeyFromRequest(req);
  if (!boardKeyOk(key, cfg.boardViewSecret)) {
    res.status(401).json({ error: "unauthorized" });
    return null;
  }
  setBoardAuthCookie(res, cfg);
  return key;
}

/** Read paths: optional anonymous access when BOARD_PUBLIC_READ_ONLY is enabled. */
export function boardReadAuth(
  req: Request,
  res: Response,
  cfg: RelayConfig,
): string | null {
  if (cfg.boardPublicReadOnly) {
    const key = boardKeyFromRequest(req);
    if (boardKeyOk(key, cfg.boardViewSecret)) {
      setBoardAuthCookie(res, cfg);
      return key;
    }
    return "public";
  }
  return boardWriteAuth(req, res, cfg);
}
