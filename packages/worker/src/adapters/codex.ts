import type { AgentAdapter, AdapterContext, AdapterPlan } from "./types.js";

/**
 * Codex adapter — noninteractive host CLI:
 *   codex exec --json -C <dir> -m <model> -c model_reasoning_effort="…"
 *     --approve-for-me -s workspace-write [resume <id>] "<prompt>"
 */
export class CodexAdapter implements AgentAdapter {
  readonly kind = "codex" as const;
  readonly acceptsLiveFollowup = false;

  plan(ctx: AdapterContext): AdapterPlan {
    const resume = ctx.job.session_id;
    const prompt =
      ctx.followupMessages.length > 0
        ? `${ctx.job.prompt}\n\nFollow-up instructions:\n${ctx.followupMessages.join("\n")}`
        : ctx.job.prompt;

    const binary = ctx.binary ?? "codex";
    const args = ["exec", "--json", "-C", ctx.workPath];
    if (ctx.model) {
      args.push("-m", ctx.model);
    }
    if (ctx.reasoningEffort) {
      args.push("-c", `model_reasoning_effort="${ctx.reasoningEffort}"`);
    }
    // Codex CLI 0.164 rejects an explicit `--sandbox workspace-write` when
    // `--approve-for-me` is present. The latter selects automatic review with
    // the workspace-write sandbox itself, so it is both sufficient and the
    // compatible invocation for managed jobs.
    args.push("--approve-for-me");
    if (resume) {
      args.push("resume", resume, prompt);
    } else {
      args.push(prompt);
    }

    const parseSessionId = (stdout: string) => {
      const fromJsonl = parseCodexSessionFromJsonl(stdout);
      if (fromJsonl) return fromJsonl;
      const m = stdout.match(
        /\b(?:thread|session)[_-]?(?:id)?["']?\s*[:=]\s*["']?([a-f0-9-]{8,})/i,
      );
      return m?.[1] ?? resume;
    };
    const summarize = (stdout: string) =>
      summarizeCodexJsonl(stdout) || stdout.trim().slice(-800) || "codex finished";

    if (ctx.execution === "host") {
      return {
        kind: "codex",
        execution: "host",
        liveWorkspace: true,
        hostSpec: {
          command: binary,
          args,
          cwd: ctx.workPath,
          env: { JOB_ID: ctx.job.id },
          timeoutSec: ctx.timeoutSec,
          name: `codex-${ctx.job.id.slice(0, 8)}`,
        },
        parseSessionId,
        summarize,
      };
    }

    return {
      kind: "codex",
      execution: "docker",
      runSpec: {
        image: ctx.isolationImage,
        command: [binary, ...args],
        workdir: "/work",
        env: { JOB_ID: ctx.job.id },
        mounts: [
          { hostPath: ctx.workPath, containerPath: "/work", readOnly: false },
        ],
        network: ctx.network === "none" ? "none" : ctx.network,
        runAsUser: ctx.runAsUser,
        readOnlyRootfs: ctx.readOnlyRootfs,
        memoryMb: ctx.memoryMb,
        cpus: ctx.cpus,
        name: `ac-codex-${ctx.job.id.slice(0, 8)}`,
        timeoutSec: ctx.timeoutSec,
      },
      parseSessionId,
      summarize,
    };
  }
}

export function parseCodexSessionFromJsonl(stdout: string): string | null {
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const ev = JSON.parse(t) as Record<string, unknown>;
      let id: string | null = null;
      if (typeof ev.thread_id === "string") id = ev.thread_id;
      else if (typeof ev.session_id === "string") id = ev.session_id;
      else if (
        ev.thread &&
        typeof ev.thread === "object" &&
        typeof (ev.thread as { id?: string }).id === "string"
      ) {
        id = (ev.thread as { id: string }).id;
      }
      if (id) return id;
    } catch {
      // skip non-json lines
    }
  }
  return null;
}

export function summarizeCodexJsonl(stdout: string): string | null {
  let lastMessage: string | null = null;
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const ev = JSON.parse(t) as Record<string, unknown>;
      if (ev.type === "message" && typeof ev.text === "string") {
        lastMessage = ev.text;
      }
      if (ev.type === "agent_message" && typeof ev.content === "string") {
        lastMessage = ev.content;
      }
      const item = ev.item as {type?: string; text?: unknown} | undefined;
      if (ev.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") lastMessage = item.text;
      const msg = ev.message;
      if (msg && typeof msg === "object" && typeof (msg as { content?: string }).content === "string") {
        lastMessage = (msg as { content: string }).content;
      }
    } catch {
      // ignore
    }
  }
  return lastMessage?.trim() ? lastMessage.trim().slice(-2000) : null;
}

export type CodexUsageMetrics = {
  input_tokens: number | null;
  output_tokens: number | null;
  label: "actual" | "estimate";
};

export function parseCodexUsageFromJsonl(stdout: string): CodexUsageMetrics {
  let input: number | null = null;
  let output: number | null = null;
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const ev = JSON.parse(t) as Record<string, unknown>;
      const usage = ev.usage ?? ev.token_usage;
      if (usage && typeof usage === "object") {
        const u = usage as Record<string, unknown>;
        if (typeof u.input_tokens === "number") input = u.input_tokens;
        if (typeof u.output_tokens === "number") output = u.output_tokens;
        if (typeof u.prompt_tokens === "number") input = u.prompt_tokens;
        if (typeof u.completion_tokens === "number") output = u.completion_tokens;
      }
    } catch {
      // ignore
    }
  }
  const label =
    input != null || output != null ? ("actual" as const) : ("estimate" as const);
  return { input_tokens: input, output_tokens: output, label };
}
