import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export function resolveAllowedRoots(roots: string[], configRoot: string): string[] {
  return roots.map((r) => {
    const expanded = expandHome(r);
    const abs = resolve(configRoot, expanded);
    try {
      return realpathSync(abs);
    } catch {
      return abs;
    }
  });
}

/**
 * Resolve a workspace hint from ChatGPT to an absolute directory.
 * Accepts absolute paths, ~/paths, or a folder name matched under allowed_roots.
 */
export function resolveWorkspacePath(
  hint: string,
  allowedRoots: string[],
  configRoot: string,
): string {
  const trimmed = hint.trim();
  if (!trimmed) throw new WorkspaceError("workspace is required");
  if (trimmed.includes("\0") || trimmed.includes("..")) {
    throw new WorkspaceError("invalid workspace path");
  }

  const roots = resolveAllowedRoots(allowedRoots, configRoot);
  if (roots.length === 0) {
    throw new WorkspaceError("no allowed_roots configured");
  }

  let candidate = expandHome(trimmed);
  if (!candidate.startsWith("/")) {
    // Name search under allowed roots (one level + common nesting).
    const matches: string[] = [];
    for (const root of roots) {
      if (!existsSync(root)) continue;
      const direct = join(root, candidate);
      if (existsSync(direct) && statSync(direct).isDirectory()) {
        matches.push(direct);
      }
      try {
        for (const ent of readdirSync(root, { withFileTypes: true })) {
          if (!ent.isDirectory()) continue;
          if (ent.name === candidate || ent.name.toLowerCase() === candidate.toLowerCase()) {
            matches.push(join(root, ent.name));
          }
          // one nested level: Winning/ycrm
          const nested = join(root, ent.name, candidate);
          if (existsSync(nested) && statSync(nested).isDirectory()) {
            matches.push(nested);
          }
        }
      } catch {
        // ignore unreadable roots
      }
    }
    const unique = [...new Set(matches.map((m) => realpathSync(m)))];
    if (unique.length === 0) {
      throw new WorkspaceError(
        `workspace "${hint}" not found under allowed_roots`,
      );
    }
    if (unique.length > 1) {
      throw new WorkspaceError(
        `workspace "${hint}" is ambiguous: ${unique.slice(0, 5).join(", ")}`,
      );
    }
    candidate = unique[0]!;
  } else {
    candidate = resolve(candidate);
    try {
      candidate = realpathSync(candidate);
    } catch {
      throw new WorkspaceError(`workspace does not exist: ${hint}`);
    }
  }

  if (!existsSync(candidate) || !statSync(candidate).isDirectory()) {
    throw new WorkspaceError(`workspace is not a directory: ${candidate}`);
  }

  const ok = roots.some(
    (root) => candidate === root || candidate.startsWith(root + "/"),
  );
  if (!ok) {
    throw new WorkspaceError(
      `workspace is outside allowed_roots: ${candidate}`,
    );
  }

  return candidate;
}

export function workspaceLabel(absPath: string): string {
  return basename(absPath);
}

/** Shallow list of directories under allowed roots for ChatGPT discovery. */
export function listWorkspaceHints(allowedRoots: string[], configRoot: string): Array<{
  name: string;
  path: string;
  root: string;
}> {
  const roots = resolveAllowedRoots(allowedRoots, configRoot);
  const out: Array<{ name: string; path: string; root: string }> = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    try {
      for (const ent of readdirSync(root, { withFileTypes: true })) {
        if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
        const path = join(root, ent.name);
        out.push({ name: ent.name, path, root });
        // one nested level for monorepo-ish layouts
        try {
          for (const child of readdirSync(path, { withFileTypes: true })) {
            if (!child.isDirectory() || child.name.startsWith(".")) continue;
            // Prefer dirs that look like projects (have .git or package.json)
            const childPath = join(path, child.name);
            if (
              existsSync(join(childPath, ".git")) ||
              existsSync(join(childPath, "package.json"))
            ) {
              out.push({
                name: `${ent.name}/${child.name}`,
                path: childPath,
                root,
              });
            }
          }
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  }
  return out.slice(0, 200);
}
