import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const MIN_BYTES = 512;
const BUILD_META_RE =
  /<meta\s+name=["']ground-board-build["']\s+content=["'][^"']*["']\s*\/?>/i;
const BUILD_META_INJECT =
  '<meta name="ground-board-build" content="__BUILD__" />';
const PUBLIC_META_INJECT =
  '<meta name="ground-board-public" content="1" />';
const PUBLIC_META_RE =
  /<meta\s+name=["']ground-board-public["']\s+content=["'][^"']*["']\s*\/?>/i;
const UNLOCK_META_INJECT =
  '<meta name="ground-board-unlock" content="1" />';
const UNLOCK_META_RE =
  /<meta\s+name=["']ground-board-unlock["']\s+content=["'][^"']*["']\s*\/?>/i;
const PUBLIC_REPO_META_RE =
  /<meta\s+name=["']ground-public-repo["']\s+content=["'][^"']*["']\s*\/?>/i;
const PUBLIC_DONATION_META_RE =
  /<meta\s+name=["']ground-public-donation["']\s+content=["'][^"']*["']\s*\/?>/i;
const SHELL_SCRIPT_START = "<script>\n";
/** Double-quoted HTML fragments with raw class="chev" break browser parsing. */
const UNSAFE_CHEV_IN_SCRIPT_RE = /\+ *"[^"]*class="chev/;

export function validateBoardShellHtml(
  html: string,
): { ok: true } | { ok: false; reason: string } {
  const start = html.indexOf(SHELL_SCRIPT_START);
  const end = html.lastIndexOf("</script>");
  if (start < 0 || end < 0) {
    return { ok: false, reason: "missing_script_block" };
  }
  const script = html.slice(start + SHELL_SCRIPT_START.length, end);
  if (UNSAFE_CHEV_IN_SCRIPT_RE.test(script)) {
    return { ok: false, reason: "unsafe_chev_string_quotes" };
  }
  try {
    new Function(script);
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  return { ok: true };
}

export type BoardHtmlSnapshot = {
  /** Raw accepted source bytes (before build meta injection). */
  source: string;
  /** Content hash served to clients (hex, no private data). */
  version: string;
  /** HTML with ground-board-build meta set to version. */
  servedHtml: string;
};

function resolveSourcePaths(relayDir: string): string[] {
  return [
    join(relayDir, "board.html"),
    join(relayDir, "..", "src", "board.html"),
  ];
}

function readFirstExisting(paths: string[]): { text: string; path: string } | null {
  for (const path of paths) {
    if (!existsSync(path)) continue;
    try {
      const text = readFileSync(path, "utf8");
      return { text, path };
    } catch {
      continue;
    }
  }
  return null;
}

function isCompleteBoardHtml(text: string): boolean {
  const t = text.trim();
  if (t.length < MIN_BYTES) return false;
  const lower = t.toLowerCase();
  if (!lower.includes("<!doctype html")) return false;
  if (!lower.includes("</html>")) return false;
  if (!lower.includes("<html")) return false;
  return true;
}

export function hashBoardHtmlSource(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex").slice(0, 16);
}

export function applyBoardPasswordUnlock(html: string, enabled: boolean): string {
  if (!enabled) {
    return html.replace(UNLOCK_META_RE, "");
  }
  if (UNLOCK_META_RE.test(html)) {
    return html.replace(UNLOCK_META_RE, UNLOCK_META_INJECT);
  }
  const headClose = /<head[^>]*>/i;
  if (headClose.test(html)) {
    return html.replace(headClose, (m) => `${m}\n  ${UNLOCK_META_INJECT}`);
  }
  return `${UNLOCK_META_INJECT}\n${html}`;
}

export function applyBoardPublicUrls(
  html: string,
  urls: { repoUrl: string; donationUrl: string | null },
): string {
  let out = html;
  const repoMeta = `<meta name="ground-public-repo" content="${escapeMeta(urls.repoUrl)}" />`;
  out = PUBLIC_REPO_META_RE.test(out)
    ? out.replace(PUBLIC_REPO_META_RE, repoMeta)
    : out.replace(/<head[^>]*>/i, (m) => `${m}\n  ${repoMeta}`);
  const donation = urls.donationUrl?.trim() ?? "";
  if (donation) {
    const dMeta = `<meta name="ground-public-donation" content="${escapeMeta(donation)}" />`;
    out = PUBLIC_DONATION_META_RE.test(out)
      ? out.replace(PUBLIC_DONATION_META_RE, dMeta)
      : out.replace(/<head[^>]*>/i, (m) => `${m}\n  ${dMeta}`);
  } else {
    out = out.replace(PUBLIC_DONATION_META_RE, "");
  }
  return out;
}

function escapeMeta(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

export function applyBoardPublicPreview(html: string, enabled: boolean): string {
  if (!enabled) {
    return html.replace(PUBLIC_META_RE, "");
  }
  if (PUBLIC_META_RE.test(html)) {
    return html.replace(
      PUBLIC_META_RE,
      '<meta name="ground-board-public" content="1" />',
    );
  }
  const headClose = /<head[^>]*>/i;
  if (headClose.test(html)) {
    return html.replace(headClose, (m) => `${m}\n  ${PUBLIC_META_INJECT}`);
  }
  return `${PUBLIC_META_INJECT}\n${html}`;
}

export function injectBuildMeta(source: string, version: string): string {
  const meta = BUILD_META_INJECT.replace("__BUILD__", version);
  if (BUILD_META_RE.test(source)) {
    return source.replace(BUILD_META_RE, meta);
  }
  const headClose = /<head[^>]*>/i;
  if (headClose.test(source)) {
    return source.replace(headClose, (m) => `${m}\n  ${meta}`);
  }
  return `${meta}\n${source}`;
}

export type BoardHtmlLoader = {
  refresh: () => void;
  snapshot: () => BoardHtmlSnapshot | null;
  serve: () => { status: 200 | 503; body: string; version: string | null };
  uiVersion: () => string | null;
};

export function createBoardHtmlLoader(relayDir: string): BoardHtmlLoader {
  const paths = resolveSourcePaths(relayDir);
  let lastGood: BoardHtmlSnapshot | null = null;
  let lastMtimeMs = 0;
  let lastPath: string | null = null;

  function acceptSource(text: string): BoardHtmlSnapshot | null {
    const check = validateBoardShellHtml(text);
    if (!check.ok) {
      console.error(
        `[relay] board.html rejected (keeping last good shell): ${check.reason}`,
      );
      return null;
    }
    const version = hashBoardHtmlSource(text);
    const snap: BoardHtmlSnapshot = {
      source: text,
      version,
      servedHtml: injectBuildMeta(text, version),
    };
    lastGood = snap;
    return snap;
  }

  function tryLoadFromDisk(): BoardHtmlSnapshot | null {
    const found = readFirstExisting(paths);
    if (!found) return null;
    if (!isCompleteBoardHtml(found.text)) return null;
    lastPath = found.path;
    try {
      lastMtimeMs = statSync(found.path).mtimeMs;
    } catch {
      lastMtimeMs = 0;
    }
    return acceptSource(found.text) ?? lastGood;
  }

  function refresh(): void {
    const found = readFirstExisting(paths);
    if (!found) return;
    let mtime = 0;
    try {
      mtime = statSync(found.path).mtimeMs;
    } catch {
      return;
    }
    if (found.path === lastPath && mtime === lastMtimeMs && lastGood) return;
    if (!isCompleteBoardHtml(found.text)) return;
    const accepted = acceptSource(found.text);
    if (!accepted) return;
    lastPath = found.path;
    lastMtimeMs = mtime;
  }

  // Seed last-known-good at startup when possible.
  tryLoadFromDisk();

  return {
    refresh,
    snapshot: () => lastGood,
    uiVersion: () => lastGood?.version ?? null,
    serve: () => {
      refresh();
      if (!lastGood) {
        return { status: 503, body: "<p>Board UI unavailable.</p>", version: null };
      }
      return {
        status: 200,
        body: lastGood.servedHtml,
        version: lastGood.version,
      };
    },
  };
}
