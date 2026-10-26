import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { RelayToWorkerMessage, WorkerMessage } from "@agent-control/shared";
import type { WorkerService } from "./service.js";
import { AuthError } from "./db.js";

const RELAY_BACKOFF_MIN_MS = 1000;
const RELAY_BACKOFF_MAX_MS = 30_000;

/** Exponential backoff after relay disconnect (used by RelayClient). */
export function nextRelayReconnectBackoffMs(currentMs: number): number {
  if (currentMs < RELAY_BACKOFF_MIN_MS) return RELAY_BACKOFF_MIN_MS;
  return Math.min(currentMs * 2, RELAY_BACKOFF_MAX_MS);
}

/**
 * Outbound WebSocket client: Mac worker dials the relay (no inbound ports required).
 */
export class RelayClient {
  private ws: WebSocket | null = null;
  private stopped = false;
  private readonly workerId = randomUUID();
  private backoffMs = RELAY_BACKOFF_MIN_MS;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly relayUrl: string,
    private readonly workerToken: string,
    private readonly service: WorkerService,
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.relayUrl);
    this.ws = ws;

    ws.on("open", () => {
      this.backoffMs = RELAY_BACKOFF_MIN_MS;
      const hello: WorkerMessage = {
        type: "hello",
        worker_id: this.workerId,
        token: this.workerToken,
      };
      ws.send(JSON.stringify(hello));
      if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = setInterval(() => {
        if (!this.ws || this.ws.readyState !== 1) return;
        const hb: WorkerMessage = { type: "heartbeat", worker_id: this.workerId };
        this.ws.send(JSON.stringify(hb));
      }, 25_000);
      console.log(`[worker] connected to relay ${this.relayUrl}`);
    });

    ws.on("message", (raw) => {
      void this.onMessage(String(raw));
    });

    ws.on("close", () => {
      this.ws = null;
      if (this.keepAliveTimer) {
        clearInterval(this.keepAliveTimer);
        this.keepAliveTimer = null;
      }
      if (this.stopped) return;
      console.error(`[worker] relay disconnected; retry in ${this.backoffMs}ms`);
      setTimeout(() => this.connect(), this.backoffMs);
      this.backoffMs = nextRelayReconnectBackoffMs(this.backoffMs);
    });

    ws.on("error", (err) => {
      console.error("[worker] relay socket error", err.message);
    });
  }

  private async onMessage(raw: string): Promise<void> {
    let msg: RelayToWorkerMessage;
    try {
      msg = JSON.parse(raw) as RelayToWorkerMessage;
    } catch {
      return;
    }
    if (msg.type === "ping") {
      const hb: WorkerMessage = { type: "heartbeat", worker_id: this.workerId };
      this.ws?.send(JSON.stringify(hb));
      return;
    }
    if (msg.type !== "request") return;

    try {
      const result = await this.dispatch(msg);
      const ack: WorkerMessage = {
        type: "ack",
        request_id: msg.request_id,
        ok: true,
        result,
      };
      this.ws?.send(JSON.stringify(ack));
    } catch (err) {
      const ack: WorkerMessage = {
        type: "ack",
        request_id: msg.request_id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
      this.ws?.send(JSON.stringify(ack));
    }
  }

  private async dispatch(msg: Extract<RelayToWorkerMessage, { type: "request" }>) {
    const ownerId = msg.owner_id;
    switch (msg.method) {
      case "list_projects":
        return this.service.listProjects(ownerId);
      case "list_tasks":
        return this.service.listTasks(
          ownerId,
          msg.params.limit ? Number(msg.params.limit) : 30,
        );
      case "start_task":
        return this.service.startTask({
          ownerId,
          projectId: msg.params.projectId
            ? String(msg.params.projectId)
            : undefined,
          workspace: msg.params.workspace
            ? String(msg.params.workspace)
            : undefined,
          agent: msg.params.agent as "mock" | "cursor" | "kimi",
          prompt: String(msg.params.prompt ?? ""),
          idempotencyKey: msg.params.idempotencyKey
            ? String(msg.params.idempotencyKey)
            : undefined,
          timeoutSec: msg.params.timeoutSec
            ? Number(msg.params.timeoutSec)
            : undefined,
          tier: msg.params.tier
            ? (String(msg.params.tier) as
                | "research"
                | "triage"
                | "implement"
                | "bugfix"
                | "default")
            : undefined,
          model: msg.params.model ? String(msg.params.model) : undefined,
        });
      case "get_task":
        return this.service.getTask(ownerId, String(msg.params.jobId ?? ""));
      case "get_task_output":
        return this.service.getTaskOutput(ownerId, String(msg.params.jobId ?? ""));
      case "send_followup":
        return this.service.sendFollowup(
          ownerId,
          String(msg.params.jobId ?? ""),
          String(msg.params.message ?? ""),
        );
      case "cancel_task":
        return this.service.cancelTask(ownerId, String(msg.params.jobId ?? ""));
      case "create_terminal_session":
        return this.service.createTerminalSession({
          ownerId,
          kind: String(msg.params.kind ?? "shell") as "shell" | "cursor" | "kimi",
          workspace: String(msg.params.workspace ?? ""),
          model: msg.params.model ? String(msg.params.model) : undefined,
          cols: msg.params.cols != null ? Number(msg.params.cols) : undefined,
          rows: msg.params.rows != null ? Number(msg.params.rows) : undefined,
          idleSec:
            msg.params.idleSec === null
              ? null
              : msg.params.idleSec != null
                ? Number(msg.params.idleSec)
                : undefined,
        });
      case "list_terminal_sessions":
        return this.service.listTerminalSessions(ownerId);
      case "get_terminal_session":
        return this.service.getTerminalSession(
          ownerId,
          String(msg.params.sessionId ?? ""),
        );
      case "read_terminal_output":
        return this.service.readTerminalOutput(
          ownerId,
          String(msg.params.sessionId ?? ""),
          {
            offset:
              msg.params.offset != null ? Number(msg.params.offset) : undefined,
            maxBytes:
              msg.params.maxBytes != null
                ? Number(msg.params.maxBytes)
                : undefined,
          },
        );
      case "write_terminal_input":
        return this.service.writeTerminalInput(
          ownerId,
          String(msg.params.sessionId ?? ""),
          {
            data: msg.params.data != null ? String(msg.params.data) : undefined,
            keys: Array.isArray(msg.params.keys)
              ? msg.params.keys.map(String)
              : undefined,
            submit: Boolean(msg.params.submit),
          },
        );
      case "resize_terminal_session":
        return this.service.resizeTerminalSession(
          ownerId,
          String(msg.params.sessionId ?? ""),
          Number(msg.params.cols ?? 120),
          Number(msg.params.rows ?? 40),
        );
      case "interrupt_terminal_session":
        return this.service.interruptTerminalSession(
          ownerId,
          String(msg.params.sessionId ?? ""),
        );
      case "close_terminal_session":
        return this.service.closeTerminalSession(
          ownerId,
          String(msg.params.sessionId ?? ""),
        );
      case "terminal_capabilities":
        return this.service.terminalCapabilities(ownerId);
      case "get_situation":
        return this.service.getSituation(ownerId, {
          tail_bytes:
            msg.params.tail_bytes != null
              ? Number(msg.params.tail_bytes)
              : undefined,
          task_limit:
            msg.params.task_limit != null
              ? Number(msg.params.task_limit)
              : undefined,
        });
      case "request_local_approval":
        return this.service.requestLocalApproval({
          ownerId,
          kind: String(msg.params.kind ?? "general") as
            | "browser_open"
            | "permission"
            | "general"
            | "destructive",
          title: String(msg.params.title ?? "Approval required"),
          detail: String(msg.params.detail ?? ""),
          payload:
            msg.params.payload && typeof msg.params.payload === "object"
              ? (msg.params.payload as Record<string, unknown>)
              : undefined,
          timeoutSec:
            msg.params.timeoutSec != null
              ? Number(msg.params.timeoutSec)
              : undefined,
          wait:
            msg.params.wait === undefined
              ? undefined
              : Boolean(msg.params.wait),
        });
      case "list_approvals":
        return this.service.listApprovals(ownerId, {
          includeResolved: Boolean(msg.params.includeResolved),
          limit:
            msg.params.limit != null ? Number(msg.params.limit) : undefined,
        });
      case "get_approval":
        return this.service.getApproval(
          ownerId,
          String(msg.params.approvalId ?? ""),
        );
      case "resolve_approval":
        return this.service.resolveApproval(
          ownerId,
          String(msg.params.approvalId ?? ""),
          String(msg.params.decision ?? "denied") === "approved"
            ? "approved"
            : "denied",
          msg.params.note != null ? String(msg.params.note) : undefined,
        );
      case "notify_owner":
        return this.service.notifyOwner(
          ownerId,
          String(msg.params.title ?? "Ground Control"),
          String(msg.params.body ?? ""),
        );
      case "open_url":
        return this.service.openUrl(ownerId, String(msg.params.url ?? ""), {
          requireApproval:
            msg.params.requireApproval === undefined
              ? undefined
              : Boolean(msg.params.requireApproval),
          title: msg.params.title != null ? String(msg.params.title) : undefined,
          wait:
            msg.params.wait === undefined
              ? undefined
              : Boolean(msg.params.wait),
        });
      case "create_mission":
        return this.service.createMission({
          ownerId,
          title: String(msg.params.title ?? ""),
          goal: String(msg.params.goal ?? ""),
          workspace: msg.params.workspace
            ? String(msg.params.workspace)
            : undefined,
          markers:
            msg.params.markers && typeof msg.params.markers === "object"
              ? (msg.params.markers as Record<
                  string,
                  string | number | boolean | null
                >)
              : undefined,
        });
      case "list_missions":
        return this.service.listMissions(ownerId, {
          status: msg.params.status
            ? (String(msg.params.status) as
                | "intake"
                | "researching"
                | "plan_ready"
                | "approved"
                | "implementing"
                | "verifying"
                | "done"
                | "blocked"
                | "cancelled")
            : undefined,
          limit:
            msg.params.limit != null ? Number(msg.params.limit) : undefined,
        });
      case "get_mission":
        return this.service.getMission(
          ownerId,
          String(msg.params.missionId ?? ""),
        );
      case "update_mission":
        return this.service.updateMission(
          ownerId,
          String(msg.params.missionId ?? ""),
          {
            title: msg.params.title != null ? String(msg.params.title) : undefined,
            goal: msg.params.goal != null ? String(msg.params.goal) : undefined,
            workspace:
              msg.params.workspace === null
                ? null
                : msg.params.workspace != null
                  ? String(msg.params.workspace)
                  : undefined,
            status: msg.params.status
              ? (String(msg.params.status) as
                  | "intake"
                  | "researching"
                  | "plan_ready"
                  | "approved"
                  | "implementing"
                  | "verifying"
                  | "done"
                  | "blocked"
                  | "cancelled")
              : undefined,
            plan:
              msg.params.plan === null
                ? null
                : msg.params.plan != null
                  ? String(msg.params.plan)
                  : undefined,
            findings:
              msg.params.findings === null
                ? null
                : msg.params.findings != null
                  ? String(msg.params.findings)
                  : undefined,
            summary:
              msg.params.summary === null
                ? null
                : msg.params.summary != null
                  ? String(msg.params.summary)
                  : undefined,
            markers:
              msg.params.markers && typeof msg.params.markers === "object"
                ? (msg.params.markers as Record<
                    string,
                    string | number | boolean | null
                  >)
                : undefined,
            linkJobId: msg.params.linkJobId
              ? String(msg.params.linkJobId)
              : undefined,
            linkSessionId: msg.params.linkSessionId
              ? String(msg.params.linkSessionId)
              : undefined,
          },
        );
      case "approve_mission":
        return this.service.approveMission(
          ownerId,
          String(msg.params.missionId ?? ""),
          {
            requireDialog:
              msg.params.requireDialog === undefined
                ? undefined
                : Boolean(msg.params.requireDialog),
            note: msg.params.note != null ? String(msg.params.note) : undefined,
            authorization:
              msg.params.authorization === "chat_explicit" ||
              msg.params.authorization === "local_dialog"
                ? msg.params.authorization
                : undefined,
            approvedScope:
              msg.params.approvedScope != null
                ? String(msg.params.approvedScope)
                : undefined,
          },
        );
      case "complete_mission":
        return this.service.completeMission(
          ownerId,
          String(msg.params.missionId ?? ""),
          {
            summary: String(msg.params.summary ?? ""),
            markers:
              msg.params.markers && typeof msg.params.markers === "object"
                ? (msg.params.markers as Record<
                    string,
                    string | number | boolean | null
                  >)
                : undefined,
            notify:
              msg.params.notify === undefined
                ? undefined
                : Boolean(msg.params.notify),
          },
        );
      case "get_usage":
        return this.service.getUsage(ownerId);
      case "list_events":
        return this.service.listEvents(ownerId, {
          limit:
            msg.params.limit != null ? Number(msg.params.limit) : undefined,
          since:
            msg.params.since != null ? String(msg.params.since) : undefined,
          source:
            msg.params.source != null ? String(msg.params.source) : undefined,
          verb: msg.params.verb != null ? String(msg.params.verb) : undefined,
          includePrivate: Boolean(msg.params.includePrivate),
        });
      case "rebuild_events":
        return this.service.rebuildEvents(ownerId);
      case "ingest_client_request":
        return this.service.ingestClientRequest({
          ownerId,
          client: String(msg.params.client ?? ""),
          subject: String(msg.params.subject ?? ""),
          body: String(msg.params.body ?? ""),
          fromEmail: msg.params.fromEmail
            ? String(msg.params.fromEmail)
            : undefined,
        });
      case "list_client_requests":
        return this.service.listClientRequests(ownerId, {
          clientId: msg.params.clientId
            ? String(msg.params.clientId)
            : undefined,
          status: msg.params.status
            ? (String(msg.params.status) as
                | "queued"
                | "in_progress"
                | "done"
                | "deferred"
                | "cancelled")
            : undefined,
          limit:
            msg.params.limit != null ? Number(msg.params.limit) : undefined,
        });
      case "draft_client_update":
        return this.service.draftClientUpdate({
          ownerId,
          client: String(msg.params.client ?? ""),
          sinceIso: msg.params.sinceIso
            ? String(msg.params.sinceIso)
            : undefined,
        });
      case "run_next_bugfix":
        return this.service.runNextBugfix(ownerId);
      case "list_meaning_candidates":
        // Owner-only path (relay gates on the board key); private included.
        return this.service.listMeaningCandidates(ownerId, {
          kind: msg.params.kind
            ? (String(msg.params.kind) as
                | "capability"
                | "turning_point"
                | "chapter"
                | "badge")
            : undefined,
          status: msg.params.status
            ? (String(msg.params.status) as
                | "proposed"
                | "accepted"
                | "dismissed"
                | "corrected"
                | "superseded")
            : undefined,
          includePrivate: true,
        });
      case "get_meaning_candidate":
        return this.service.getMeaningCandidate(
          ownerId,
          String(msg.params.id ?? ""),
          { includePrivate: true },
        );
      case "meaning_summary":
        return this.service.meaningSummary(ownerId, { includePrivate: true });
      case "decide_meaning_candidate":
        return this.service.decideMeaningCandidate({
          ownerId,
          candidateId: String(msg.params.id ?? ""),
          decision: String(msg.params.action ?? "") as
            | "accept"
            | "dismiss"
            | "correct",
          label: msg.params.label != null ? String(msg.params.label) : undefined,
          note: msg.params.note != null ? String(msg.params.note) : undefined,
        });
      case "get_board":
        return this.service.getBoardSnapshot(ownerId);
      case "world_summary":
        return this.service.worldSummary(ownerId, {
          includePrivate: msg.params.includePrivate === true,
        });
      case "list_world_entities":
        return this.service.listWorldEntities(ownerId, {
          type: msg.params.type ? String(msg.params.type) : undefined,
          state: msg.params.state ? String(msg.params.state) : undefined,
          includePrivate: msg.params.includePrivate === true,
        });
      case "get_world_entity":
        return this.service.getWorldEntity(
          ownerId,
          String(msg.params.id ?? ""),
          { includePrivate: msg.params.includePrivate === true },
        );
      default:
        throw new AuthError(`unknown method`);
    }
  }
}
