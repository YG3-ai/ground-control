import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

export class BinaryResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BinaryResolveError";
  }
}

const DEFAULT_SEARCH_DIRS = [
  join(homedir(), ".local", "bin"),
  join(homedir(), ".kimi-code", "bin"),
  join(homedir(), ".cursor", "bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
];

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a CLI binary for noninteractive workers (launchd PATH is thin).
 * Prefer configured absolute path; otherwise search known user-local dirs + PATH.
 */
export function resolveExecutable(
  configured: string | undefined,
  fallbackName: string,
  extraDirs: string[] = [],
): { path: string; searched: string[] } {
  const name = (configured && configured.trim()) || fallbackName;
  const searched: string[] = [];

  if (isAbsolute(name)) {
    searched.push(name);
    if (existsSync(name) && isExecutable(name)) {
      return { path: name, searched };
    }
    throw new BinaryResolveError(
      `executable not found or not executable: ${name}. ` +
        `Set agents.*.binary to an absolute path that exists.`,
    );
  }

  const dirs = [
    ...extraDirs.map((d) => d.replace(/^~(?=\/|$)/, homedir())),
    ...DEFAULT_SEARCH_DIRS,
    ...(process.env.PATH ? process.env.PATH.split(delimiter) : []),
  ];

  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = join(dir, name);
    searched.push(candidate);
    if (existsSync(candidate) && isExecutable(candidate)) {
      return { path: candidate, searched };
    }
  }

  throw new BinaryResolveError(
    `executable "${name}" not found. Searched: ${searched.slice(0, 12).join(", ")}` +
      (searched.length > 12 ? ` (+${searched.length - 12} more)` : "") +
      `. Configure agents.*.binary as an absolute path (e.g. ${join(homedir(), ".local/bin/agent")}).`,
  );
}

export type ModelSupport = {
  flag: string | null;
  listCommand: string[] | null;
  knownModels: string[] | null;
  notes: string;
};

/** Detect model CLI flags from help text; never invent unsupported flags. */
export function detectModelSupport(
  kind: "cursor" | "kimi" | "shell",
  helpText: string,
): ModelSupport {
  if (kind === "shell") {
    return {
      flag: null,
      listCommand: null,
      knownModels: null,
      notes: "shell sessions have no model flag",
    };
  }
  const hasLongModel = /--model\b/.test(helpText);
  // Accept "-m", "-m,", or paired "-m, --model" forms from real CLI help.
  const hasShortM = /(^|\s)-m([\s,=]|$)/.test(helpText);
  const hasListModels = /--list-models\b/.test(helpText);

  if (kind === "cursor" && hasLongModel) {
    return {
      flag: "--model",
      listCommand: hasListModels ? ["--list-models"] : null,
      knownModels: null,
      notes: "per-session --model; does not change global defaults",
    };
  }
  if (kind === "kimi" && (hasLongModel || hasShortM)) {
    return {
      flag: "-m",
      listCommand: null,
      knownModels: null,
      notes: "per-session -m/--model; does not change default_model in config.toml",
    };
  }
  return {
    flag: null,
    listCommand: null,
    knownModels: null,
    notes: "no verified model flag in CLI help; model argument will be rejected",
  };
}
