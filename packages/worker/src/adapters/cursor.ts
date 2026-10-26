import type { AgentAdapter, AdapterContext, AdapterPlan } from "./types.js";

/**
 * Cursor adapter — host CLI:
 *   agent -p --force --trust --workspace <dir> [--model …] [--mode ask|plan] [--resume] "prompt"
 *
 * Research/triage tiers prefer --mode ask (read-only) + cheaper models to save credits.
 */
export class CursorAdapter implements AgentAdapter {
  readonly kind = "cursor" as const;
  readonly acceptsLiveFollowup = false;

  plan(ctx: AdapterContext): AdapterPlan {
    const resume = ctx.job.session_id;
    const prompt =
      ctx.followupMessages.length > 0
        ? `${ctx.job.prompt}\n\nFollow-up instructions:\n${ctx.followupMessages.join("\n")}`
        : ctx.job.prompt;

    const binary = ctx.binary ?? "agent";
    const args = [
      "-p",
      "--force",
      "--trust",
      "--output-format",
      "text",
      "--workspace",
      ctx.workPath,
    ];
    if (ctx.model) {
      args.push("--model", ctx.model);
    }
    if (ctx.cursorMode) {
      args.push("--mode", ctx.cursorMode);
    }
    if (resume) {
      args.push("--resume", resume);
    }
    args.push(prompt);

    const parseSessionId = (stdout: string) => {
      const m = stdout.match(
        /\b(?:chat[_-]?id|session[_-]?id)["']?\s*[:=]\s*["']?([a-zA-Z0-9_-]+)/i,
      );
      return m?.[1] ?? resume;
    };
    const summarize = (stdout: string) =>
      stdout.trim().slice(-800) || "cursor finished";

    if (ctx.execution === "host") {
      return {
        kind: "cursor",
        execution: "host",
        liveWorkspace: true,
        hostSpec: {
          command: binary,
          args,
          cwd: ctx.workPath,
          env: { JOB_ID: ctx.job.id },
          timeoutSec: ctx.timeoutSec,
          name: `cursor-${ctx.job.id.slice(0, 8)}`,
        },
        parseSessionId,
        summarize,
      };
    }

    return {
      kind: "cursor",
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
        name: `ac-cursor-${ctx.job.id.slice(0, 8)}`,
        timeoutSec: ctx.timeoutSec,
      },
      parseSessionId,
      summarize,
    };
  }
}
