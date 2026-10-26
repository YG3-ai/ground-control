import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type { RelayToWorkerMessage, WorkerMessage } from "@agent-control/shared";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

/**
 * Tracks the Mac worker's outbound WebSocket and multiplexes MCP tool RPCs.
 */
export class WorkerHub {
  private socket: WebSocket | null = null;
  private workerId: string | null = null;
  private readonly pending = new Map<string, Pending>();

  get connected(): boolean {
    return this.socket != null && this.socket.readyState === 1;
  }

  attach(ws: WebSocket, workerId: string): void {
    if (this.socket && this.socket !== ws) {
      try {
        this.socket.close(4000, "replaced by new worker connection");
      } catch {
        // ignore
      }
    }
    this.socket = ws;
    this.workerId = workerId;
    ws.on("close", () => {
      if (this.socket === ws) {
        this.socket = null;
        this.workerId = null;
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error("worker disconnected"));
          this.pending.delete(id);
        }
      }
    });
  }

  handleWorkerMessage(msg: WorkerMessage): void {
    if (msg.type === "ack") {
      const p = this.pending.get(msg.request_id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.request_id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error));
    }
  }

  request<T = unknown>(
    method: Extract<RelayToWorkerMessage, { type: "request" }>["method"],
    params: Record<string, unknown>,
    ownerId: string,
    timeoutMs = 30_000,
  ): Promise<T> {
    if (!this.socket || this.socket.readyState !== 1) {
      return Promise.reject(new Error("Mac worker is not connected"));
    }
    const request_id = randomUUID();
    const payload: RelayToWorkerMessage = {
      type: "request",
      request_id,
      method,
      params,
      owner_id: ownerId,
    };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request_id);
        reject(new Error(`worker RPC timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(request_id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
      });
      this.socket!.send(JSON.stringify(payload));
    });
  }

  status(): { connected: boolean; worker_id: string | null } {
    return { connected: this.connected, worker_id: this.workerId };
  }
}
