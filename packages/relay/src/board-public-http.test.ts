import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PUBLIC_DEMO_MEASURED_AT } from "./board-extensions/public-demo.js";
import {
  extensionJsonHasEmailLike,
  PUBLIC_BOARD_ALLOWLIST,
} from "./board-extensions/public-redact.js";
import { formatUnlockPasswordHash } from "./board-unlock.js";
import { startRelay } from "./server.js";
import type { RelayConfig } from "./config.js";

const root = join(process.cwd(), ".vitest-tmp", "board-public-http");

function baseCfg(port: number, boardPublicReadOnly: boolean): RelayConfig {
  mkdirSync(root, { recursive: true });
  return {
    host: "127.0.0.1",
    port,
    publicBaseUrl: `http://127.0.0.1:${port}`,
    jwtSecret: "test-jwt-secret-at-least-32-chars-long!!",
    workerToken: "test-worker-token-at-least-24c",
    ownerId: "owner-test",
    ownerApprovalSecret: "approval-secret-test",
    boardViewSecret: "approval-secret-test",
    boardPublicReadOnly,
    boardUnlockPasswordHash: null,
    allowDevToken: false,
    dataDir: join(root, `relay-data-${port}`),
    publicRepoUrl: "https://github.com/YG3-ai/ground-control",
    publicDonationUrl: null,
  };
}

describe("board public read-only (relay HTTP)", () => {
  it("default gated: read APIs require the board key", async () => {
    const relay = await startRelay(baseCfg(28787, false));
    try {
      const read = await fetch("http://127.0.0.1:28787/api/board");
      expect(read.status).toBe(401);

      const mutate = await fetch(
        "http://127.0.0.1:28787/api/board/approvals/any-id",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "approve" }),
        },
      );
      expect(mutate.status).toBe(401);
    } finally {
      await relay.close();
    }
  });

  it("BOARD_PUBLIC_READ_ONLY: anonymous GETs; mutations stay gated", async () => {
    const relay = await startRelay(baseCfg(28788, true));
    try {
      const page = await fetch("http://127.0.0.1:28788/board");
      expect(page.status).toBe(200);
      expect(page.headers.get("x-ground-board-public")).toBe("1");
      const html = await page.text();
      expect(html).toMatch(/ground-board-public/);
      expect(html).toContain("lm-stage");

      const worldAsset = await fetch("http://127.0.0.1:28788/assets/life-mirror/world.webp");
      expect(worldAsset.status).toBe(200);
      expect(worldAsset.headers.get("content-type")).toMatch(/image\/webp/);

      const liveAsset = await fetch("http://127.0.0.1:28788/assets/life-mirror/world-live.mp4");
      expect(liveAsset.status).toBe(200);
      expect(liveAsset.headers.get("content-type")).toMatch(/video\/mp4/);
      expect(liveAsset.headers.get("accept-ranges")).toBe("bytes");

      const ranged = await fetch("http://127.0.0.1:28788/assets/life-mirror/world-live.mp4", {
        headers: { Range: "bytes=0-1023" },
      });
      expect(ranged.status).toBe(206);
      expect(ranged.headers.get("content-range")).toMatch(/^bytes 0-1023\//);

      const rootPage = await fetch("http://127.0.0.1:28788/");
      expect(rootPage.status).toBe(200);
      expect(rootPage.headers.get("x-ground-board-public")).toBe("1");
      expect(await rootPage.text()).toBe(html);

      const api = await fetch("http://127.0.0.1:28788/api/board");
      expect(api.status).toBe(200);
      const boardBody = (await api.json()) as {
        public_preview?: boolean;
        at?: string;
        health?: { worker?: boolean };
        error?: string;
      };
      expect(boardBody.public_preview).toBe(true);
      expect(boardBody.at).toBe(PUBLIC_DEMO_MEASURED_AT);
      expect(boardBody.health).toEqual({ worker: false });
      expect(boardBody.error).toBeUndefined();
      expect(Object.keys(boardBody).sort()).toEqual([...PUBLIC_BOARD_ALLOWLIST].sort());

      const ownerBoard = await fetch("http://127.0.0.1:28788/api/board", {
        headers: { "x-ground-board-key": "approval-secret-test" },
      });
      expect(ownerBoard.status).toBe(503);
      const ownerBody = (await ownerBoard.json()) as { error?: string };
      expect(ownerBody.error).toBe("worker_offline");

      const mutate = await fetch(
        "http://127.0.0.1:28788/api/board/approvals/any-id",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "approve" }),
        },
      );
      expect(mutate.status).toBe(401);

      const lifecycle = await fetch(
        "http://127.0.0.1:28788/api/board/extensions/lifecycle",
      );
      expect(lifecycle.status).toBe(200);
      const lifecycleJson = (await lifecycle.json()) as {
        measuredAt?: string;
        recommendations?: unknown[];
        source?: string;
      };
      expect(lifecycleJson.measuredAt).toBe(PUBLIC_DEMO_MEASURED_AT);
      expect((lifecycleJson.recommendations ?? []).length).toBeGreaterThan(0);
      expect(lifecycleJson.source).toBe("demo");
      expect(extensionJsonHasEmailLike(JSON.stringify(lifecycleJson))).toBe(false);

      const growth = await fetch(
        "http://127.0.0.1:28788/api/board/extensions/growth?w=7d",
      );
      expect(growth.status).toBe(200);
      const growthJson = (await growth.json()) as {
        measuredAt?: string;
        source?: string;
        insights?: { body?: string }[];
      };
      expect(growthJson.measuredAt).toBe(PUBLIC_DEMO_MEASURED_AT);
      expect(growthJson.source).toBe("demo");
      expect(growthJson.insights?.[0]?.body).toMatch(/fictional|demo/i);
      expect(extensionJsonHasEmailLike(JSON.stringify(growthJson))).toBe(false);

      const world = await fetch("http://127.0.0.1:28788/api/board/world");
      expect(world.status).toBe(200);
      const worldJson = (await world.json()) as { entities?: unknown[]; ok?: boolean };
      expect(worldJson.ok).toBe(true);
      expect((worldJson.entities ?? []).length).toBeGreaterThan(0);

      const keyed = await fetch(
        "http://127.0.0.1:28788/api/board/extensions/lifecycle",
        { headers: { "x-ground-board-key": "approval-secret-test" } },
      );
      expect(keyed.status).toBe(200);

      for (const path of [
        "/api/board/evolution/summary",
        "/api/board/evolution/candidates",
        "/api/board/evolution/candidates/test-id",
      ]) {
        const evo = await fetch(`http://127.0.0.1:28788${path}`);
        expect(evo.status).toBe(401);
        const body = await evo.text();
        expect(body).not.toMatch(/candidates_total/);
        expect(body).not.toMatch(/proposed_label/);
        expect(JSON.parse(body)).toEqual({ error: "unauthorized" });
      }

      const skills = await fetch(
        "http://127.0.0.1:28788/api/board/extensions/skills",
      );
      expect(skills.status).toBe(401);

      const yg3Accounts = await fetch(
        "http://127.0.0.1:28788/api/board/extensions/yg3-accounts",
      );
      expect(yg3Accounts.status).toBe(200);
      const yg3AccountsBody = await yg3Accounts.text();
      expect(extensionJsonHasEmailLike(yg3AccountsBody)).toBe(false);
      expect(yg3AccountsBody).toMatch(/demo-acct/);

      mkdirSync(join(root, "relay-data-28788", "yg3"), { recursive: true });
      writeFileSync(
        join(root, "relay-data-28788", "yg3", "sync-status.json"),
        JSON.stringify({
          version: 1,
          tenantKey: "secret",
          userKey: "secret",
          state: "ok",
          lastAttemptAt: "2099-01-01T00:00:00.000Z",
          lastSuccessAt: "2099-01-01T00:00:00.000Z",
          lastTrigger: "manual",
          lastErrorCode: null,
        }),
        "utf8",
      );

      const yg3SyncStatus = await fetch(
        "http://127.0.0.1:28788/api/board/extensions/yg3-sync/status",
      );
      expect(yg3SyncStatus.status).toBe(200);
      const yg3SyncJson = (await yg3SyncStatus.json()) as {
        enabled?: boolean;
        status?: { lastSyncedAt?: string; running?: boolean };
      };
      expect(yg3SyncJson.enabled).toBe(false);
      expect(yg3SyncJson.status?.lastSyncedAt).toBe(PUBLIC_DEMO_MEASURED_AT);
      expect(yg3SyncJson.status?.running).toBe(false);
      expect(yg3SyncJson.status?.lastSyncedAt).not.toBe("2099-01-01T00:00:00.000Z");

      const yg3SyncTrigger = await fetch(
        "http://127.0.0.1:28788/api/board/extensions/yg3-sync/trigger",
        { method: "POST" },
      );
      expect(yg3SyncTrigger.status).toBe(401);

      const notesRecent = await fetch(
        "http://127.0.0.1:28788/api/board/extensions/notes/recent?n=5",
      );
      expect(notesRecent.status).toBe(200);
      const notesBody = (await notesRecent.json()) as { items: { slug?: string }[] };
      expect(notesBody.items.length).toBeGreaterThan(0);
      expect(notesBody.items[0]?.slug).toMatch(/^notes\/demo\//);

      const notesReadDemo = await fetch(
        "http://127.0.0.1:28788/api/board/extensions/notes/read?slug=notes/demo/welcome-brief",
      );
      expect(notesReadDemo.status).toBe(200);

      const notesRead = await fetch(
        "http://127.0.0.1:28788/api/board/extensions/notes/read?slug=projects/test",
      );
      expect(notesRead.status).toBe(401);
    } finally {
      await relay.close();
    }
  });

  it("password unlock sets cookie and unlocks owner board reads", async () => {
    const hash = formatUnlockPasswordHash("relay-test-unlock-pass");
    const relay = await startRelay({
      ...baseCfg(28789, true),
      boardUnlockPasswordHash: hash,
    });
    try {
      const page = await fetch("http://127.0.0.1:28789/board");
      const html = await page.text();
      expect(html).toContain('name="ground-board-unlock"');

      const bad = await fetch("http://127.0.0.1:28789/api/board/unlock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "wrong" }),
      });
      expect(bad.status).toBe(401);

      const ok = await fetch("http://127.0.0.1:28789/api/board/unlock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "relay-test-unlock-pass" }),
      });
      expect(ok.status).toBe(200);
      const cookie = ok.headers.get("set-cookie") ?? "";

      const evoPublic = await fetch("http://127.0.0.1:28789/api/board/evolution/summary");
      expect(evoPublic.status).toBe(401);

      const evoOwner = await fetch("http://127.0.0.1:28789/api/board/evolution/summary", {
        headers: { cookie: cookie.split(";")[0]! },
      });
      expect(evoOwner.status).not.toBe(401);
    } finally {
      await relay.close();
    }
  });
});
