import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, normalize, resolve, sep } from "node:path";

export class PathSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathSafetyError";
  }
}

function assertNoNullByte(input: string): void {
  if (input.includes("\0")) {
    throw new PathSafetyError("path contains null byte");
  }
}

/**
 * Resolve `candidate` under `root`, rejecting traversal and symlink escapes.
 * Both root and the final target must resolve inside root's real path.
 */
export function resolveSafePath(root: string, candidate: string): string {
  assertNoNullByte(root);
  assertNoNullByte(candidate);

  if (isAbsolute(candidate)) {
    throw new PathSafetyError("absolute paths are not allowed");
  }

  const normalizedRoot = resolve(root);
  let rootReal: string;
  try {
    rootReal = realpathSync(normalizedRoot);
  } catch {
    throw new PathSafetyError("root path does not exist");
  }

  const cleaned = normalize(candidate);
  if (cleaned.startsWith(".." + sep) || cleaned === "..") {
    throw new PathSafetyError("path traversal rejected");
  }

  const joined = resolve(rootReal, cleaned);
  if (!joined.startsWith(rootReal + sep) && joined !== rootReal) {
    throw new PathSafetyError("path escapes root");
  }

  // Walk each segment; if a symlink appears, its real path must stay in root.
  const parts = cleaned.split(sep).filter(Boolean);
  let cursor = rootReal;
  for (const part of parts) {
    cursor = resolve(cursor, part);
    let st;
    try {
      st = lstatSync(cursor);
    } catch {
      // Intermediate missing is ok for create targets; final still constrained.
      continue;
    }
    if (st.isSymbolicLink()) {
      let targetReal: string;
      try {
        targetReal = realpathSync(cursor);
      } catch {
        throw new PathSafetyError("symlink target cannot be resolved");
      }
      if (!targetReal.startsWith(rootReal + sep) && targetReal !== rootReal) {
        throw new PathSafetyError("symlink escapes root");
      }
      cursor = targetReal;
    }
  }

  // If the final path exists, re-check realpath containment.
  try {
    const finalReal = realpathSync(joined);
    if (!finalReal.startsWith(rootReal + sep) && finalReal !== rootReal) {
      throw new PathSafetyError("resolved path escapes root");
    }
    return finalReal;
  } catch (err) {
    if (err instanceof PathSafetyError) throw err;
    return joined;
  }
}

/** Ensure an absolute path is still within an approved root after realpath. */
export function assertInsideRoot(root: string, absolutePath: string): string {
  assertNoNullByte(root);
  assertNoNullByte(absolutePath);
  const rootReal = realpathSync(resolve(root));
  const targetReal = realpathSync(resolve(absolutePath));
  if (!targetReal.startsWith(rootReal + sep) && targetReal !== rootReal) {
    throw new PathSafetyError("path escapes approved root");
  }
  return targetReal;
}
