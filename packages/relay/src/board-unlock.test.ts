import { describe, expect, it, beforeEach } from "vitest";
import express from "express";
import { createServer } from "node:http";
import {
  BoardUnlockRateLimiter,
  formatUnlockPasswordHash,
  registerBoardUnlockRoute,
  verifyUnlockPassword,
} from "./board-unlock.js";
import { BOARD_COOKIE } from "./board-auth.js";
import type { RelayConfig } from "./config.js";

const testCfg = (overrides: Partial<RelayConfig> = {}): RelayConfig => ({
  host: "127.0.0.1",
  port: 8787,
  publicBaseUrl: "http://127.0.0.1:8787",
  jwtSecret: "jwt-secret-at-least-32-characters!!",
  workerToken: "worker-token-at-least-24-chars",
  ownerId: "owner",
  ownerApprovalSecret: "approval",
  boardViewSecret: "board-secret-key",
  boardPublicReadOnly: true,
  boardUnlockPasswordHash: formatUnlockPasswordHash("vitest-unlock-test-password"),
  allowDevToken: false,
  dataDir: "./data/relay",
  publicRepoUrl: "https://github.com/YG3-ai/ground-control",
  publicDonationUrl: null,
  ...overrides,
});

async function withUnlockServer(
  cfg: RelayConfig,
  limiter: BoardUnlockRateLimiter,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  registerBoardUnlockRoute(app, cfg, limiter);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

describe("verifyUnlockPassword", () => {
  it("accepts password matching scrypt hash", () => {
    const stored = formatUnlockPasswordHash("vitest-unlock-test-password");
    expect(verifyUnlockPassword("vitest-unlock-test-password", stored)).toBe(true);
    expect(verifyUnlockPassword("wrong", stored)).toBe(false);
  });
});

describe("POST /api/board/unlock", () => {
  let limiter: BoardUnlockRateLimiter;

  beforeEach(() => {
    limiter = new BoardUnlockRateLimiter(3, 60_000);
  });

  it("sets HttpOnly cookie and rejects wrong password", async () => {
    await withUnlockServer(testCfg(), limiter, async (base) => {
      const bad = await fetch(`${base}/api/board/unlock`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "wrong" }),
      });
      expect(bad.status).toBe(401);

      const ok = await fetch(`${base}/api/board/unlock`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "vitest-unlock-test-password" }),
      });
      expect(ok.status).toBe(200);
      const cookie = ok.headers.get("set-cookie") ?? "";
      expect(cookie).toMatch(new RegExp(`${BOARD_COOKIE}=`));
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Lax/i);
    });
  });

  it("rate-limits repeated failures", async () => {
    await withUnlockServer(testCfg(), limiter, async (base) => {
      for (let i = 0; i < 3; i++) {
        const res = await fetch(`${base}/api/board/unlock`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password: "wrong" }),
        });
        expect(res.status).toBe(401);
      }
      const blocked = await fetch(`${base}/api/board/unlock`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "wrong" }),
      });
      expect(blocked.status).toBe(429);
    });
  });

  it("returns 404 when unlock hash not configured", async () => {
    await withUnlockServer(
      testCfg({ boardUnlockPasswordHash: null }),
      limiter,
      async (base) => {
        const res = await fetch(`${base}/api/board/unlock`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password: "vitest-unlock-test-password" }),
        });
        expect(res.status).toBe(404);
      },
    );
  });
});
