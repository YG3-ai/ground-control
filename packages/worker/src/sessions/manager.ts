import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import * as pty from "node-pty";
import {
  REDACTION_DISCLAIMER,
  boundOutput,
  redactSecrets,
  type AgentKind,
} from "@agent-control/shared";
import {
  BinaryResolveError,
  detectModelSupport,
  resolveExecutable,
} from "../binary-resolve.js";
import { OutputBuffer } from "./buffer.js";
import { SUPPORTED_CONTROL_KEYS, encodeSessionInput } from "./keys.js";

export type SessionKind = "shell" | "cursor" | "kimi";
export type SessionState = "waiting" | "running" | "exited" | "error";

export type ModelMeta = {
  requested: string | null;
  effective: string | null;
  status: "applied" | "default" | "unknown" | "rejected";
  detail: string | null;
};

export type SessionRecord = {
  id: string;
  owner_id: string;
  kind: SessionKind;
  workspace: string;
  cwd: string;
  state: SessionState;
  pid: number | null;
  cols: number;
  rows: number;
  created_at: string;
  updated_at: string;
  last_activity_at: string;
  expires_at: string | null;
  exit_code: number | null;
  error: string | null;
  command: string;
  args: string[];
  model: ModelMeta;
  note: string;
};

export type CreateSessionInput = {
  ownerId: string;
  kind: SessionKind;
  workspacePath: string;
  cols?: number;
  rows?: number;
  model?: string;
  /** Idle expiry in seconds; null = no idle expiry */
  idleSec?: number | null;
  shellBinary?: string;
  agentBinary?: string;
  kimiBinary?: string;
  maxOutputBytes: number;
};

type LiveSession = {
  record: SessionRecord;
  pty: pty.IPty | null;
  buffer: OutputBuffer;
  idleTimer: NodeJS.Timeout | null;
  idleSec: number | null;
};

function nowIso(): string {
  return new Date().toISOString();
}

function shellArgs(shellPath: string): string[] {
  const base = shellPath.split("/").pop() ?? "sh";
  if (base === "zsh" || base === "bash") return ["-l"];
  return [];
}

/**
 * In-memory PTY session manager. Sessions outlive MCP request turns while the
 * worker process is alive. On worker restart all PTYs are gone (not OS-attached).
 */
export class TerminalSessionManager {
  private readonly sessions = new Map<string, LiveSession>();
  private readonly modelCache = new Map<
    string,
    { help: string; models: string[] | null; at: number }
  >();
  /**
   * Optional event sink (Ground Life Mirror). Lifecycle metadata ONLY —
   * kind/state/exit code. Never command, args, cwd, or output content.
   */
  onEvent?: import("../events/types.js").EventSink;

  constructor(
    private readonly opts: {
      ownerId: string;
      defaultIdleSec: number;
      defaultCols: number;
      defaultRows: number;
    },
  ) {}

  assertOwner(ownerId: string): void {
    if (ownerId !== this.opts.ownerId) {
      throw new Error("unauthorized owner");
    }
  }

  create(input: CreateSessionInput): SessionRecord {
    this.assertOwner(input.ownerId);
    const id = randomUUID();
    const cols = input.cols ?? this.opts.defaultCols;
    const rows = input.rows ?? this.opts.defaultRows;
    const idleSec =
      input.idleSec === undefined
        ? this.opts.defaultIdleSec
        : input.idleSec;
    const created = nowIso();

    let command: string;
    let args: string[] = [];
    let modelMeta: ModelMeta = {
      requested: input.model ?? null,
      effective: null,
      status: "default",
      detail: null,
    };

    try {
      if (input.kind === "shell") {
        const shell =
          input.shellBinary ??
          process.env.SHELL ??
          (existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/bash");
        const resolved = resolveExecutable(shell, "zsh");
        command = resolved.path;
        args = shellArgs(command);
        if (input.model) {
          modelMeta = {
            requested: input.model,
            effective: null,
            status: "rejected",
            detail: "shell sessions do not accept model",
          };
        }
      } else if (input.kind === "cursor") {
        const resolved = resolveExecutable(input.agentBinary, "agent");
        command = resolved.path;
        const support = this.probeModelSupport("cursor", command);
        args = ["--trust", "--workspace", input.workspacePath];
        modelMeta = this.applyModel(input.model, support, args);
      } else {
        const resolved = resolveExecutable(input.kimiBinary, "kimi");
        command = resolved.path;
        const support = this.probeModelSupport("kimi", command);
        args = [];
        modelMeta = this.applyModel(input.model, support, args);
      }
    } catch (err) {
      throw err instanceof BinaryResolveError
        ? err
        : new Error(err instanceof Error ? err.message : String(err));
    }

    if (modelMeta.status === "rejected" && input.kind !== "shell") {
      throw new Error(modelMeta.detail ?? "model not supported");
    }
    if (input.kind === "shell" && modelMeta.status === "rejected" && input.model) {
      throw new Error(modelMeta.detail ?? "model not supported for shell");
    }

    const record: SessionRecord = {
      id,
      owner_id: input.ownerId,
      kind: input.kind,
      workspace: input.workspacePath,
      cwd: input.workspacePath,
      state: "waiting",
      pid: null,
      cols,
      rows,
      created_at: created,
      updated_at: created,
      last_activity_at: created,
      expires_at:
        idleSec != null && idleSec > 0
          ? new Date(Date.now() + idleSec * 1000).toISOString()
          : null,
      exit_code: null,
      error: null,
      command,
      args,
      model: modelMeta,
      note:
        "Session cwd is the workspace root (not an OS sandbox). Process dies if the worker restarts.",
    };

    const buffer = new OutputBuffer(input.maxOutputBytes);
    let term: pty.IPty;
    try {
      term = pty.spawn(command, args, {
        name: "xterm-256color",
        cols,
        rows,
        cwd: input.workspacePath,
        env: {
          ...process.env,
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
          // Keep PATH usable for nested tools inside interactive agents
          PATH: enrichPath(process.env.PATH),
        } as Record<string, string>,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new BinaryResolveError(
        `failed to spawn PTY for ${command}: ${msg}. ` +
          `If exit was 127 / ENOENT, set an absolute binary path in config.`,
      );
    }

    record.state = "running";
    record.pid = term.pid;
    record.updated_at = nowIso();

    const live: LiveSession = {
      record,
      pty: term,
      buffer,
      idleTimer: null,
      idleSec: idleSec != null && idleSec > 0 ? idleSec : null,
    };
    this.sessions.set(id, live);

    term.onData((data) => {
      buffer.append(data);
      this.touch(live);
    });
    term.onExit(({ exitCode }) => {
      live.record.state = "exited";
      live.record.exit_code = exitCode;
      live.record.pid = null;
      live.record.updated_at = nowIso();
      live.pty = null;
      this.clearIdle(live);
      this.onEvent?.({
        source: "sessions",
        sourceRef: record.id,
        actor: record.kind === "shell" ? "owner" : `agent:${record.kind}`,
        verb: "session.exited",
        objectType: "session",
        objectId: record.id,
        fromState: record.kind,
        toState: `exited:${exitCode}`,
        occurredAt: live.record.updated_at,
        evidenceRefs: [`session:${record.id}`],
        sensitivity: "internal",
        dedupeKey: `exited:${exitCode}`,
      });
    });

    this.armIdle(live);
    this.onEvent?.({
      source: "sessions",
      sourceRef: record.id,
      actor: record.kind === "shell" ? "owner" : `agent:${record.kind}`,
      verb: "session.created",
      objectType: "session",
      objectId: record.id,
      toState: record.kind,
      occurredAt: record.created_at,
      evidenceRefs: [`session:${record.id}`],
      sensitivity: "internal",
      dedupeKey: "created",
    });
    return { ...record };
  }

  list(ownerId: string): SessionRecord[] {
    this.assertOwner(ownerId);
    return [...this.sessions.values()]
      .filter((s) => s.record.owner_id === ownerId)
      .map((s) => ({ ...s.record }))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  get(ownerId: string, sessionId: string): SessionRecord {
    return { ...this.requireOwned(ownerId, sessionId).record };
  }

  read(
    ownerId: string,
    sessionId: string,
    opts: { offset?: number; maxBytes?: number } = {},
  ) {
    const live = this.requireOwned(ownerId, sessionId);
    const maxBytes = opts.maxBytes ?? 32_768;
    const chunk = live.buffer.read(opts.offset, maxBytes);
    const redacted = redactSecrets(chunk.text);
    const bounded = boundOutput(redacted.text, maxBytes);
    return {
      session_id: sessionId,
      state: live.record.state,
      ...chunk,
      text: bounded.text,
      truncated: bounded.truncated || chunk.truncated_before,
      redacted: redacted.redacted,
      redaction_note: REDACTION_DISCLAIMER,
      exit_code: live.record.exit_code,
      error: live.record.error,
    };
  }

  /** Last N bytes of PTY output (for situational awareness). */
  readTail(ownerId: string, sessionId: string, maxBytes = 4096) {
    const live = this.requireOwned(ownerId, sessionId);
    const cap = Math.min(Math.max(1, maxBytes), 32_768);
    const start = Math.max(
      live.buffer.oldestOffset,
      live.buffer.nextOffset - cap,
    );
    return this.read(ownerId, sessionId, { offset: start, maxBytes: cap });
  }

  write(
    ownerId: string,
    sessionId: string,
    input: { data?: string; keys?: string[]; submit?: boolean },
  ): SessionRecord {
    const live = this.requireOwned(ownerId, sessionId);
    if (!live.pty || live.record.state !== "running") {
      throw new Error(`session is not running (state=${live.record.state})`);
    }
    const encoded = encodeSessionInput(input);
    if (!encoded) {
      throw new Error(
        `empty input; provide data and/or keys (${SUPPORTED_CONTROL_KEYS.join(", ")}) and/or submit=true`,
      );
    }
    live.pty.write(encoded);
    this.touch(live);
    return { ...live.record };
  }

  resize(
    ownerId: string,
    sessionId: string,
    cols: number,
    rows: number,
  ): SessionRecord {
    const live = this.requireOwned(ownerId, sessionId);
    if (!live.pty || live.record.state !== "running") {
      throw new Error(`session is not running (state=${live.record.state})`);
    }
    live.pty.resize(cols, rows);
    live.record.cols = cols;
    live.record.rows = rows;
    live.record.updated_at = nowIso();
    this.touch(live);
    return { ...live.record };
  }

  interrupt(ownerId: string, sessionId: string): SessionRecord {
    return this.write(ownerId, sessionId, { keys: ["ctrl-c"] });
  }

  close(ownerId: string, sessionId: string): SessionRecord {
    const live = this.requireOwned(ownerId, sessionId);
    this.clearIdle(live);
    if (live.pty) {
      try {
        live.pty.write("\x03");
      } catch {
        // ignore
      }
      try {
        live.pty.kill();
      } catch {
        // ignore
      }
      live.pty = null;
    }
    if (live.record.state === "running" || live.record.state === "waiting") {
      live.record.state = "exited";
      live.record.exit_code = live.record.exit_code ?? 0;
    }
    live.record.updated_at = nowIso();
    this.sessions.delete(sessionId);
    return { ...live.record };
  }

  /** Kill all PTYs (worker shutdown). */
  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) {
      const live = this.sessions.get(id);
      if (!live) continue;
      this.clearIdle(live);
      try {
        live.pty?.kill();
      } catch {
        // ignore
      }
      this.sessions.delete(id);
    }
  }

  capabilities(ownerId: string, agentCfg: {
    cursorBinary?: string;
    kimiBinary?: string;
  }) {
    this.assertOwner(ownerId);
    const cursor = this.safeResolve(agentCfg.cursorBinary, "agent");
    const kimi = this.safeResolve(agentCfg.kimiBinary, "kimi");
    const shell = this.safeResolve(process.env.SHELL ?? "/bin/zsh", "zsh");
    return {
      session_kinds: ["shell", "cursor", "kimi"] as SessionKind[],
      supported_control_keys: SUPPORTED_CONTROL_KEYS,
      restart_behavior:
        "Interactive PTY sessions live only in the worker process. Worker restart ends them; managed jobs remain in SQLite with in-flight marked failed.",
      workspace_note:
        "workspace selects the initial cwd under allowed_roots; it is not an OS sandbox.",
      binaries: {
        shell,
        cursor,
        kimi,
      },
      models: {
        cursor: cursor.ok
          ? this.probeModelSupport("cursor", cursor.path)
          : null,
        kimi: kimi.ok ? this.probeModelSupport("kimi", kimi.path) : null,
      },
    };
  }

  private safeResolve(configured: string | undefined, fallback: string) {
    try {
      const r = resolveExecutable(configured, fallback);
      return { ok: true as const, path: r.path, error: null };
    } catch (err) {
      return {
        ok: false as const,
        path: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private requireOwned(ownerId: string, sessionId: string): LiveSession {
    this.assertOwner(ownerId);
    const live = this.sessions.get(sessionId);
    if (!live) throw new Error(`session not found: ${sessionId}`);
    if (live.record.owner_id !== ownerId) {
      throw new Error("session not found");
    }
    return live;
  }

  private touch(live: LiveSession): void {
    live.record.last_activity_at = nowIso();
    live.record.updated_at = live.record.last_activity_at;
    if (live.idleSec) {
      live.record.expires_at = new Date(
        Date.now() + live.idleSec * 1000,
      ).toISOString();
    }
    this.armIdle(live);
  }

  private armIdle(live: LiveSession): void {
    this.clearIdle(live);
    if (!live.idleSec) return;
    live.idleTimer = setTimeout(() => {
      live.record.error = "idle expired";
      live.record.state = "error";
      try {
        live.pty?.kill();
      } catch {
        // ignore
      }
      live.pty = null;
      live.record.updated_at = nowIso();
      this.sessions.delete(live.record.id);
    }, live.idleSec * 1000);
    live.idleTimer.unref?.();
  }

  private clearIdle(live: LiveSession): void {
    if (live.idleTimer) {
      clearTimeout(live.idleTimer);
      live.idleTimer = null;
    }
  }

  private probeModelSupport(kind: "cursor" | "kimi", binary: string) {
    const cached = this.modelCache.get(binary);
    const help =
      cached && Date.now() - cached.at < 300_000
        ? cached.help
        : (() => {
            const r = spawnSync(binary, ["--help"], {
              encoding: "utf8",
              timeout: 8_000,
              env: { ...process.env, PATH: enrichPath(process.env.PATH) },
            });
            return `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
          })();

    const support = detectModelSupport(kind, help);
    let knownModels = cached?.models ?? null;
    if (support.listCommand && knownModels == null) {
      const listed = spawnSync(binary, support.listCommand, {
        encoding: "utf8",
        timeout: 15_000,
        env: { ...process.env, PATH: enrichPath(process.env.PATH) },
      });
      const text = `${listed.stdout ?? ""}\n${listed.stderr ?? ""}`;
      knownModels = parseModelList(text);
    }
    this.modelCache.set(binary, {
      help,
      models: knownModels,
      at: Date.now(),
    });
    return { ...support, knownModels };
  }

  private applyModel(
    requested: string | undefined,
    support: ReturnType<TerminalSessionManager["probeModelSupport"]>,
    args: string[],
  ): ModelMeta {
    if (!requested) {
      return {
        requested: null,
        effective: null,
        status: "default",
        detail: support.notes,
      };
    }
    if (!support.flag) {
      return {
        requested,
        effective: null,
        status: "rejected",
        detail: "CLI help does not expose a verified model flag",
      };
    }
    if (support.knownModels && support.knownModels.length > 0) {
      const ok = support.knownModels.some(
        (m) => m === requested || m.startsWith(requested + " "),
      );
      if (!ok) {
        return {
          requested,
          effective: null,
          status: "rejected",
          detail: `model "${requested}" not in CLI --list-models output`,
        };
      }
    }
    args.push(support.flag, requested);
    return {
      requested,
      effective: requested,
      status: "applied",
      detail: support.knownModels ? "matched installed model list" : "flag applied; effective model not verified",
    };
  }
}

function enrichPath(existing: string | undefined): string {
  const extras = [
    `${homedir()}/.local/bin`,
    `${homedir()}/.kimi-code/bin`,
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  const parts = [...extras, ...(existing ? existing.split(":") : [])];
  return [...new Set(parts.filter(Boolean))].join(":");
}

function parseModelList(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const models: string[] = [];
  for (const line of lines) {
    const m = line.match(
      /^\s*([a-z0-9][a-z0-9._-]*(?:\[[^\]]+\])?)\s+-\s+/i,
    );
    if (m?.[1]) models.push(m[1]);
  }
  return models;
}

export type { AgentKind };
