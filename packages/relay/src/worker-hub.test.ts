import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import {
  DUPLICATE_WORKER_CLOSE_CODE,
  DUPLICATE_WORKER_CLOSE_REASON,
  WorkerHub,
} from "./worker-hub.js";

class MockWebSocket extends EventEmitter {
  readyState = 1;
  sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.emit("close", code, reason);
  }
}

function asWs(mock: MockWebSocket): WebSocket {
  return mock as unknown as WebSocket;
}

describe("WorkerHub.attach", () => {
  it("rejects a duplicate while the active socket is healthy", () => {
    const hub = new WorkerHub();
    const primary = new MockWebSocket();
    const duplicate = new MockWebSocket();
    const closeSpy = vi.spyOn(duplicate, "close");

    expect(hub.attach(asWs(primary), "worker-a")).toBe("attached");
    expect(hub.status().connected).toBe(true);

    expect(hub.attach(asWs(duplicate), "worker-b")).toBe("rejected_duplicate");
    expect(closeSpy).toHaveBeenCalledWith(
      DUPLICATE_WORKER_CLOSE_CODE,
      DUPLICATE_WORKER_CLOSE_REASON,
    );
    expect(hub.status().worker_id).toBe("worker-a");
    expect(hub.status().connected).toBe(true);

    duplicate.emit("close");
    expect(hub.status().connected).toBe(true);
    expect(hub.status().worker_id).toBe("worker-a");
  });

  it("allows reconnect after the active socket closes", () => {
    const hub = new WorkerHub();
    const first = new MockWebSocket();
    const second = new MockWebSocket();

    hub.attach(asWs(first), "worker-a");
    first.close();
    expect(hub.status().connected).toBe(false);

    expect(hub.attach(asWs(second), "worker-b")).toBe("attached");
    expect(hub.status()).toEqual({ connected: true, worker_id: "worker-b" });
  });

  it("replaces an unhealthy socket with a new connection", () => {
    const hub = new WorkerHub();
    const stale = new MockWebSocket();
    hub.attach(asWs(stale), "worker-old");
    stale.readyState = 3;

    const fresh = new MockWebSocket();
    expect(hub.attach(asWs(fresh), "worker-new")).toBe("attached");
    expect(hub.status().worker_id).toBe("worker-new");
  });
});
