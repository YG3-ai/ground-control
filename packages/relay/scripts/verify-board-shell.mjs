#!/usr/bin/env node
/**
 * Fail the build if board.html inline script does not parse.
 * Usage: node scripts/verify-board-shell.mjs [path/to/board.html]
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const defaultPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "board.html",
);
const path = process.argv[2] ? process.argv[2] : defaultPath;

const html = readFileSync(path, "utf8");
const start = html.indexOf("<script>\n");
const end = html.lastIndexOf("</script>");
if (start < 0 || end < 0) {
  console.error(`verify-board-shell: no <script> block in ${path}`);
  process.exit(1);
}
const script = html.slice(start + "<script>\n".length, end);
try {
  new Function(script);
} catch (e) {
  console.error(`verify-board-shell: script parse failed (${path}):`, e.message);
  process.exit(1);
}

// Double-quoted concatenations with raw class="chev" break at runtime in browsers.
const broken = /\+ *"[^"]*class="chev/.test(script);
if (broken) {
  console.error(
    `verify-board-shell: unsafe chev string quoting in ${path} (use single-quoted suffix)`,
  );
  process.exit(1);
}

console.log(`verify-board-shell: ok (${path}, ${script.length} chars)`);
