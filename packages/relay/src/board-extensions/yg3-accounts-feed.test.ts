import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectYg3SnapshotV1 } from "../yg3-mcp/projector.js";
import { publicYg3AccountsFiction } from "./public-fiction.js";
import {
  clearYg3AccountsCache,
  getYg3AccountsFeed,
} from "./yg3-accounts.js";
import { resolveBoardExtensionPaths } from "./paths.js";

vi.mock("../yg3-mcp/snapshot-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../yg3-mcp/snapshot-service.js")>();
  return {
    ...actual,
    loadYg3OwnerSnapshot: vi.fn(),
    resolveYg3PathsFromRelayPackage: vi.fn(() => ({
      repoRoot: "/tmp",
      relayDataDir: "/tmp/data",
    })),
  };
});

vi.mock("./safe-exec.js", () => ({
  runBounded: vi.fn(),
}));

import { loadYg3OwnerSnapshot } from "../yg3-mcp/snapshot-service.js";
import { runBounded } from "./safe-exec.js";

const relayRoot = resolveBoardExtensionPaths(join(import.meta.dirname, ".."), process.env);

const FABRICATED = {
  whoami: [{ type: "text", text: "tenant: t\nuser: u" }],
  client_connections: [
    { type: "text", text: "Clients in scope: 5\nAll clear: 5" },
  ],
};

afterEach(() => {
  clearYg3AccountsCache();
  vi.mocked(loadYg3OwnerSnapshot).mockReset();
  vi.mocked(runBounded).mockReset();
});

describe("getYg3AccountsFeed", () => {
  it("falls through to the accounts runner when snapshot has no real rows", async () => {
    const snap = projectYg3SnapshotV1(
      { tenantKey: "t", userKey: "u" },
      "2026-03-15T12:00:00.000Z",
      FABRICATED,
    );
    vi.mocked(loadYg3OwnerSnapshot).mockResolvedValue({
      enabled: true,
      snapshot: snap,
      health: "ok",
      source: "yg3-mcp",
    });
    vi.mocked(runBounded).mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({
        items: [
          {
            id: "37e9ffa1-f76f-4b89-8cd0-68e21b5ea2e4",
            name: "YG3 Media",
            email: "ops@example.com",
            createdAt: "2024-06-01T10:00:00.000Z",
          },
        ],
      }),
      stderr: "",
    });

    const pathsCfg = {
      ...relayRoot,
      parthaWorkRoot: "/work",
      parthaWorkEnvFile: "/work/.env.local",
    };
    const feed = await getYg3AccountsFeed(pathsCfg, "/relay/pkg");
    expect(runBounded).toHaveBeenCalled();
    expect(feed.ok).toBe(true);
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0].name).toBe("YG3 Media");
    expect(feed.items[0].createdAt).toBe("2024-06-01T10:00:00.000Z");
    expect(feed.items[0].createdAt).not.toBe(snap.syncedAt);
    expect(feed.items.some((r) => /^Workspace \d+$/.test(r.name))).toBe(false);
  });

  it("returns honest unavailable when runner fails and snapshot has no rows", async () => {
    vi.mocked(loadYg3OwnerSnapshot).mockResolvedValue({
      enabled: true,
      snapshot: projectYg3SnapshotV1(
        { tenantKey: "t", userKey: "u" },
        "2026-03-15T12:00:00.000Z",
        FABRICATED,
      ),
      health: "ok",
      source: "yg3-mcp",
    });
    vi.mocked(runBounded).mockResolvedValue({
      code: 1,
      stdout: "",
      stderr: "missing credentials",
    });

    const pathsCfg = {
      ...relayRoot,
      parthaWorkRoot: "/work",
      parthaWorkEnvFile: "/work/.env.local",
    };
    const feed = await getYg3AccountsFeed(pathsCfg, "/relay/pkg");
    expect(feed.ok).toBe(false);
    expect(feed.health).toBe("unavailable");
    expect(feed.items).toEqual([]);
    expect(feed.items.some((r) => /^Workspace \d+$/.test(r.name))).toBe(false);
  });

  it("leaves public preview fiction unchanged", () => {
    const demo = publicYg3AccountsFiction();
    expect(demo.items.some((r) => String(r.id).startsWith("demo-acct"))).toBe(true);
    expect(demo.items.some((r) => /^Workspace \d+$/.test(String(r.name)))).toBe(
      false,
    );
  });
});
