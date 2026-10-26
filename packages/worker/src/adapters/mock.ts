import type { AgentAdapter, AdapterContext, AdapterPlan } from "./types.js";

/** Mock agent — Docker-only isolation probe. */
export class MockAdapter implements AgentAdapter {
  readonly kind = "mock" as const;
  readonly acceptsLiveFollowup = false;

  plan(ctx: AdapterContext): AdapterPlan {
    const followups = ctx.followupMessages.join("\n");
    const script = `set -e
cd /work
echo "mock-agent: start"
echo "PROMPT<<EOF"
printf '%s\\n' "$PROMPT"
echo "EOF"
if [ -n "$FOLLOWUPS" ]; then
  echo "FOLLOWUPS<<EOF"
  printf '%s\\n' "$FOLLOWUPS"
  echo "EOF"
fi
echo "mock-edited $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> hello.txt 2>/dev/null || echo "mock-edited" >> README.md
if [ -e /host-sentinel ]; then
  echo "SECURITY_FAIL: host sentinel visible"
  exit 97
fi
echo "mock-agent: isolation-ok"
echo "SUMMARY: mock completed successfully"
`;

    return {
      kind: "mock",
      execution: "docker",
      runSpec: {
        image: ctx.isolationImage,
        command: ["sh", "-c", script],
        workdir: "/work",
        env: {
          PROMPT: ctx.job.prompt,
          FOLLOWUPS: followups,
          JOB_ID: ctx.job.id,
          AGENT: "mock",
        },
        mounts: [
          {
            hostPath: ctx.workPath,
            containerPath: "/work",
            readOnly: false,
          },
        ],
        network: ctx.network,
        runAsUser: ctx.runAsUser,
        readOnlyRootfs: ctx.readOnlyRootfs,
        memoryMb: ctx.memoryMb,
        cpus: ctx.cpus,
        name: `ac-mock-${ctx.job.id.slice(0, 8)}`,
        timeoutSec: ctx.timeoutSec,
      },
      parseSessionId: () => `mock-session-${ctx.job.id.slice(0, 8)}`,
      summarize: (stdout) => {
        const m = stdout.match(/SUMMARY:\s*(.+)/);
        return m?.[1]?.trim() ?? "mock finished";
      },
    };
  }
}
