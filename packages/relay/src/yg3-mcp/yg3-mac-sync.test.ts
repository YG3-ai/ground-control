import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { tryAcquireYg3SyncLock, yg3SyncLockPath } from "./yg3-sync-lock.js";
import {
  sanitizeSyncErrorCode,
  toPublicYg3SyncStatus,
  Yg3SyncStatusStore,
} from "./yg3-sync-status.js";

const repoRoot = join(import.meta.dirname, "../../../..");

describe("YG3 mac background sync primitives", () => {
  it("sanitizes error codes and public status omits tenant fields", () => {
    expect(sanitizeSyncErrorCode("workspace_selection_required")).toBe(
      "workspace_selection_required",
    );
    expect(sanitizeSyncErrorCode("token abc")).toBe("token_abc");
    const pub = toPublicYg3SyncStatus({
      version: 1,
      tenantKey: "secret-tenant",
      userKey: "secret-user",
      state: "ok",
      lastAttemptAt: "2026-01-01T00:00:00.000Z",
      lastSuccessAt: "2026-01-01T00:00:00.000Z",
      lastTrigger: "calendar",
      lastErrorCode: null,
    });
    expect(pub.state).toBe("ok");
    expect(JSON.stringify(pub)).not.toContain("secret");
  });

  it("writes sync status atomically with mode 600", () => {
    const dir = mkdtempSync(join(tmpdir(), "gc-yg3-sync-st-"));
    const store = Yg3SyncStatusStore.defaultPath(dir);
    store.saveAtomic({
      version: 1,
      tenantKey: "t1",
      userKey: "u1",
      state: "ok",
      lastAttemptAt: "2026-01-01T00:00:00.000Z",
      lastSuccessAt: "2026-01-01T00:00:00.000Z",
      lastTrigger: "manual",
      lastErrorCode: null,
    });
    const path = join(dir, "yg3", "sync-status.json");
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
    rmSync(dir, { recursive: true, force: true });
  });

  it("enforces single-flight lock", () => {
    const dir = mkdtempSync(join(tmpdir(), "gc-yg3-sync-lk-"));
    const a = tryAcquireYg3SyncLock(dir);
    const b = tryAcquireYg3SyncLock(dir);
    expect(a).not.toBeNull();
    expect(b).toBeNull();
    a?.release();
    expect(tryAcquireYg3SyncLock(dir)).not.toBeNull();
    rmSync(yg3SyncLockPath(dir), { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it("renders yg3 launchd plist with root token only", () => {
    const dir = mkdtempSync(join(tmpdir(), "gc-yg3-plist-"));
    const root = join(dir, "repo");
    execFileSync("mkdir", ["-p", join(root, "launchd")]);
    const scripts = join(root, "scripts");
    const srcScripts = join(repoRoot, "scripts");
    const srcTemplates = join(repoRoot, "launchd", "templates");
    execFileSync("cp", ["-R", srcScripts, join(root, "scripts")]);
    execFileSync("cp", ["-R", srcTemplates, join(root, "launchd", "templates")]);
    chmodSync(join(scripts, "render-launchd-plist.sh"), 0o755);
    const xml = execFileSync(
      join(scripts, "render-launchd-plist.sh"),
      ["com.groundcontrol.yg3-sync"],
      { cwd: root, encoding: "utf8" },
    );
    expect(xml).toContain("<key>RunAtLoad</key>");
    expect(xml).toContain("<true/>");
    expect(xml).toContain("<key>KeepAlive</key>");
    expect(xml).toContain("<false/>");
    expect(xml).toContain("<key>StartCalendarInterval</key>");
    expect(xml).toContain("<integer>5</integer>");
    expect(xml).not.toContain("__GROUND_CONTROL_ROOT__");
    expect(xml).toContain(join(root, "scripts/run-yg3-sync.sh"));
    rmSync(dir, { recursive: true, force: true });
  });
});
