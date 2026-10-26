import { describe, expect, it } from "vitest";
import type { Request, Response } from "express";
import { boardReadAuth, boardWriteAuth } from "./board-auth.js";
import { loadRelayConfig } from "./config.js";
import type { RelayConfig } from "./config.js";

function mockRes(): Response {
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string | number | string[]>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json() {
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
  };
  return res as Response;
}

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    query: {},
    header: () => undefined,
    ...overrides,
  } as Request;
}

const cfg = (overrides: Partial<RelayConfig> = {}): RelayConfig => ({
  host: "127.0.0.1",
  port: 8787,
  publicBaseUrl: "http://127.0.0.1:8787",
  jwtSecret: "jwt-secret-at-least-32-characters!!",
  workerToken: "worker-token-at-least-24-chars",
  ownerId: "owner",
  ownerApprovalSecret: "approval",
  boardViewSecret: "board-secret-key",
  boardPublicReadOnly: false,
  boardUnlockPasswordHash: null,
  allowDevToken: false,
  dataDir: "./data/relay",
  publicRepoUrl: "https://github.com/YG3-ai/ground-control",
  publicDonationUrl: null,
  ...overrides,
});

describe("board auth", () => {
  it("loadRelayConfig defaults BOARD_PUBLIC_READ_ONLY to false", () => {
    expect(
      loadRelayConfig({
        RELAY_JWT_SECRET: "x".repeat(32),
        WORKER_TOKEN: "y".repeat(24),
        OWNER_APPROVAL_SECRET: "secret",
      }).boardPublicReadOnly,
    ).toBe(false);
    expect(
      loadRelayConfig({
        RELAY_JWT_SECRET: "x".repeat(32),
        WORKER_TOKEN: "y".repeat(24),
        OWNER_APPROVAL_SECRET: "secret",
        BOARD_PUBLIC_READ_ONLY: "1",
      }).boardPublicReadOnly,
    ).toBe(true);
  });

  it("boardWriteAuth rejects missing key", () => {
    const res = mockRes();
    expect(boardWriteAuth(mockReq(), res, cfg())).toBeNull();
    expect(res.statusCode).toBe(401);
  });

  it("boardWriteAuth accepts valid header key and sets cookie", () => {
    const res = mockRes();
    const req = mockReq({
      header: (name: string) =>
        name.toLowerCase() === "x-ground-board-key" ? "board-secret-key" : undefined,
    });
    expect(boardWriteAuth(req, res, cfg())).toBe("board-secret-key");
    expect(String(res.headers["Set-Cookie"] ?? "")).toMatch(/gc_board_v=/);
  });

  it("boardReadAuth allows anonymous read when public mode is on", () => {
    const res = mockRes();
    expect(boardReadAuth(mockReq(), res, cfg({ boardPublicReadOnly: true }))).toBe(
      "public",
    );
    expect(res.headers["Set-Cookie"]).toBeUndefined();
  });

  it("boardReadAuth returns key for owner reads when public mode is on", () => {
    const res = mockRes();
    const req = mockReq({
      header: (name: string) =>
        name.toLowerCase() === "x-ground-board-key" ? "board-secret-key" : undefined,
    });
    expect(boardReadAuth(req, res, cfg({ boardPublicReadOnly: true }))).toBe(
      "board-secret-key",
    );
    expect(String(res.headers["Set-Cookie"] ?? "")).toMatch(/gc_board_v=/);
  });

  it("boardReadAuth still requires key when public mode is off", () => {
    const res = mockRes();
    expect(boardReadAuth(mockReq(), res, cfg())).toBeNull();
    expect(res.statusCode).toBe(401);
  });
});
