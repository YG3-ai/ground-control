import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { WorkerHub } from "./worker-hub.js";
import {
  getMacConnectivity,
  recoverMacServices,
  type LaunchctlExecutor,
} from "./service-recovery.js";

function mockSocket(): WebSocket {
  const handlers = new Map<string, (message: Buffer) => void>();
  return {
    readyState: 1,
    on(event: string, handler: (message: Buffer) => void) {
      handlers.set(event, handler);
      return this;
    },
    close() {},
    send(raw: string) {
      const request = JSON.parse(raw) as { request_id?: string };
      if (request.request_id) {
        handlers.get("message")?.(Buffer.from(JSON.stringify({ type: "ack", request_id: request.request_id, ok: true, result: {} })));
      }
    },
  } as unknown as WebSocket;
}

describe("service-recovery", () => {
  it("getMacConnectivity reports recovery hint when worker socket is down", async () => {
    const hub = new WorkerHub();
    const executor: LaunchctlExecutor = {
      kickstart: vi.fn(async () => ({ ok: true, detail: "kickstart" })),
      print: vi.fn(async () => ({ ok: true, state: "running" })),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        json: async () => url.includes(":8788/")
          ? ({ ok: true, service: "ground-local-control" })
          : ({ worker: { connected: false } }),
      })),
    );

    const snap = await getMacConnectivity({
      repoRoot: "/tmp/agent-control",
      relayPort: 8787,
      publicBaseUrl: "https://example.com",
      ownerId: "owner-test",
      hub,
      launchAgentsDir: "/tmp/LaunchAgents",
      executor,
    });

    expect(snap.worker_socket).toEqual({ connected: false, worker_id: null });
    expect(String(snap.recovery_hint)).toContain("recover_mac_services");
    vi.unstubAllGlobals();
  });

  it("recoverMacServices kicks worker and waits for hub connection", async () => {
    const hub = new WorkerHub();
    vi.spyOn(hub, "request").mockResolvedValue({});
    const kickstart = vi.fn(async (_fq: string, force: boolean) => ({
      ok: true,
      detail: force ? "kickstart -k" : "kickstart",
    }));
    let prints = 0;
    const executor: LaunchctlExecutor = {
      kickstart,
      print: vi.fn(async () => ({ ok: true, pid: ++prints === 1 ? 101 : 202 })),
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        json: async () => url.includes(":8788/")
          ? ({ ok: true, service: "ground-local-control" })
          : ({ worker: { connected: false } }),
      })),
    );

    const sleepMs = vi.fn(async () => {
      hub.attach(mockSocket(), "worker-test");
    });

    const result = await recoverMacServices(
      {
        repoRoot: "/tmp/agent-control",
        relayPort: 8787,
        publicBaseUrl: "https://example.com",
        ownerId: "owner-test",
        hub,
        launchAgentsDir: "/tmp/LaunchAgents",
        executor,
        sleepMs,
      },
      { scope: "worker", wait_for_worker_sec: 5 },
    );

    expect(kickstart).toHaveBeenCalled();
    expect(result.recovered).toBe(true);
    vi.unstubAllGlobals();
  });
});
