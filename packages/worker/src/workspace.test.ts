import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempRoot } from "./test-utils.js";
import {
  resolveWorkspacePath,
  WorkspaceError,
} from "./workspace.js";

describe("resolveWorkspacePath", () => {
  it("resolves a folder name under allowed_roots", () => {
    const root = makeTempRoot();
    const proj = join(root, "ycrm");
    mkdirSync(proj);
    const abs = resolveWorkspacePath("ycrm", [root], root);
    expect(abs).toBe(realpathSync(proj));
  });


  it("rejects paths outside allowed_roots", () => {
    const root = makeTempRoot();
    mkdirSync(join(root, "ok"));
    expect(() =>
      resolveWorkspacePath("/tmp", [join(root, "ok")], root),
    ).toThrow(WorkspaceError);
  });
});
