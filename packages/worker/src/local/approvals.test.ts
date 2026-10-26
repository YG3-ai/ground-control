import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalManager } from "./approvals.js";

const roots: string[] = [];

afterEach(() => {
  for (const r of roots.splice(0)) {
    rmSync(r, { recursive: true, force: true });
  }
});

function mgr(dialogResult: "approved" | "denied" | "timed_out" = "approved") {
  const dir = mkdtempSync(join(tmpdir(), "ac-appr-"));
  roots.push(dir);
  return new ApprovalManager({
    ownerId: "owner-local",
    dataDir: dir,
    defaultTimeoutSec: 5,
    notify: async () => undefined,
    dialog: async () => dialogResult,
  });
}

describe("ApprovalManager", () => {
  it("waits on dialog and returns approved", async () => {
    const m = mgr("approved");
    const rec = await m.request({
      ownerId: "owner-local",
      kind: "browser_open",
      title: "Open docs",
      detail: "https://example.com",
      payload: { url: "https://example.com" },
    });
    expect(rec.status).toBe("approved");
    expect(rec.payload.url).toBe("https://example.com");
  });

  it("supports async pending without wait", async () => {
    const m = mgr("denied");
    const pending = await m.request({
      ownerId: "owner-local",
      kind: "permission",
      title: "Allow?",
      detail: "do a thing",
      wait: false,
    });
    expect(pending.status).toBe("pending");
    const resolved = m.resolve("owner-local", pending.id, "approved", "menubar");
    expect(resolved.status).toBe("approved");
  });

  it("rejects other owners", async () => {
    const m = mgr();
    await expect(
      m.request({
        ownerId: "someone-else",
        kind: "general",
        title: "x",
        detail: "y",
        wait: false,
      }),
    ).rejects.toThrow(/unauthorized/);
  });
});
