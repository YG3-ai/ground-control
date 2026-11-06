import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { WorkerHub } from "./worker-hub.js";

const execFileAsync = promisify(execFile);

export type RecoveryScope = "worker" | "relay_and_worker" | "full_stack";

export type LaunchAgentLabel =
  | "com.groundcontrol.relay"
  | "com.groundcontrol.worker"
  | "com.groundcontrol.cloudflared"
  | "com.groundcontrol.ngrok";

export type LaunchctlExecutor = {
  kickstart: (fqLabel: string, forceKill: boolean) => Promise<{ ok: boolean; detail: string }>;
  print: (fqLabel: string) => Promise<{ ok: boolean; state?: string; pid?: number }>;
};

export type ServiceRecoveryContext = {
  repoRoot: string;
  relayPort: number;
  publicBaseUrl: string;
  ownerId: string;
  hub: WorkerHub;
  workerLocalControlPort?: number;
  launchAgentsDir?: string;
  executor?: LaunchctlExecutor;
  sleepMs?: (ms: number) => Promise<void>;
};

function guiDomain(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

export function defaultLaunchctlExecutor(): LaunchctlExecutor {
  return {
    async kickstart(fqLabel, forceKill) {
      const args = forceKill
        ? ["kickstart", "-k", fqLabel]
        : ["kickstart", fqLabel];
      try {
        await execFileAsync("launchctl", args, { timeout: 20_000 });
        return { ok: true, detail: args.join(" ") };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, detail: msg };
      }
    },
    async print(fqLabel) {
      try {
        const { stdout } = await execFileAsync("launchctl", ["print", fqLabel], {
          timeout: 10_000,
        });
        const m = stdout.match(/^\s*state = (.+)$/m);
        const pid = Number(stdout.match(/^\s*pid = (\d+)$/m)?.[1]);
        return { ok: true, state: m?.[1]?.trim(), pid: Number.isSafeInteger(pid) && pid > 0 ? pid : undefined };
      } catch {
        return { ok: false };
      }
    },
  };
}

function tunnelAgentPlist(launchAgentsDir: string): LaunchAgentLabel | null {
  if (existsSync(join(launchAgentsDir, "com.groundcontrol.cloudflared.plist"))) {
    return "com.groundcontrol.cloudflared";
  }
  if (existsSync(join(launchAgentsDir, "com.groundcontrol.ngrok.plist"))) {
    return "com.groundcontrol.ngrok";
  }
  return null;
}

async function kickAgent(
  executor: LaunchctlExecutor,
  label: LaunchAgentLabel,
  forceKill: boolean,
): Promise<{ label: LaunchAgentLabel; ok: boolean; detail: string }> {
  const fq = `${guiDomain()}/${label}`;
  const first = await executor.kickstart(fq, forceKill);
  if (first.ok) {
    return { label, ok: true, detail: first.detail };
  }
  return { label, ok: false, detail: first.detail };
}

export async function fetchLocalHealthz(
  port: number,
): Promise<{ ok: boolean; worker_connected: boolean; raw?: unknown }> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      return { ok: false, worker_connected: false };
    }
    const raw = (await res.json()) as {
      worker?: { connected?: boolean };
    };
    return {
      ok: true,
      worker_connected: Boolean(raw.worker?.connected),
      raw,
    };
  } catch {
    return { ok: false, worker_connected: false };
  }
}

export async function fetchWorkerLocalControl(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean; service?: string };
    return body.ok === true && body.service === "ground-local-control";
  } catch {
    return false;
  }
}

export async function getMacConnectivity(
  ctx: ServiceRecoveryContext,
): Promise<Record<string, unknown>> {
  const executor = ctx.executor ?? defaultLaunchctlExecutor();
  const launchAgentsDir =
    ctx.launchAgentsDir ?? join(process.env.HOME ?? "", "Library", "LaunchAgents");
  const domain = guiDomain();
  const labels: LaunchAgentLabel[] = [
    "com.groundcontrol.relay",
    "com.groundcontrol.worker",
  ];
  const tunnel = tunnelAgentPlist(launchAgentsDir);
  if (tunnel) labels.push(tunnel);

  const launch_agents: Record<string, { loaded: boolean; state?: string }> = {};
  for (const label of labels) {
    const fq = `${domain}/${label}`;
    const info = await executor.print(fq);
    launch_agents[label] = { loaded: info.ok, state: info.state };
  }

  const health = await fetchLocalHealthz(ctx.relayPort);
  const worker_local_control = await fetchWorkerLocalControl(ctx.workerLocalControlPort ?? 8788);
  const socket = ctx.hub.status();
  const disconnected = !socket.connected;

  return {
    worker_socket: socket,
    local_healthz: health.ok
      ? { ok: true, worker_connected: health.worker_connected }
      : { ok: false, error: "healthz_unreachable" },
    worker_local_control: { ok: worker_local_control, port: ctx.workerLocalControlPort ?? 8788 },
    launch_agents,
    public_base_url: ctx.publicBaseUrl,
    recovery_hint: disconnected
      ? "Worker WebSocket is down. Call recover_mac_services with scope=worker (safe while ChatGPT MCP is connected). Avoid scope=relay_and_worker unless the relay itself is broken — restarting relay drops this MCP session."
      : "Worker is connected. Use normal tools (get_situation, start_task, …).",
  };
}

export async function recoverMacServices(
  ctx: ServiceRecoveryContext,
  input: {
    scope?: RecoveryScope;
    wait_for_worker_sec?: number;
  },
): Promise<Record<string, unknown>> {
  const scope = input.scope ?? "worker";
  const waitSec = Math.min(Math.max(input.wait_for_worker_sec ?? 45, 5), 120);
  const executor = ctx.executor ?? defaultLaunchctlExecutor();
  const sleep = ctx.sleepMs ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const launchAgentsDir =
    ctx.launchAgentsDir ?? join(process.env.HOME ?? "", "Library", "LaunchAgents");
  const domain = guiDomain();
  const actions: Array<{ label: LaunchAgentLabel; ok: boolean; detail: string }> = [];

  const healthBefore = await fetchLocalHealthz(ctx.relayPort);
  const wasConnected = ctx.hub.connected;
  const workerLabel: LaunchAgentLabel = "com.groundcontrol.worker";
  const workerFq = `${domain}/${workerLabel}`;
  const workerPidBefore = (await executor.print(workerFq)).pid;

  async function ensurePlistsStaged(): Promise<void> {
    try {
      await execFileAsync(
        process.execPath,
        [
          join(ctx.repoRoot, "scripts/groundcontrol-launchagents.mjs"),
          "--stage",
          "--root",
          ctx.repoRoot,
          "--launch-agents-dir",
          launchAgentsDir,
          "--domain",
          domain,
          "--bootstrap-missing",
        ],
        { timeout: 30_000, cwd: ctx.repoRoot },
      );
    } catch (err) {
      actions.push({
        label: "com.groundcontrol.worker",
        ok: false,
        detail: `stage_plists: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  await ensurePlistsStaged();

  if (scope === "relay_and_worker" || scope === "full_stack") {
    const relayForce = healthBefore.ok ? 0 : 1;
    actions.push(
      await kickAgent(
        executor,
        "com.groundcontrol.relay",
        relayForce === 1,
      ),
    );
    for (let i = 0; i < 30; i++) {
      const h = await fetchLocalHealthz(ctx.relayPort);
      if (h.ok) break;
      await sleep(1000);
    }
  }

  if (scope === "full_stack") {
    const tunnel = tunnelAgentPlist(launchAgentsDir);
    if (tunnel) {
      actions.push(await kickAgent(executor, tunnel, false));
    }
  }

  if (scope === "worker" || scope === "relay_and_worker" || scope === "full_stack") {
    actions.push(
      await kickAgent(
        executor,
        workerLabel,
        // A recovery must create a fresh worker rather than accepting a stale
        // launchd process that happens to still be marked running.
        true,
      ),
    );
  }

  const deadline = Date.now() + waitSec * 1000;
  let workerPidAfter: number | undefined;
  let rpcOk = false;
  let rpcError: string | undefined;
  let localControlOk = false;
  while (Date.now() < deadline) {
    workerPidAfter = (await executor.print(workerFq)).pid;
    const freshPid = workerPidBefore == null || (workerPidAfter != null && workerPidAfter !== workerPidBefore);
    localControlOk = await fetchWorkerLocalControl(ctx.workerLocalControlPort ?? 8788);
    if (ctx.hub.connected && freshPid && localControlOk) {
      try {
        await ctx.hub.request("get_situation", {}, ctx.ownerId, 8000);
        rpcOk = true;
        break;
      } catch (err) {
        rpcError = err instanceof Error ? err.message : String(err);
      }
    }
    await sleep(1000);
  }

  const after = await getMacConnectivity(ctx);
  return {
    scope,
    wait_for_worker_sec: waitSec,
    was_connected_before: wasConnected,
    worker_pid_before: workerPidBefore ?? null,
    worker_pid_after: workerPidAfter ?? null,
    worker_pid_changed: workerPidBefore == null || (workerPidAfter != null && workerPidAfter !== workerPidBefore),
    worker_rpc: rpcOk ? { ok: true, method: "get_situation" } : { ok: false, error: rpcError ?? "not_verified" },
    worker_local_control: { ok: localControlOk, port: ctx.workerLocalControlPort ?? 8788 },
    actions,
    ...after,
    recovered: ctx.hub.connected && (workerPidBefore == null || (workerPidAfter != null && workerPidAfter !== workerPidBefore)) && localControlOk && rpcOk,
  };
}
