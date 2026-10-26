import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startRelay } from "./server.js";
import type { RelayConfig } from "./config.js";
import {
  redactWorldEntityForPublic,
  redactWorldListForPublic,
} from "./board-extensions/public-redact.js";

const port = 28795;
const boardKey = "board-world-test-key";
const root = join(process.cwd(), ".vitest-tmp", "board-world");

describe("world board projection privacy", () => {
  it("redacts private entities from public list", () => {
    const out = redactWorldListForPublic({
      ok: true,
      entities: [
        {
          entity_id: "a",
          entity_type: "mission",
          label: "mission x",
          state: null,
          sensitivity: "internal",
        },
        {
          entity_id: "b",
          entity_type: "organization",
          label: "client",
          state: null,
          sensitivity: "private",
        },
      ],
    });
    expect(out.entities).toHaveLength(1);
    expect(out.entities[0]?.entity_id).toBe("a");
  });

  it("drops private entity detail", () => {
    expect(
      redactWorldEntityForPublic({
        entity: {
          entity_id: "b",
          entity_type: "organization",
          label: "client",
          state: null,
          sensitivity: "private",
        },
        facts: [],
      }),
    ).toBeNull();
  });
});

describe("board world HTTP", () => {
  let relay: Awaited<ReturnType<typeof startRelay>>;

  beforeAll(async () => {
    mkdirSync(root, { recursive: true });
    const cfg: RelayConfig = {
      host: "127.0.0.1",
      port,
      publicBaseUrl: `http://127.0.0.1:${port}`,
      jwtSecret: "test-jwt-secret-at-least-32-chars-long!!",
      workerToken: "test-worker-token-at-least-24c",
      ownerId: "owner-test",
      ownerApprovalSecret: "approval-secret-test",
      boardViewSecret: boardKey,
      boardPublicReadOnly: true,
      boardUnlockPasswordHash: null,
      allowDevToken: false,
      dataDir: join(root, "relay-data"),
      publicRepoUrl: "https://github.com/YG3-ai/ground-control",
      publicDonationUrl: null,
    };
    relay = await startRelay(cfg);
  });

  afterAll(async () => {
    await relay.close();
  });

  it("public GET /api/board/world returns synthetic demo without worker", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/board/world`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; entities?: unknown[] };
    expect(body.ok).toBe(true);
    expect((body.entities ?? []).length).toBeGreaterThan(0);
  });

  it("owner key required for world when public mode off", async () => {
    const cfg: RelayConfig = {
      host: "127.0.0.1",
      port: port + 1,
      publicBaseUrl: `http://127.0.0.1:${port + 1}`,
      jwtSecret: "test-jwt-secret-at-least-32-chars-long!!",
      workerToken: "test-worker-token-at-least-24c",
      ownerId: "owner-test",
      ownerApprovalSecret: "approval-secret-test",
      boardViewSecret: boardKey,
      boardPublicReadOnly: false,
      boardUnlockPasswordHash: null,
      allowDevToken: false,
      dataDir: join(root, "relay-data-gated"),
      publicRepoUrl: "https://github.com/YG3-ai/ground-control",
      publicDonationUrl: null,
    };
    const gated = await startRelay(cfg);
    try {
      const res = await fetch(`http://127.0.0.1:${port + 1}/api/board/world`);
      expect(res.status).toBe(401);
    } finally {
      await gated.close();
    }
  });
});
