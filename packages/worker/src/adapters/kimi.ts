import type { AgentAdapter, AdapterContext, AdapterPlan } from "./types.js";

/**
 * Kimi adapter — host CLI:
 *   kimi [-S <session>] [-m <model>] -p "prompt" --output-format text
 *
 * Prefer smaller models (k3-256k) + paced starts — Kimi's rolling 5h window
 * is the scarce resource. Never auto --continue.
 */
export class KimiAdapter implements AgentAdapter {
  readonly kind = "kimi" as const;
  readonly acceptsLiveFollowup = false;

  plan(ctx: AdapterContext): AdapterPlan {
    const resume = ctx.job.session_id;
    const prompt =
      ctx.followupMessages.length > 0
        ? `${ctx.job.prompt}\n\nFollow-up instructions:\n${ctx.followupMessages.join("\n")}`
        : ctx.job.prompt;

    const binary = ctx.binary ?? "kimi";
    const args = [] as string[];
    if (resume) {
      args.push("--session", resume);
    }
    if (ctx.model) {
      args.push("-m", ctx.model);
    }
    args.push("-p", prompt, "--output-format", "text");

    const parseSessionId = (stdout: string) => {
      const m = stdout.match(
        /\bsession(?:Id|_id)?["']?\s*[:=]\s*["']?([a-zA-Z0-9_-]+)/i,
      );
      return m?.[1] ?? resume;
    };
    const summarize = (stdout: string) =>
      stdout.trim().slice(-800) || "kimi finished";

    if (ctx.execution === "host") {
      return {
        kind: "kimi",
        execution: "host",
        liveWorkspace: true,
        hostSpec: {
          command: binary,
          args,
          cwd: ctx.workPath,
          env: { JOB_ID: ctx.job.id },
          timeoutSec: ctx.timeoutSec,
          name: `kimi-${ctx.job.id.slice(0, 8)}`,
        },
        parseSessionId,
        summarize,
      };
    }

    return {
      kind: "kimi",
      execution: "docker",
      runSpec: {
        image: ctx.isolationImage,
        command: [binary, ...args],
        workdir: "/work",
        env: {
          JOB_ID: ctx.job.id,
          KIMI_CODE_HOME: "/tmp/kimi-home",
        },
        mounts: [
          { hostPath: ctx.workPath, containerPath: "/work", readOnly: false },
        ],
        network: ctx.network === "none" ? "none" : ctx.network,
        runAsUser: ctx.runAsUser,
        readOnlyRootfs: ctx.readOnlyRootfs,
        memoryMb: ctx.memoryMb,
        cpus: ctx.cpus,
        name: `ac-kimi-${ctx.job.id.slice(0, 8)}`,
        timeoutSec: ctx.timeoutSec,
      },
      parseSessionId,
      summarize,
    };
  }
}
