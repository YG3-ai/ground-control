import { execSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";

const MAC_HOME_SEGMENT_ALLOW = new Set([
  "YOU",
  "LOCAL",
  "Shared",
  "shared",
]);

const HTTPS_HOST_ALLOW_SUFFIXES = [
  "ngrok-free.app",
  "example.com",
  "YOUR_HOST",
  "your-relay.example.com",
  "your-stable-name.ngrok-free.app",
  "github.com",
  "stripe.com",
];

export function loadBoundary(root) {
  const raw = readFileSync(join(root, "release/boundary.json"), "utf8");
  return JSON.parse(raw);
}

function normalizeRel(p) {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

function globToRegex(glob) {
  let g = normalizeRel(glob);
  const parts = [];
  for (let i = 0; i < g.length; i++) {
    if (g[i] === "*" && g[i + 1] === "*") {
      if (g[i + 2] === "/") {
        parts.push("(?:.+/)?");
        i += 2;
      } else {
        parts.push(".*");
        i += 1;
      }
    } else if (g[i] === "*") {
      parts.push("[^/]*");
    } else if (g[i] === "?") {
      parts.push(".");
    } else if ("+^${}()|[]\\".includes(g[i])) {
      parts.push("\\" + g[i]);
    } else {
      parts.push(g[i]);
    }
  }
  return new RegExp("^" + parts.join("") + "$");
}

export function matchesAnyGlob(relPath, globs) {
  const p = normalizeRel(relPath);
  for (const g of globs) {
    if (globToRegex(g).test(p)) return true;
  }
  return false;
}

export function isInReleaseBoundary(relPath, boundary) {
  const p = normalizeRel(relPath);
  if (!matchesAnyGlob(p, boundary.includeGlobs)) return false;
  if (matchesAnyGlob(p, boundary.excludeGlobs)) return false;
  return true;
}

function walkFiles(dir, root, out) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const abs = join(dir, name);
    const rel = normalizeRel(relative(root, abs));
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkFiles(abs, root, out);
    } else if (st.isFile()) {
      out.push(rel);
    }
  }
}

export function listCandidateWalk(root, boundary) {
  const all = [];
  walkFiles(root, root, all);
  return all.filter((p) => isInReleaseBoundary(p, boundary));
}

export function resolveManifest(root, boundary) {
  const limitation = [];
  let mode = "candidate-walk";
  let files = [];

  try {
    execSync("git rev-parse --git-dir", { cwd: root, stdio: "pipe" });
  } catch {
    limitation.push("not_a_git_repository");
    files = listCandidateWalk(root, boundary);
    return { mode, files, limitation };
  }

  let hasHead = false;
  try {
    execSync("git rev-parse --verify HEAD", { cwd: root, stdio: "pipe" });
    hasHead = true;
  } catch {
    limitation.push("no_commits_index_unavailable");
  }

  if (hasHead) {
    try {
      const staged = execSync("git diff --cached --name-only -z", {
        cwd: root,
        encoding: "buffer",
      });
      const stagedFiles = staged
        .toString("utf8")
        .split("\0")
        .map(normalizeRel)
        .filter(Boolean);
      if (stagedFiles.length > 0) {
        mode = "git-staged";
        files = stagedFiles.filter((p) => isInReleaseBoundary(p, boundary));
        return { mode, files, limitation };
      }
    } catch {
      limitation.push("git_staged_list_failed");
    }

    try {
      const tracked = execSync("git ls-files -z", {
        cwd: root,
        encoding: "buffer",
      });
      const trackedFiles = tracked
        .toString("utf8")
        .split("\0")
        .map(normalizeRel)
        .filter(Boolean);
      if (trackedFiles.length > 0) {
        mode = "git-tracked";
        files = trackedFiles.filter((p) => isInReleaseBoundary(p, boundary));
        return { mode, files, limitation };
      }
    } catch {
      limitation.push("git_ls_files_failed");
    }
  }

  mode = "candidate-walk";
  files = listCandidateWalk(root, boundary);
  if (!hasHead) {
    limitation.push("using_candidate_walk_no_index");
  } else {
    limitation.push("using_candidate_walk_empty_index");
  }
  return { mode, files, limitation };
}

export function forbiddenPathFinding(relPath, boundary) {
  const base = basename(relPath);
  if (boundary.forbiddenBasenameExceptions?.includes(base)) return null;
  if (boundary.forbiddenBasenames?.includes(base)) {
    return { path: relPath, kind: "forbidden_basename" };
  }
  for (const prefix of boundary.forbiddenBasenamePrefixes ?? []) {
    if (base.startsWith(prefix) && !boundary.forbiddenBasenameExceptions?.includes(base)) {
      return { path: relPath, kind: "forbidden_env_file" };
    }
  }
  const ext = base.includes(".") ? "." + base.split(".").pop() : "";
  if (boundary.forbiddenExtensions?.includes(ext)) {
    return { path: relPath, kind: "forbidden_extension" };
  }
  if (matchesAnyGlob(relPath, boundary.excludeGlobs)) {
    return { path: relPath, kind: "excluded_pattern" };
  }
  return null;
}

const MAC_HOME_RE = /\/Users\/([A-Za-z0-9._-]+)\//g;
const VOLUME_RE = /\/Volumes\/[^/\s"']+/g;
const HTTPS_RE = /https:\/\/([a-z0-9._-]+)/gi;

function httpsHostAllowed(host) {
  const h = host.toLowerCase();
  if (h === "127.0.0.1" || h === "localhost") return true;
  if (h.startsWith("your") || h.includes("your_") || h.includes("your-")) return true;
  if (h === "ngrok.com" || h.endsWith(".ngrok.com")) return true;
  if (h === "yg3.ai" || h.endsWith(".yg3.ai")) return true;
  return HTTPS_HOST_ALLOW_SUFFIXES.some(
    (s) => h === s.toLowerCase() || h.endsWith("." + s.toLowerCase()),
  );
}

const TEMPLATE_ROOT_TOKEN = "__GROUND_CONTROL_ROOT__";
const TEMPLATE_MENUBAR_TOKEN = "__MENUBAR_APP_BUNDLE__";

export function startupContentFindings(relPath, text) {
  const sanitized = text
    .replaceAll(TEMPLATE_ROOT_TOKEN, "")
    .replaceAll(TEMPLATE_MENUBAR_TOKEN, "");
  const findings = [];
  MAC_HOME_RE.lastIndex = 0;
  let m;
  while ((m = MAC_HOME_RE.exec(sanitized)) !== null) {
    const seg = m[1];
    if (!MAC_HOME_SEGMENT_ALLOW.has(seg)) {
      findings.push({ path: relPath, kind: "machine_user_home_path" });
      break;
    }
  }
  VOLUME_RE.lastIndex = 0;
  if (VOLUME_RE.test(sanitized)) {
    findings.push({ path: relPath, kind: "external_volume_path" });
  }
  HTTPS_RE.lastIndex = 0;
  while ((m = HTTPS_RE.exec(sanitized)) !== null) {
    if (!httpsHostAllowed(m[1])) {
      findings.push({ path: relPath, kind: "hardcoded_https_host" });
      break;
    }
  }
  if (
    (relPath === ".env.example" || relPath.startsWith("docs/")) &&
    /\bPARTHA_WORK_ROOT\b/.test(sanitized)
  ) {
    findings.push({ path: relPath, kind: "legacy_work_root_env_key" });
  }
  return findings;
}

export function analyzeRelease(root, boundary, manifest) {
  const pathFindings = [];
  const startupFindings = [];
  const seenStartup = new Set();

  for (const rel of manifest.files) {
    const forbidden = forbiddenPathFinding(rel, boundary);
    if (forbidden) pathFindings.push(forbidden);

    if (!matchesAnyGlob(rel, boundary.startupConfigGlobs)) continue;
    const abs = join(root, rel);
    let text;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      pathFindings.push({ path: rel, kind: "startup_file_unreadable" });
      continue;
    }
    for (const f of startupContentFindings(rel, text)) {
      const key = `${f.path}:${f.kind}`;
      if (!seenStartup.has(key)) {
        seenStartup.add(key);
        startupFindings.push(f);
      }
    }
  }

  return { pathFindings, startupFindings };
}
