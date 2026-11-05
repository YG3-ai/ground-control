import type { AgentAdapter, AdapterContext, AdapterPlan } from "./types.js";

type CodexEvent = {
  type?: string;
  thread_id?: string;
  item?: { type?: string; text?: string };
};

function parseEvents(stdout: string): CodexEvent[] {
  const events: CodexEvent[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as CodexEvent);
    } catch {
      // Keep the adapter tolerant of diagnostics mixed into older CLI output.
    }
  }
  return events;
}

/** Codex CLI adapter using the documented non-interactive JSONL interface. */
export class CodexAdapter implements AgentAdapter {
  readonly kind = "codex" as const;
  readonly acceptsLiveFollowup = false;

  plan(ctx: AdapterContext): AdapterPlan {
    const binary = ctx.binary ?? "codex";
    const sandbox =
      ctx.tier === "research" || ctx.tier === "triage"
        ? "read-only"
        : "workspace-write";
    const args = ["exec", "--json", "--sandbox", sandbox];
    if (ctx.model) args.push("--model", ctx.model);

    const resume = ctx.job.session_id;
    const followup = ctx.followupMessages.join("\n");
    if (resume && followup) {
      args.push("resume", resume, followup);
    } else {
      const prompt = followup
        ? `${ctx.job.prompt}\n\nFollow-up instructions:\n${followup}`
        : ctx.job.prompt;
      args.push(prompt);
    }

    const parseSessionId = (stdout: string) =>
      parseEvents(stdout).find((event) => event.type === "thread.started")
        ?.thread_id ?? resume;
    const summarize = (stdout: string) => {
      const messages = parseEvents(stdout)
        .filter(
          (event) =>
            event.type === "item.completed" &&
            event.item?.type === "agent_message" &&
            typeof event.item.text === "string",
        )
        .map((event) => event.item!.text!);
      return messages.at(-1)?.slice(-800) ?? "codex finished";
    };

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
