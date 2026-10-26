import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Express, Request } from "express";
import { setBoardAuthCookie } from "./board-auth.js";
import type { RelayConfig } from "./config.js";

const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function formatUnlockPasswordHash(password: string, saltHex?: string): string {
  const salt = saltHex ?? randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 32, SCRYPT_OPTS).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function verifyUnlockPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = parts[1];
  const expectedHex = parts[2];
  if (!salt || !expectedHex || !/^[a-f0-9]+$/i.test(expectedHex)) return false;
  try {
    const derived = scryptSync(password, salt, 32, SCRYPT_OPTS);
    const expected = Buffer.from(expectedHex, "hex");
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

type AttemptWindow = { count: number; windowStart: number };

export class BoardUnlockRateLimiter {
  private readonly attempts = new Map<string, AttemptWindow>();

  constructor(
    private readonly maxAttempts = 8,
    private readonly windowMs = 15 * 60 * 1000,
  ) {}

  check(ip: string): { ok: true } | { ok: false; retryAfterSec: number } {
    const now = Date.now();
    const row = this.attempts.get(ip);
    if (!row || now - row.windowStart > this.windowMs) {
      this.attempts.set(ip, { count: 0, windowStart: now });
      return { ok: true };
    }
    if (row.count >= this.maxAttempts) {
      const retryAfterSec = Math.max(
        1,
        Math.ceil((row.windowStart + this.windowMs - now) / 1000),
      );
      return { ok: false, retryAfterSec };
    }
    return { ok: true };
  }

  recordFailure(ip: string): void {
    const now = Date.now();
    const row = this.attempts.get(ip);
    if (!row || now - row.windowStart > this.windowMs) {
      this.attempts.set(ip, { count: 1, windowStart: now });
      return;
    }
    row.count += 1;
  }

  recordSuccess(ip: string): void {
    this.attempts.delete(ip);
  }

  reset(): void {
    this.attempts.clear();
  }
}

function clientIp(req: Request): string {
  const forwarded = req.header("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? "unknown";
}

export function registerBoardUnlockRoute(
  app: Express,
  cfg: RelayConfig,
  limiter: BoardUnlockRateLimiter,
): void {
  app.post("/api/board/unlock", (req, res) => {
    if (!cfg.boardPublicReadOnly || !cfg.boardUnlockPasswordHash) {
      res.status(404).json({ error: "not_available" });
      return;
    }
    const ip = clientIp(req);
    const gate = limiter.check(ip);
    if (!gate.ok) {
      res.status(429).json({ error: "rate_limited", retry_after: gate.retryAfterSec });
      return;
    }
    const password = String((req.body as { password?: string })?.password ?? "");
    if (!password) {
      res.status(400).json({ error: "missing_password" });
      return;
    }
    if (!verifyUnlockPassword(password, cfg.boardUnlockPasswordHash)) {
      limiter.recordFailure(ip);
      res.status(401).json({ error: "invalid_password" });
      return;
    }
    limiter.recordSuccess(ip);
    setBoardAuthCookie(res, cfg);
    res.json({ ok: true });
  });
}
