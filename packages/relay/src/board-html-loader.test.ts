import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyBoardPublicPreview,
  createBoardHtmlLoader,
  hashBoardHtmlSource,
  injectBuildMeta,
  validateBoardShellHtml,
} from "./board-html-loader.js";

const MIN_DOC = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" /><title>Ground</title></head>
<body><p>${"x".repeat(600)}</p>
<script>
(function () { "use strict"; })();
</script>
</body></html>`;

describe("board-html-loader", () => {
  let root = "";

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = "";
  });

  function setupDir(html: string, name = "board.html") {
    root = join(tmpdir(), `board-loader-${Date.now()}-${Math.random()}`);
    const relayDir = join(root, "dist");
    mkdirSync(relayDir, { recursive: true });
    writeFileSync(join(relayDir, name), html, "utf8");
    return relayDir;
  }

  it("hashes source deterministically", () => {
    const a = hashBoardHtmlSource(MIN_DOC);
    const b = hashBoardHtmlSource(MIN_DOC);
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{16}$/);
  });

  it("injects build meta into head", () => {
    const out = injectBuildMeta(MIN_DOC, "abc123");
    expect(out).toContain('name="ground-board-build"');
    expect(out).toContain('content="abc123"');
  });

  it("injects and strips public preview meta", () => {
    const on = applyBoardPublicPreview(MIN_DOC, true);
    expect(on).toContain('name="ground-board-public" content="1"');
    const off = applyBoardPublicPreview(on, false);
    expect(off).not.toContain("ground-board-public");
  });

  it("serves disk html with version and advances on real edits", () => {
    const relayDir = setupDir(MIN_DOC);
    const loader = createBoardHtmlLoader(relayDir);
    const first = loader.serve();
    expect(first.status).toBe(200);
    expect(first.version).toBeTruthy();
    expect(first.body).toContain('ground-board-build');
    const v1 = first.version!;

    writeFileSync(join(relayDir, "board.html"), MIN_DOC + "\n<!-- edit-1 -->\n", "utf8");
    const second = loader.serve();
    expect(second.version).not.toBe(v1);
  });

  it("keeps last-known-good when source becomes truncated", () => {
    const relayDir = setupDir(MIN_DOC);
    const loader = createBoardHtmlLoader(relayDir);
    const good = loader.serve();
    expect(good.status).toBe(200);
    writeFileSync(join(relayDir, "board.html"), "<!DOCTYPE html><html></html>", "utf8");
    const after = loader.serve();
    expect(after.status).toBe(200);
    expect(after.version).toBe(good.version);
  });

  it("rejects broken inline script and keeps last-known-good shell", () => {
    const relayDir = setupDir(MIN_DOC);
    const loader = createBoardHtmlLoader(relayDir);
    const good = loader.serve();
    expect(good.status).toBe(200);
    const broken = MIN_DOC.replace(
      '(function () { "use strict"; })();',
      'var x = "a</div><span class="chev">";',
    );
    writeFileSync(join(relayDir, "board.html"), broken, "utf8");
    const after = loader.serve();
    expect(after.status).toBe(200);
    expect(after.version).toBe(good.version);
    expect(validateBoardShellHtml(broken).ok).toBe(false);
  });

  it("returns 503 when no valid source ever existed", () => {
    root = join(tmpdir(), `board-loader-empty-${Date.now()}`);
    mkdirSync(join(root, "dist"), { recursive: true });
    const loader = createBoardHtmlLoader(join(root, "dist"));
    const served = loader.serve();
    expect(served.status).toBe(503);
    expect(served.version).toBeNull();
  });
});
