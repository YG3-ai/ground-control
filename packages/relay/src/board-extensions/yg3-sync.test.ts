import { describe, expect, it, vi } from "vitest";
import { Yg3PublicAccessError } from "../yg3-mcp/access.js";
import { Yg3SyncStatusStore } from "../yg3-mcp/yg3-sync-status.js";
import { publicYg3SyncStatusDemo } from "./public-demo.js";
import { getYg3SyncStatus, triggerYg3ManualSync } from "./yg3-sync.js";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("owner YG3 sync API surface", () => {
  it("rejects public audience for status and manual trigger", async () => {
    const relayPkg = mkdtempSync(join(tmpdir(), "gc-relay-pkg-"));
    await expect(getYg3SyncStatus("public", relayPkg)).rejects.toBeInstanceOf(
      Yg3PublicAccessError,
    );
    await expect(
      triggerYg3ManualSync("public", relayPkg),
    ).rejects.toBeInstanceOf(Yg3PublicAccessError);
    rmSync(relayPkg, { recursive: true, force: true });
  });

  it("returns disabled status when MCP env off", async () => {
    const relayPkg = join(import.meta.dirname, "..", "..");
    const prev = process.env.YG3_MCP_ENABLED;
    process.env.YG3_MCP_ENABLED = "0";
    const out = await getYg3SyncStatus("owner", relayPkg);
    expect(out.enabled).toBe(false);
    process.env.YG3_MCP_ENABLED = prev;
  });

  it("public demo fixture is deterministic and does not read private store", async () => {
    const demo = publicYg3SyncStatusDemo();
    expect(demo.enabled).toBe(false);
    expect(demo.status.running).toBe(false);
    const loadSpy = vi.spyOn(Yg3SyncStatusStore.prototype, "load");
    publicYg3SyncStatusDemo();
    expect(loadSpy).not.toHaveBeenCalled();
    loadSpy.mockRestore();
  });

  it("owner status reads private store only after owner audience check", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gc-yg3-owner-st-"));
    mkdirSync(join(dir, "yg3"), { recursive: true });
    writeFileSync(
      join(dir, "yg3", "sync-status.json"),
      JSON.stringify({
        version: 1,
        tenantKey: "t",
        userKey: "u",
        state: "ok",
        lastAttemptAt: "2099-01-01T00:00:00.000Z",
        lastSuccessAt: "2099-01-01T00:00:00.000Z",
        lastTrigger: "manual",
        lastErrorCode: null,
      }),
      "utf8",
    );
    const prev = process.env.YG3_MCP_ENABLED;
    const prevRelay = process.env.RELAY_DATA_DIR;
    process.env.YG3_MCP_ENABLED = "1";
    process.env.RELAY_DATA_DIR = dir;
    const relayPkg = join(import.meta.dirname, "..", "..");
    const out = await getYg3SyncStatus("owner", relayPkg);
    expect(out.status.lastSyncedAt).toBe("2099-01-01T00:00:00.000Z");
    process.env.YG3_MCP_ENABLED = prev;
    process.env.RELAY_DATA_DIR = prevRelay;
    rmSync(dir, { recursive: true, force: true });
  });
});
