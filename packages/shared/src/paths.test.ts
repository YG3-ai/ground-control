import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PathSafetyError, resolveSafePath } from "./paths.js";

describe("resolveSafePath", () => {
  it("resolves a normal relative path", () => {
    const root = mkdtempSync(join(tmpdir(), "ac-path-"));
    writeFileSync(join(root, "file.txt"), "ok");
    expect(resolveSafePath(root, "file.txt")).toBe(
      realpathSync(join(root, "file.txt")),
    );
  });

  it("rejects traversal", () => {
    const root = mkdtempSync(join(tmpdir(), "ac-path-"));
    expect(() => resolveSafePath(root, "../etc/passwd")).toThrow(PathSafetyError);
    expect(() => resolveSafePath(root, "foo/../../etc/passwd")).toThrow(
      PathSafetyError,
    );
  });

  it("rejects absolute paths", () => {
    const root = mkdtempSync(join(tmpdir(), "ac-path-"));
    expect(() => resolveSafePath(root, "/etc/passwd")).toThrow(PathSafetyError);
  });

  it("rejects symlink escape", () => {
    const root = mkdtempSync(join(tmpdir(), "ac-path-"));
    const outside = mkdtempSync(join(tmpdir(), "ac-outside-"));
    writeFileSync(join(outside, "secret.txt"), "LEAK");
    symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
    expect(() => resolveSafePath(root, "link.txt")).toThrow(PathSafetyError);
  });

  it("allows symlink that stays inside root", () => {
    const root = mkdtempSync(join(tmpdir(), "ac-path-"));
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub", "a.txt"), "ok");
    symlinkSync(join(root, "sub", "a.txt"), join(root, "link.txt"));
    expect(resolveSafePath(root, "link.txt")).toBe(
      realpathSync(join(root, "sub", "a.txt")),
    );
  });
});

