import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import type { Server } from "node:http";
import { join, resolve } from "node:path";
import {
  type AppConfig,
  type AgentKind,
  type StartTaskInput,
  type TaskOutputView,
  type TaskView,
  REDACTION_DISCLAIMER,
  boundOutput,
  getProject,
  isAgentAllowed,
  isAgentEnabled,
  redactSecrets,
} from "@agent-control/shared";
import { AuthError, JobStore, isTerminal } from "./db.js";
import { getAdapter } from "./adapters/index.js";
import type { AdapterPlan } from "./adapters/types.js";
import {
  DockerIsolationBackend,
  MockFailIsolationBackend,
} from "./isolation/docker.js";
import { HostProcessBackend } from "./isolation/host.js";
import type { IsolationBackend, IsolationHandle } from "./isolation/types.js";
import { cleanupJobWorkspace, prepareJobWorkspace } from "./worktree.js";
import {
  listWorkspaceHints,
  resolveWorkspacePath,
  workspaceLabel,
  WorkspaceError,
} from "./workspace.js";
import { BinaryResolveError, resolveExecutable } from "./binary-resolve.js";
import {
  TerminalSessionManager,
  type SessionKind,
} from "./sessions/manager.js";
import {
  ApprovalManager,
  type ApprovalKind,
} from "./local/approvals.js";
import {
  APPROVAL_SOURCE_CHAT_EXPLICIT,
  APPROVAL_SOURCE_LOCAL_DIALOG,
  hybridRemoteMarkers,
  isMissionWorkspaceScopeExpansion,
  isSensitiveApprovalRequest,
  missionRoutineScopeApproved,
  resolveMissionApprovalMode,
  ROUTINE_APPROVED_SCOPE,
} from "./approval-policy.js";
import { openUrlInBrowser } from "./local/browser.js";
import { startLocalControlServer } from "./local/control-server.js";
import {
  MissionStore,
  MISSION_STATUSES,
  type MissionStatus,
} from "./missions/store.js";
import { buildBoardSystemFocus } from "./board-system-focus.js";
import {
  UsageLedger,
  DEFAULT_CURSOR_POLICY,
  DEFAULT_KIMI_POLICY,
  looksLikeRateLimit,
  resolveModelForTier,
  type AgentUsagePolicy,
  type UsageAgent,
} from "./usage/ledger.js";
import {
  ClientRequestStore,
  resolveClient,
  type ClientDef,
} from "./clients/store.js";
import { EventStore } from "./events/store.js";
import { WorldStore } from "./world/store.js";
import { MeaningStore } from "./meaning/store.js";
import { rebuildMeaning } from "./meaning/engine.js";
import { RULE_CATALOG } from "./meaning/rules.js";
import type {
  CandidateDecisionAction,
  CandidateFilters,
  EvidenceSummary,
} from "./meaning/types.js";
import type { EventSensitivity } from "./events/types.js";
import type { ClientConfig } from "@agent-control/shared";

export class WorkerService {
  readonly store: JobStore;
  readonly config: AppConfig;
  readonly isolation: IsolationBackend;
  readonly hostRunner = new HostProcessBackend();
  readonly sessions: TerminalSessionManager;
  readonly approvals: ApprovalManager;
  readonly missions: MissionStore;
  readonly usage: UsageLedger;
  readonly clientRequests: ClientRequestStore;
  readonly events: EventStore;
  readonly world: WorldStore;
  readonly meaning: MeaningStore;
  private localControl: Server | null = null;
  private readonly active = new Map<
    string,
    {
      handle: IsolationHandle;
      mode: "worktree" | "copy" | "live";
      sourcePath: string;
    }
  >();
  /** Per-job model/tier (not yet columns on jobs table). */
  private readonly jobMeta = new Map<
    string,
    { tier: string; model: string | null; cursorMode: "ask" | "plan" | null }
  >();
  private ticking = false;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  readonly configRoot: string;

  constructor(opts: { config: AppConfig; dbPath: string; configRoot: string }) {
    this.config = opts.config;
    this.configRoot = opts.configRoot;
    this.store = new JobStore(opts.dbPath);
    this.isolation =
      opts.config.worker.isolation.backend === "docker"
        ? new DockerIsolationBackend()
        : new MockFailIsolationBackend();
    const ts = opts.config.worker.terminal_sessions;
    this.sessions = new TerminalSessionManager({
      ownerId: opts.config.owner.id,
      defaultIdleSec: ts?.default_idle_sec ?? 3600,
      defaultCols: ts?.default_cols ?? 120,
      defaultRows: ts?.default_rows ?? 40,
    });
    const lc = opts.config.worker.local_control;
    this.approvals = new ApprovalManager({
      ownerId: opts.config.owner.id,
      dataDir: join(
        resolve(opts.configRoot, opts.config.worker.data_dir),
        "approvals",
      ),
      defaultTimeoutSec: lc?.approval_timeout_sec ?? 120,
    });
    this.missions = new MissionStore(
      join(
        resolve(opts.configRoot, opts.config.worker.data_dir),
        "missions.db",
      ),
    );
    this.usage = new UsageLedger(
      join(resolve(opts.configRoot, opts.config.worker.data_dir), "usage.db"),
    );
    this.clientRequests = new ClientRequestStore(
      join(
        resolve(opts.configRoot, opts.config.worker.data_dir),
        "clients.db",
      ),
    );
    this.events = new EventStore(
      join(resolve(opts.configRoot, opts.config.worker.data_dir), "events.db"),
    );
    this.world = new WorldStore(
      join(resolve(opts.configRoot, opts.config.worker.data_dir), "world.db"),
    );
    this.meaning = new MeaningStore(
      join(resolve(opts.configRoot, opts.config.worker.data_dir), "meaning.db"),
    );
    const sink = this.events.emit.bind(this.events);
    this.store.onEvent = sink;
    this.missions.onEvent = sink;
    this.approvals.onEvent = sink;
    this.usage.onEvent = sink;
    this.clientRequests.onEvent = sink;
    this.sessions.onEvent = sink;

    mkdirSync(this.dataDir, { recursive: true });
    mkdirSync(this.policyDir, { recursive: true });
    mkdirSync(this.jobsRoot, { recursive: true });
  }

  get dataDir(): string {
    return resolve(this.configRoot, this.config.worker.data_dir);
  }

  get policyDir(): string {
    return resolve(this.configRoot, this.config.worker.policy_dir);
  }

  get jobsRoot(): string {
    return join(this.dataDir, "jobs");
  }

  start(): void {
    const recovered = this.store.recoverAfterRestart();
    if (recovered > 0) {
      console.error(`[worker] marked ${recovered} in-flight job(s) failed after restart`);
    }
    this.running = true;
    this.timer = setInterval(() => {
      void this.tick();
    }, 500);
    void this.tick();
    this.startLocalControl();
  }

  private startLocalControl(): void {
    const lc = this.config.worker.local_control;
    // Opt-in via config (config.yaml sets enabled: true for this Mac).
    if (lc?.enabled !== true) return;
    const port = lc.port ?? 8788;
    const bind = lc.bind ?? "127.0.0.1";
    try {
      this.localControl = startLocalControlServer({
        host: bind,
        port,
        approvals: this.approvals,
        ownerId: this.config.owner.id,
        getBoard: () => this.getBoardSnapshot(this.config.owner.id),
        listEvents: (q) => this.listEvents(this.config.owner.id, q),
        listWorldEntities: (q) =>
          this.listWorldEntities(this.config.owner.id, q),
        getWorldEntity: (id, includePrivate) =>
          this.getWorldEntity(this.config.owner.id, id, { includePrivate }),
        worldSummary: (includePrivate) =>
          this.worldSummary(this.config.owner.id, { includePrivate }),
        listMeaningCandidates: (q) =>
          this.listMeaningCandidates(
            this.config.owner.id,
            q as CandidateFilters,
          ),
        getMeaningCandidate: (id, includePrivate) =>
          this.getMeaningCandidate(this.config.owner.id, id, {
            includePrivate,
          }),
        meaningSummary: (includePrivate) =>
          this.meaningSummary(this.config.owner.id, { includePrivate }),
        decideMeaningCandidate: (id, action, body) =>
          action === "accept"
            ? this.acceptMeaningCandidate(this.config.owner.id, id)
            : action === "dismiss"
              ? this.dismissMeaningCandidate(
                  this.config.owner.id,
                  id,
                  body?.note,
                )
              : this.correctMeaningCandidate(this.config.owner.id, id, {
                  label: body?.label,
                  note: body?.note,
                }),
        rebuildMeaning: () => this.rebuildMeaning(this.config.owner.id),
      });
      this.localControl.on("error", (err) => {
        console.error(`[worker] local control error: ${err.message}`);
      });
      console.error(
        `[worker] local control http://${bind}:${port} (menu bar approvals)`,
      );
    } catch (err) {
      console.error(`[worker] local control failed to bind: ${String(err)}`);
    }
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.localControl?.close();
    this.localControl = null;
  }

  close(): void {
    this.stop();
    // Detach first: pty exit callbacks fire asynchronously after disposeAll's
    // kill, and must not emit into stores that are already closed.
    this.sessions.onEvent = undefined;
    this.sessions.disposeAll();
    this.missions.close();
    this.usage.close();
    this.clientRequests.close();
    this.events.close();
    this.world.close();
    this.meaning.close();
    this.store.close();
  }

  private usagePolicy(agent: UsageAgent): AgentUsagePolicy {
    const u = this.config.agents[agent]?.usage;
    const base =
      agent === "kimi" ? DEFAULT_KIMI_POLICY : DEFAULT_CURSOR_POLICY;
    return {
      window_sec: u?.window_sec ?? base.window_sec,
      max_starts_per_window:
        u?.max_starts_per_window ?? base.max_starts_per_window,
      min_gap_sec: u?.min_gap_sec ?? base.min_gap_sec,
      max_concurrent: u?.max_concurrent ?? base.max_concurrent,
      default_model: u?.default_model ?? base.default_model,
      research_model: u?.research_model ?? base.research_model,
      implement_model: u?.implement_model ?? base.implement_model,
      research_mode: u?.research_mode ?? base.research_mode,
      cooldown_after_rate_limit_sec:
        u?.cooldown_after_rate_limit_sec ??
        base.cooldown_after_rate_limit_sec,
    };
  }

  private clientDefs(): ClientDef[] {
    return (this.config.clients ?? []).map((c: ClientConfig) => ({
      id: c.id,
      name: c.name,
      workspace: c.workspace,
      aliases: c.aliases,
      update_to: c.update_to,
    }));
  }

  listEvents(
    ownerId: string,
    opts?: {
      limit?: number;
      since?: string;
      source?: string;
      verb?: string;
      includePrivate?: boolean;
    },
  ) {
    this.assertOwner(ownerId);
    return { events: this.events.list(opts) };
  }

  /** Re-materialize the event spine from source stores (idempotent). */
  rebuildEvents(ownerId: string, opts?: { dryRun?: boolean }) {
    this.assertOwner(ownerId);
    return this.events.rebuildFrom(
      {
        jobs: this.store,
        missions: this.missions,
        approvals: this.approvals,
        usage: this.usage,
        clients: this.clientRequests,
      },
      opts,
    );
  }

  /**
   * Re-materialize the world model from the full event spine (deterministic).
   * Reads private events internally; the store keeps per-fact sensitivity so
   * queries still exclude private data by default.
   */
  rebuildWorld(ownerId: string) {
    this.assertOwner(ownerId);
    return this.world.rebuildFromEvents(this.events.allEvents());
  }

  listWorldEntities(
    ownerId: string,
    opts?: { type?: string; state?: string; includePrivate?: boolean },
  ) {
    this.assertOwner(ownerId);
    return { entities: this.world.listEntities(opts) };
  }

  getWorldEntity(
    ownerId: string,
    entityIdOrAlias: string,
    opts?: { includePrivate?: boolean },
  ) {
    this.assertOwner(ownerId);
    return this.world.getEntity(entityIdOrAlias, opts);
  }

  worldSummary(ownerId: string, opts?: { includePrivate?: boolean }) {
    this.assertOwner(ownerId);
    return this.world.summary(opts);
  }

  // --- Phase 3: meaning engine (interpretation candidates) ---

  listMeaningCandidates(ownerId: string, filters?: CandidateFilters) {
    this.assertOwner(ownerId);
    return { candidates: this.meaning.listCandidates(filters) };
  }

  getMeaningCandidate(
    ownerId: string,
    id: string,
    opts?: { includePrivate?: boolean },
  ) {
    this.assertOwner(ownerId);
    const got = this.meaning.getCandidate(id, opts);
    if (!got) return null;
    const byId = new Map(
      this.events.allEvents().map((e) => [e.event_id, e]),
    );
    const evidence: EvidenceSummary[] = got.candidate.evidence_event_ids
      .map((eid) => byId.get(eid))
      .filter((e): e is NonNullable<typeof e> => e != null)
      .filter((e) => opts?.includePrivate || e.sensitivity !== "private")
      .map((e) => ({
        event_id: e.event_id,
        verb: e.verb,
        occurred_at: e.occurred_at,
        sensitivity: e.sensitivity,
        source: e.source,
        source_ref: e.source_ref,
        object_type: e.object_type,
        object_id: e.object_id,
        from_state: e.from_state,
        to_state: e.to_state,
      }));
    const rule =
      RULE_CATALOG.find(
        (r) =>
          r.rule_id === got.candidate.rule_id &&
          r.rule_version === got.candidate.rule_version,
      ) ?? null;
    return { ...got, evidence, rule };
  }

  meaningSummary(ownerId: string, opts?: { includePrivate?: boolean }) {
    this.assertOwner(ownerId);
    return this.meaning.summary(opts);
  }

  /** Re-derive candidates from the spine; decision overlays persist. */
  rebuildMeaning(ownerId: string) {
    this.assertOwner(ownerId);
    return rebuildMeaning({
      events: this.events.allEvents(),
      store: this.meaning,
    });
  }

  /**
   * Owner decision overlay (accept/dismiss/correct). Durable in meaning.db
   * and mirrored into the event spine as a CONTENT-FREE event — the note text
   * never leaves the overlay table.
   */
  decideMeaningCandidate(input: {
    ownerId: string;
    candidateId: string;
    decision: CandidateDecisionAction;
    label?: string;
    note?: string;
  }) {
    this.assertOwner(input.ownerId);
    const got = this.meaning.getCandidate(input.candidateId, {
      includePrivate: true,
    });
    if (!got) {
      throw new AuthError(`candidate not found: ${input.candidateId}`);
    }
    if (input.decision === "correct" && !input.label && !input.note) {
      throw new AuthError("correct requires a label or a note");
    }
    const decidedAt = new Date().toISOString();
    const decision = this.meaning.applyDecision({
      candidate_id: input.candidateId,
      decision: input.decision,
      corrected_label: input.label ?? null,
      correction_note: input.note ?? null,
      decided_at: decidedAt,
      decided_by: "owner",
    });
    const verb =
      input.decision === "accept"
        ? "candidate.accepted"
        : input.decision === "dismiss"
          ? "candidate.dismissed"
          : "candidate.corrected";
    // Note text stays in the overlay only; a decision carrying a note is at
    // least internal, and private when the candidate itself is private.
    const sensitivity: EventSensitivity = input.note
      ? got.candidate.sensitivity === "private"
        ? "private"
        : "internal"
      : got.candidate.sensitivity;
    this.events.emit({
      source: "meaning",
      sourceRef: input.candidateId,
      actor: "owner",
      verb,
      objectType: "interpretation_candidate",
      objectId: input.candidateId,
      occurredAt: decidedAt,
      evidenceRefs: got.candidate.evidence_event_ids,
      sensitivity,
      dedupeKey: `decision:${input.decision}:${decidedAt}`,
    });
    return {
      decision,
      candidate: this.meaning.getCandidate(input.candidateId, {
        includePrivate: true,
      })!.candidate,
    };
  }

  acceptMeaningCandidate(ownerId: string, id: string) {
    return this.decideMeaningCandidate({
      ownerId,
      candidateId: id,
      decision: "accept",
    });
  }

  dismissMeaningCandidate(ownerId: string, id: string, note?: string) {
    return this.decideMeaningCandidate({
      ownerId,
      candidateId: id,
      decision: "dismiss",
      note,
    });
  }

  correctMeaningCandidate(
    ownerId: string,
    id: string,
    input: { label?: string; note?: string },
  ) {
    return this.decideMeaningCandidate({
      ownerId,
      candidateId: id,
      decision: "correct",
      label: input.label,
      note: input.note,
    });
  }


  getUsage(ownerId: string) {
    this.assertOwner(ownerId);
    const cursorInFlight = this.store
      .listRecent(ownerId, 50)
      .filter(
        (j) =>
          j.agent === "cursor" &&
          (j.status === "queued" ||
            j.status === "preparing" ||
            j.status === "running" ||
            j.status === "awaiting_followup"),
      ).length;
    const kimiInFlight = this.store
      .listRecent(ownerId, 50)
      .filter(
        (j) =>
          j.agent === "kimi" &&
          (j.status === "queued" ||
            j.status === "preparing" ||
            j.status === "running" ||
            j.status === "awaiting_followup"),
      ).length;
    const cursor = this.usage.snapshot("cursor", this.usagePolicy("cursor"));
    const kimi = this.usage.snapshot("kimi", this.usagePolicy("kimi"));
    return {
      at: new Date().toISOString(),
      cursor: { ...cursor, in_flight: cursorInFlight },
      kimi: {
        ...kimi,
        in_flight: kimiInFlight,
        note: "Kimi Code uses a rolling ~5h usage window. Ground Control paces starts (max_starts_per_window + min_gap) so you do not burn it in one burst. Prefer bugfix batches over chatty loops; resume sessions when possible.",
      },
      clients: this.clientDefs().map((c) => c.id),
      queued_bugfixes: this.clientRequests.list(ownerId, {
        status: "queued",
        limit: 20,
      }).length,
    };
  }

  ingestClientRequest(input: {
    ownerId: string;
    client: string;
    subject: string;
    body: string;
    fromEmail?: string;
  }) {
    this.assertOwner(input.ownerId);
    const client = resolveClient(this.clientDefs(), input.client);
    if (!client) {
      throw new AuthError(
        `unknown client "${input.client}". Known: ${this.clientDefs()
          .map((c) => c.id)
          .join(", ")}`,
      );
    }
    const mission = this.missions.create({
      ownerId: input.ownerId,
      title: `[${client.name}] ${input.subject.slice(0, 120)}`,
      goal: input.body.slice(0, 8000),
      workspace: client.workspace,
      markers: {
        client: client.id,
        kind: "bugfix",
        from: input.fromEmail ?? "",
      },
    });
    this.missions.update(input.ownerId, mission.id, {
      status: "intake",
    });
    const req = this.clientRequests.create({
      ownerId: input.ownerId,
      client,
      fromEmail: input.fromEmail,
      subject: input.subject,
      body: input.body,
      missionId: mission.id,
    });
    return { request: req, mission, next: "run_next_bugfix when kimi budget allows" };
  }

  listClientRequests(
    ownerId: string,
    opts?: { clientId?: string; status?: "queued" | "in_progress" | "done" | "deferred" | "cancelled"; limit?: number },
  ) {
    this.assertOwner(ownerId);
    return {
      clients: this.clientDefs(),
      requests: this.clientRequests.list(ownerId, opts),
    };
  }

  draftClientUpdate(input: {
    ownerId: string;
    client: string;
    sinceIso?: string;
  }) {
    this.assertOwner(input.ownerId);
    const client = resolveClient(this.clientDefs(), input.client);
    if (!client) {
      throw new AuthError(`unknown client "${input.client}"`);
    }
    const draft = this.clientRequests.draftUpdateEmail({
      ownerId: input.ownerId,
      client,
      draftsDir: join(this.dataDir, "drafts"),
      sinceIso: input.sinceIso,
      fromYou: "— Partha",
    });
    return {
      ...draft,
      note: "Draft only — not sent. Review on Mac, then send from your inbox.",
      whiteboard_hint: "markers can show update_drafted=true after you send",
    };
  }

  /**
   * Pull the next queued client bug email and start a paced Kimi bugfix job.
   */
  runNextBugfix(ownerId: string) {
    this.assertOwner(ownerId);
    const queued = this.clientRequests.list(ownerId, {
      status: "queued",
      limit: 1,
    });
    // list is DESC — take oldest queued instead
    const oldest = this.clientRequests
      .list(ownerId, { status: "queued", limit: 50 })
      .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
    void queued;
    if (!oldest) {
      return { started: false as const, reason: "no queued client requests" };
    }

    const prompt = [
      `CLIENT BUGFIX (bounded). Client: ${oldest.client_name} (${oldest.client_id}).`,
      `From: ${oldest.from_email ?? "unknown"}`,
      `Subject: ${oldest.subject}`,
      ``,
      `Email / request:`,
      oldest.body.slice(0, 12_000),
      ``,
      `Rules:`,
      `- Fix only what this request needs. No drive-by refactors.`,
      `- Prefer smallest safe change. Summarize what you changed in ≤10 lines at the end.`,
      `- Do not send email. Do not deploy unless explicitly asked.`,
      `- If blocked, say what you need and stop.`,
    ].join("\n");

    try {
      const task = this.startTask({
        ownerId,
        agent: "kimi",
        workspace: oldest.workspace,
        prompt,
        tier: "bugfix",
        timeoutSec: 900,
      });
      this.clientRequests.update(ownerId, oldest.id, {
        status: "in_progress",
        jobId: task.id,
      });
      if (oldest.mission_id) {
        this.missions.update(ownerId, oldest.mission_id, {
          status: "implementing",
          linkJobId: task.id,
        });
      }
      return {
        started: true as const,
        request: oldest,
        task,
        usage: this.getUsage(ownerId).kimi,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("usage budget")) {
        return {
          started: false as const,
          reason: msg,
          request: oldest,
          usage: this.getUsage(ownerId).kimi,
          hint: "Left queued. Retry run_next_bugfix after retry_after_sec (protects Kimi 5h window).",
        };
      }
      throw err;
    }
  }

  // --- Interactive terminal sessions (PTY) ---

  createTerminalSession(input: {
    ownerId: string;
    kind: SessionKind;
    workspace: string;
    model?: string;
    cols?: number;
    rows?: number;
    idleSec?: number | null;
  }) {
    this.assertOwner(input.ownerId);
    if (input.kind === "cursor" && !isAgentEnabled(this.config, "cursor")) {
      throw new AuthError("agent not enabled: cursor");
    }
    if (input.kind === "kimi" && !isAgentEnabled(this.config, "kimi")) {
      throw new AuthError("agent not enabled: kimi");
    }
    let workPath: string;
    try {
      workPath = resolveWorkspacePath(
        input.workspace,
        this.config.worker.allowed_roots,
        this.configRoot,
      );
    } catch (err) {
      throw new AuthError(
        err instanceof WorkspaceError ? err.message : String(err),
      );
    }
    try {
      return this.sessions.create({
        ownerId: input.ownerId,
        kind: input.kind,
        workspacePath: workPath,
        model: input.model,
        cols: input.cols,
        rows: input.rows,
        idleSec: input.idleSec,
        agentBinary: this.config.agents.cursor?.binary,
        kimiBinary: this.config.agents.kimi?.binary,
        maxOutputBytes: this.config.worker.max_output_bytes,
      });
    } catch (err) {
      if (err instanceof BinaryResolveError) throw new AuthError(err.message);
      throw err;
    }
  }

  listTerminalSessions(ownerId: string) {
    return this.sessions.list(ownerId);
  }

  getTerminalSession(ownerId: string, sessionId: string) {
    return this.sessions.get(ownerId, sessionId);
  }

  readTerminalOutput(
    ownerId: string,
    sessionId: string,
    opts?: { offset?: number; maxBytes?: number },
  ) {
    return this.sessions.read(ownerId, sessionId, opts);
  }

  writeTerminalInput(
    ownerId: string,
    sessionId: string,
    input: { data?: string; keys?: string[]; submit?: boolean },
  ) {
    return this.sessions.write(ownerId, sessionId, input);
  }

  resizeTerminalSession(
    ownerId: string,
    sessionId: string,
    cols: number,
    rows: number,
  ) {
    return this.sessions.resize(ownerId, sessionId, cols, rows);
  }

  interruptTerminalSession(ownerId: string, sessionId: string) {
    return this.sessions.interrupt(ownerId, sessionId);
  }

  closeTerminalSession(ownerId: string, sessionId: string) {
    return this.sessions.close(ownerId, sessionId);
  }

  terminalCapabilities(ownerId: string) {
    return this.sessions.capabilities(ownerId, {
      cursorBinary: this.config.agents.cursor?.binary,
      kimiBinary: this.config.agents.kimi?.binary,
    });
  }

  /**
   * Single snapshot so ChatGPT can "see" jobs, PTYs (with tails), and approvals.
   */
  getSituation(
    ownerId: string,
    opts?: { tail_bytes?: number; task_limit?: number },
  ) {
    this.assertOwner(ownerId);
    const tailBytes = Math.min(opts?.tail_bytes ?? 4096, 32_768);
    const taskLimit = Math.min(opts?.task_limit ?? 12, 40);
    const tasks = this.listTasks(ownerId, taskLimit);
    const active = tasks.filter(
      (t) =>
        t.status === "queued" ||
        t.status === "preparing" ||
        t.status === "running" ||
        t.status === "awaiting_followup" ||
        t.status === "cancelling",
    );
    const sessions = this.sessions.list(ownerId).map((s) => {
      let tail: string | null = null;
      let tail_truncated = false;
      try {
        const out = this.sessions.readTail(ownerId, s.id, tailBytes);
        tail = out.text;
        tail_truncated = out.truncated;
      } catch {
        tail = null;
      }
      return {
        ...s,
        output_tail: tail,
        output_tail_truncated: tail_truncated,
      };
    });
    const approvals = this.approvals.list(ownerId, {
      includeResolved: true,
      limit: 10,
    });
    const missions = this.missions.list(ownerId, { limit: 20 });
    const lc = this.config.worker.local_control;
    return {
      at: new Date().toISOString(),
      owner: this.config.owner,
      agent_execution: this.config.worker.agent_execution,
      enabled_agents: Object.entries(this.config.agents)
        .filter(([, v]) => v.enabled)
        .map(([k]) => k),
      missions,
      active_tasks: active,
      recent_tasks: tasks,
      terminal_sessions: sessions,
      approvals,
      local_control: {
        enabled: lc?.enabled === true,
        browser_requires_approval: lc?.browser_requires_approval !== false,
        approval_timeout_sec: lc?.approval_timeout_sec ?? 120,
        whiteboard_url: `http://${lc?.bind ?? "127.0.0.1"}:${lc?.port ?? 8788}/`,
        menu_bar_url: `http://${lc?.bind ?? "127.0.0.1"}:${lc?.port ?? 8788}`,
      },
      note:
        "Orchestration (hybrid_remote): create_mission → research/terminal within scope → plan in chat → approve_mission authorization=chat_explicit after owner consent (or require_dialog for Mac) → implement without re-approving → complete_mission + notify. Sensitive actions: request_local_approval only. Whiteboard: local_control.whiteboard_url. Re-call get_situation to refresh.",
      redaction_note: REDACTION_DISCLAIMER,
    };
  }

  /** Payload for the full-screen Mac whiteboard. */
  getBoardSnapshot(ownerId: string) {
    this.assertOwner(ownerId);
    const situation = this.getSituation(ownerId, {
      tail_bytes: 2500,
      task_limit: 15,
    });
    const byStatus: Record<string, unknown[]> = {};
    for (const s of MISSION_STATUSES) byStatus[s] = [];
    for (const m of situation.missions) {
      (byStatus[m.status] ??= []).push(m);
    }
    const kpis: { key: string; value: string | number | boolean | null; mission: string }[] =
      [];
    for (const m of situation.missions) {
      for (const [key, value] of Object.entries(m.markers)) {
        kpis.push({ key, value, mission: m.title });
      }
    }
    const usage = this.getUsage(ownerId);
    const systemFocus = buildBoardSystemFocus(situation.missions, situation.active_tasks);
    return {
      ...situation,
      columns: byStatus,
      kpis,
      usage,
      ...systemFocus,
      health: {
        worker: true,
        relay_hint: this.config.relay.url,
        open_terminals: situation.terminal_sessions.filter(
          (s) => s.state === "running",
        ).length,
        active_missions: situation.missions.filter(
          (m) =>
            m.status !== "done" &&
            m.status !== "cancelled",
        ).length,
        pending_approvals: situation.approvals.filter(
          (a) => a.status === "pending",
        ).length,
        kimi_starts_left: usage.kimi.starts_remaining,
        cursor_starts_left: usage.cursor.starts_remaining,
        queued_bugfixes: usage.queued_bugfixes,
      },
    };
  }

  createMission(input: {
    ownerId: string;
    title: string;
    goal: string;
    workspace?: string;
    markers?: Record<string, string | number | boolean | null>;
  }) {
    this.assertOwner(input.ownerId);
    return this.missions.create(input);
  }

  listMissions(
    ownerId: string,
    opts?: { status?: MissionStatus; limit?: number },
  ) {
    this.assertOwner(ownerId);
    return this.missions.list(ownerId, opts);
  }

  getMission(ownerId: string, id: string) {
    this.assertOwner(ownerId);
    const m = this.missions.get(ownerId, id);
    if (!m) throw new AuthError(`mission not found: ${id}`);
    return m;
  }

  updateMission(
    ownerId: string,
    id: string,
    patch: {
      title?: string;
      goal?: string;
      workspace?: string | null;
      status?: MissionStatus;
      plan?: string | null;
      findings?: string | null;
      summary?: string | null;
      markers?: Record<string, string | number | boolean | null>;
      linkJobId?: string;
      linkSessionId?: string;
    },
  ) {
    this.assertOwner(ownerId);
    const cur = this.getMission(ownerId, id);
    if (isMissionWorkspaceScopeExpansion(cur, patch.workspace)) {
      throw new AuthError(
        "hybrid_remote: workspace scope expansion requires Mac confirmation — explain in ChatGPT, call request_local_approval (permission), and pause until approved",
      );
    }
    try {
      return this.missions.update(ownerId, id, patch);
    } catch (err) {
      throw new AuthError(err instanceof Error ? err.message : String(err));
    }
  }

  async approveMission(
    ownerId: string,
    id: string,
    opts?: {
      requireDialog?: boolean;
      note?: string;
      authorization?: typeof APPROVAL_SOURCE_CHAT_EXPLICIT | typeof APPROVAL_SOURCE_LOCAL_DIALOG;
      approvedScope?: string;
    },
  ) {
    this.assertOwner(ownerId);
    const m = this.getMission(ownerId, id);
    if (!m.plan) {
      throw new AuthError("mission has no plan yet — set plan before approve");
    }
    if (missionRoutineScopeApproved(m)) {
      return {
        mission: m,
        approval: null,
        approved: true as const,
        already_approved: true as const,
      };
    }
    const mode = resolveMissionApprovalMode({
      requireDialog: opts?.requireDialog,
      authorization: opts?.authorization,
    });
    if (mode === "local_dialog") {
      const approval = await this.approvals.request({
        ownerId,
        kind: "permission",
        title: `Approve plan: ${m.title}`,
        detail: `${opts?.note ? opts.note + "\n\n" : ""}${m.plan.slice(0, 3500)}`,
        payload: { mission_id: id, approval_policy: "hybrid_remote" },
        wait: true,
      });
      if (approval.status !== "approved") {
        return {
          mission: m,
          approval,
          approved: false as const,
          error: `plan not approved (status=${approval.status})`,
        };
      }
      const updated = this.missions.update(ownerId, id, {
        status: "approved",
        markers: hybridRemoteMarkers(APPROVAL_SOURCE_LOCAL_DIALOG, opts?.approvedScope),
      });
      return { mission: updated, approval, approved: true as const };
    }
    if (opts?.authorization !== APPROVAL_SOURCE_CHAT_EXPLICIT) {
      throw new AuthError(
        "hybrid_remote: routine chat approval requires authorization=chat_explicit after owner consent in this thread, or require_dialog/local_dialog for Mac Approve",
      );
    }
    const scope = (opts?.approvedScope ?? ROUTINE_APPROVED_SCOPE).slice(0, 120);
    const updated = this.missions.update(ownerId, id, {
      status: "approved",
      markers: hybridRemoteMarkers(APPROVAL_SOURCE_CHAT_EXPLICIT, scope),
    });
    return {
      mission: updated,
      approval: null,
      approved: true as const,
      approval_source: APPROVAL_SOURCE_CHAT_EXPLICIT,
      approval_policy: "hybrid_remote",
      approved_scope: scope,
    };
  }

  async completeMission(
    ownerId: string,
    id: string,
    input: {
      summary: string;
      markers?: Record<string, string | number | boolean | null>;
      notify?: boolean;
    },
  ) {
    this.assertOwner(ownerId);
    const updated = this.missions.update(ownerId, id, {
      status: "done",
      summary: input.summary,
      markers: input.markers,
    });
    if (input.notify !== false) {
      await this.approvals.notifyOwner(
        ownerId,
        `Mission done · ${updated.title}`,
        input.summary.slice(0, 200),
      );
    }
    return updated;
  }

  async requestLocalApproval(input: {
    ownerId: string;
    kind: ApprovalKind;
    title: string;
    detail: string;
    payload?: Record<string, unknown>;
    timeoutSec?: number;
    wait?: boolean;
  }) {
    this.assertOwner(input.ownerId);
    if (!isSensitiveApprovalRequest(input)) {
      throw new AuthError(
        "hybrid_remote: request_local_approval is for sensitive Mac-confirmed actions only — routine read/code/test/terminal work inside an approved mission does not need this",
      );
    }
    return this.approvals.request(input);
  }

  listApprovals(
    ownerId: string,
    opts?: { includeResolved?: boolean; limit?: number },
  ) {
    return this.approvals.list(ownerId, opts);
  }

  getApproval(ownerId: string, id: string) {
    return this.approvals.get(ownerId, id);
  }

  resolveApproval(
    ownerId: string,
    id: string,
    decision: "approved" | "denied",
    note?: string,
  ) {
    return this.approvals.resolve(ownerId, id, decision, note);
  }

  async notifyOwner(ownerId: string, title: string, body: string) {
    return this.approvals.notifyOwner(ownerId, title, body);
  }

  async openUrl(
    ownerId: string,
    url: string,
    opts?: { requireApproval?: boolean; title?: string; wait?: boolean },
  ) {
    this.assertOwner(ownerId);
    const requireApproval =
      opts?.requireApproval ??
      this.config.worker.local_control?.browser_requires_approval !== false;

    if (requireApproval) {
      const approval = await this.approvals.request({
        ownerId,
        kind: "browser_open",
        title: opts?.title ?? `Open browser: ${url.slice(0, 120)}`,
        detail: `ChatGPT wants to open this URL in your default browser on this Mac:\n\n${url}\n\nApprove only if you expect this.`,
        payload: { url },
        wait: opts?.wait !== false,
      });
      if (approval.status !== "approved") {
        return {
          ok: false as const,
          opened: false,
          url,
          approval,
          error: `browser open not approved (status=${approval.status})`,
        };
      }
      const opened = await openUrlInBrowser(url);
      return { ...opened, opened: true, approval };
    }

    const opened = await openUrlInBrowser(url);
    return { ...opened, opened: true, approval: null };
  }

  /**
   * Discovery for ChatGPT: workspaces under allowed_roots + optional named aliases.
   * Paths are returned so you can direct Cursor/Kimi — they already have git access there.
   */
  listProjects(ownerId: string) {
    this.assertOwner(ownerId);
    const aliases = this.config.projects.map((p) => ({
      id: p.id,
      name: p.name,
      kind: "alias" as const,
      description: p.description ?? null,
      allowed_agents: p.allowed_agents.filter((a) => isAgentEnabled(this.config, a)),
      workspace: null as string | null,
    }));

    const hints = listWorkspaceHints(
      this.config.worker.allowed_roots,
      this.configRoot,
    ).map((h) => ({
      id: h.name.replace(/[^a-zA-Z0-9/_-]/g, "-"),
      name: h.name,
      kind: "workspace" as const,
      description: `Under ${h.root}`,
      allowed_agents: (["cursor", "kimi"] as AgentKind[]).filter((a) =>
        isAgentEnabled(this.config, a),
      ),
      workspace: h.name,
    }));

    return {
      agent_execution: this.config.worker.agent_execution,
      enabled_agents: Object.entries(this.config.agents)
        .filter(([, v]) => v.enabled)
        .map(([k]) => k),
      allowed_roots: this.config.worker.allowed_roots,
      workspaces: hints,
      aliases,
      clients: this.clientDefs(),
      note:
        "Pass workspace (folder name or path under allowed_roots) with agent cursor|kimi. Client bugfixes: ingest_client_request → run_next_bugfix (Kimi, paced for 5h window). Research: start_task tier=research (Cursor ask mode + cheap model).",
      terminal_sessions:
        "Interactive PTYs outlive chat turns while the worker process is up; worker restart ends them. Workspace sets cwd only — not an OS sandbox.",
    };
  }

  listTasks(ownerId: string, limit = 30): TaskView[] {
    this.assertOwner(ownerId);
    return this.store.listRecent(ownerId, limit).map((j) => this.toView(j));
  }

  startTask(input: StartTaskInput): TaskView {
    this.assertOwner(input.ownerId);

    if (!isAgentEnabled(this.config, input.agent)) {
      throw new AuthError(`agent not enabled: ${input.agent}`);
    }

    const tier = (input.tier ?? "default") as string;
    let resolvedModel: string | null = input.model ?? null;
    let cursorMode: "ask" | "plan" | null = null;

    if (input.agent === "cursor" || input.agent === "kimi") {
      const policy = this.usagePolicy(input.agent);
      resolvedModel = resolveModelForTier(policy, tier, input.model);
      if (
        input.agent === "cursor" &&
        (tier === "research" || tier === "triage") &&
        policy.research_mode
      ) {
        cursorMode = policy.research_mode;
      }
      const inFlight = [...this.active.values()].length; // rough; refined below
      const agentInFlight = this.store
        .listRecent(input.ownerId, 40)
        .filter(
          (j) =>
            j.agent === input.agent &&
            (j.status === "queued" ||
              j.status === "preparing" ||
              j.status === "running" ||
              j.status === "awaiting_followup"),
        ).length;
      void inFlight;
      const budget = this.usage.checkBudget(
        input.agent,
        policy,
        agentInFlight,
      );
      if (!budget.allowed) {
        this.usage.record({
          agent: input.agent,
          kind: "blocked",
          tier,
          model: resolvedModel,
          detail: budget.reason,
        });
        throw new AuthError(
          `usage budget: ${budget.reason}` +
            (budget.retry_after_sec
              ? ` (retry_after_sec=${budget.retry_after_sec})`
              : ""),
        );
      }
    }

    let projectId: string;
    let workPath: string | null = null;
    let timeoutSec =
      input.timeoutSec ?? this.config.worker.default_timeout_sec;

    if (input.agent === "mock" || input.projectId) {
      if (!input.projectId) throw new AuthError("project_id required for mock/alias");
      if (!isAgentAllowed(this.config, input.projectId, input.agent)) {
        throw new AuthError("agent or project not permitted");
      }
      const project = getProject(this.config, input.projectId);
      if (!project) throw new AuthError("unknown project");
      projectId = project.id;
      timeoutSec = Math.min(timeoutSec, project.permissions.max_runtime_sec);
    } else {
      // cursor / kimi host mode — workspace required, no project registry
      if (!input.workspace) {
        throw new AuthError("workspace is required for cursor/kimi");
      }
      try {
        workPath = resolveWorkspacePath(
          input.workspace,
          this.config.worker.allowed_roots,
          this.configRoot,
        );
      } catch (err) {
        throw new AuthError(
          err instanceof WorkspaceError ? err.message : String(err),
        );
      }
      projectId = workspaceLabel(workPath);

      // Serialize concurrent host jobs on the same live workspace
      const active = this.store
        .listActiveForWorkPath(workPath)
        .filter((j) => j.agent === input.agent || true);
      if (
        active.some(
          (j) =>
            j.status === "running" ||
            j.status === "preparing" ||
            j.status === "queued",
        )
      ) {
        // Allow queueing follow-ups via send_followup on existing job;
        // block a second parallel mutate on same tree.
        const blockers = active.filter(
          (j) =>
            j.status === "running" ||
            j.status === "preparing" ||
            j.status === "queued",
        );
        if (blockers.length > 0 && !input.idempotencyKey) {
          throw new AuthError(
            `workspace busy with job ${blockers[0]!.id} (${blockers[0]!.status}); check in with get_task or send_followup`,
          );
        }
      }
    }

    const job = this.store.createJob({
      ...input,
      projectId,
      workPath,
      timeoutSec,
    });
    if (input.agent === "cursor" || input.agent === "kimi") {
      this.jobMeta.set(job.id, {
        tier,
        model: resolvedModel,
        cursorMode,
      });
      this.usage.record({
        agent: input.agent,
        kind: "start",
        jobId: job.id,
        tier,
        model: resolvedModel,
      });
    }
    if (this.running) void this.tick();
    return this.toView(job);
  }

  getTask(ownerId: string, jobId: string): TaskView {
    const job = this.store.assertOwner(jobId, ownerId);
    return this.toView(job);
  }

  getTaskOutput(ownerId: string, jobId: string): TaskOutputView {
    const job = this.store.assertOwner(jobId, ownerId);
    const logs = this.store.getLogs(jobId);
    const combined = [logs.stdout, logs.stderr].filter(Boolean).join("\n");
    const bounded = boundOutput(combined, this.config.worker.max_output_bytes);
    const redacted = redactSecrets(bounded.text);
    const diff = logs.diff
      ? redactSecrets(
          boundOutput(logs.diff, this.config.worker.max_output_bytes).text,
        ).text
      : null;
    const tests = logs.test_results
      ? redactSecrets(
          boundOutput(logs.test_results, this.config.worker.max_output_bytes)
            .text,
        ).text
      : null;

    return {
      job_id: job.id,
      status: job.status,
      logs: redacted.text,
      truncated: bounded.truncated,
      redaction_note: REDACTION_DISCLAIMER,
      summary: job.summary,
      diff,
      test_results: tests,
    };
  }

  sendFollowup(ownerId: string, jobId: string, message: string): TaskView {
    const job = this.store.assertOwner(jobId, ownerId);
    if (isTerminal(job.status)) {
      throw new Error("cannot follow up on a finished job");
    }
    const adapter = getAdapter(job.agent);
    this.store.enqueueFollowup(jobId, message);
    if (job.status === "running" && !adapter.acceptsLiveFollowup) {
      // Soft-wait: process keeps running; finishJob re-queues when it exits.
      // Logs stream continuously — do not expect empty get_task_output here.
      this.store.updateJob(jobId, { status: "awaiting_followup" });
    } else if (
      job.status === "awaiting_followup" &&
      !this.active.has(jobId)
    ) {
      // Orphaned wait state (e.g. prior bug): resume delivery.
      this.store.updateJob(jobId, {
        status: "queued",
        finished_at: null,
        error: null,
      });
      if (this.running) void this.tick();
    }
    return this.toView(this.store.getJob(jobId)!);
  }

  cancelTask(ownerId: string, jobId: string): TaskView {
    const job = this.store.assertOwner(jobId, ownerId);
    if (isTerminal(job.status)) return this.toView(job);

    this.store.updateJob(jobId, { status: "cancelling" });
    const active = this.active.get(jobId);
    if (active) {
      void active.handle.cancel("SIGTERM");
    } else if (job.status === "queued" || job.status === "awaiting_followup") {
      this.store.updateJob(jobId, {
        status: "cancelled",
        finished_at: new Date().toISOString(),
        summary: "cancelled before start",
      });
    }
    return this.toView(this.store.getJob(jobId)!);
  }

  private assertOwner(ownerId: string): void {
    if (ownerId !== this.config.owner.id) {
      throw new AuthError("unauthorized owner");
    }
  }

  toView(job: NonNullable<ReturnType<JobStore["getJob"]>>): TaskView {
    return {
      id: job.id,
      owner_id: job.owner_id,
      project_id: job.project_id,
      agent: job.agent,
      status: job.status,
      summary: job.summary,
      error: job.error,
      exit_code: job.exit_code,
      session_id: job.session_id,
      work_path: job.work_path,
      created_at: job.created_at,
      updated_at: job.updated_at,
      started_at: job.started_at,
      finished_at: job.finished_at,
      followups_queued: this.store.countFollowups(job.id, "queued"),
    };
  }

  private resolveSourcePath(projectSource: string): string {
    const abs = resolve(this.configRoot, projectSource);
    return realpathSync(abs);
  }

  private async tick(): Promise<void> {
    if (!this.running || this.ticking) return;
    this.ticking = true;
    try {
      for (const job of this.store.listQueued()) {
        if (this.active.has(job.id)) continue;
        await this.launch(job.id);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async launch(jobId: string): Promise<void> {
    const job = this.store.getJob(jobId);
    if (!job || job.status !== "queued") return;

    this.store.updateJob(jobId, {
      status: "preparing",
      started_at: job.started_at ?? new Date().toISOString(),
    });

    try {
      const agentCfg = this.config.agents[job.agent];
      let workPath = job.work_path;
      let mode: "worktree" | "copy" | "live" = "live";
      let sourcePath = workPath ?? "";

      const useHost =
        (job.agent === "cursor" || job.agent === "kimi") &&
        this.config.worker.agent_execution === "host";

      if (useHost) {
        if (!workPath) {
          throw new Error("host job missing work_path");
        }
        mode = "live";
        sourcePath = workPath;
      } else {
        const project = getProject(this.config, job.project_id);
        if (!project) {
          throw new Error("project missing from config");
        }
        sourcePath = this.resolveSourcePath(project.source_path);
        if (workPath && existsSync(workPath)) {
          mode = "worktree";
        } else {
          // Missing/cleaned work_path (e.g. follow-up after prior cleanup) → fresh tree.
          await this.isolation.assertAvailable();
          const prepared = prepareJobWorkspace({
            jobsRoot: this.jobsRoot,
            jobId,
            sourcePath,
          });
          workPath = prepared.workPath;
          mode = prepared.mode;
        }
      }

      const followups = this.store.listFollowups(jobId, "queued");
      const adapter = getAdapter(job.agent as AgentKind);
      const project = getProject(this.config, job.project_id);
      let binary = agentCfg?.binary;
      if (useHost && (job.agent === "cursor" || job.agent === "kimi")) {
        try {
          binary = resolveExecutable(
            agentCfg?.binary,
            job.agent === "cursor" ? "agent" : "kimi",
          ).path;
        } catch (err) {
          throw new Error(
            err instanceof BinaryResolveError ? err.message : String(err),
          );
        }
      }

      const meta = this.jobMeta.get(jobId);
      const plan = adapter.plan({
        job: { ...job, work_path: workPath },
        workPath: workPath!,
        followupMessages: followups.map((f) => f.message),
        execution: useHost ? "host" : "docker",
        isolationImage: this.config.worker.isolation.image,
        network: project?.permissions.network ?? "none",
        runAsUser: this.config.worker.isolation.run_as_user,
        readOnlyRootfs: this.config.worker.isolation.read_only_rootfs,
        memoryMb: this.config.worker.isolation.memory_mb,
        cpus: this.config.worker.isolation.cpus,
        timeoutSec: job.timeout_sec,
        binary,
        model: meta?.model,
        tier: meta?.tier,
        cursorMode: meta?.cursorMode,
      });

      const onOutput = (chunk: { stdout?: string; stderr?: string }) => {
        try {
          this.store.appendLogs(jobId, chunk);
        } catch {
          // never kill the agent over log persistence
        }
      };
      if (plan.execution === "host") {
        plan.hostSpec.onOutput = onOutput;
      } else {
        plan.runSpec.onOutput = onOutput;
      }

      let handle: IsolationHandle;
      if (plan.execution === "host") {
        handle = await this.hostRunner.run(plan.hostSpec);
      } else {
        await this.isolation.assertAvailable();
        handle = await this.isolation.run(plan.runSpec);
      }

      this.store.updateJob(jobId, {
        status: "running",
        work_path: workPath,
        container_id: handle.containerId,
      });
      this.active.set(jobId, { handle, mode, sourcePath });

      for (const f of followups) {
        this.store.markFollowupDelivered(f.id);
      }

      void handle.wait().then((result) => {
        this.finishJob(jobId, plan, result, mode, sourcePath);
      });
    } catch (err) {
      this.store.updateJob(jobId, {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        finished_at: new Date().toISOString(),
      });
      this.active.delete(jobId);
    }
  }

  private finishJob(
    jobId: string,
    plan: AdapterPlan,
    result: Awaited<ReturnType<IsolationHandle["wait"]>>,
    mode: "worktree" | "copy" | "live",
    sourcePath: string,
  ): void {
    const job = this.store.getJob(jobId);
    if (!job) return;

    // Authoritative final buffers (streaming may have already written chunks).
    this.store.replaceStdio(jobId, result.stdout, result.stderr);

    const sessionId =
      plan.parseSessionId?.(result.stdout, result.stderr) ?? job.session_id;
    const summary = plan.summarize?.(result.stdout, result.stderr) ?? null;

    try {
      if (job.work_path) {
        const diff = spawnSync("git", ["-C", job.work_path, "diff"], {
          encoding: "utf8",
          maxBuffer: this.config.worker.max_output_bytes,
        });
        if (diff.stdout) {
          this.store.appendLogs(jobId, { diff: diff.stdout });
        }
      }
    } catch {
      // ignore
    }

    const wasCancelling = job.status === "cancelling";
    let status: typeof job.status = "succeeded";
    let error: string | null = null;

    if (wasCancelling || result.killed) {
      status = "cancelled";
      error = "cancelled";
    } else if (result.timedOut) {
      status = "timed_out";
      error = "timed out";
    } else if (result.exitCode !== 0) {
      status = "failed";
      error = `exit code ${result.exitCode}`;
    }

    const combinedOut = `${result.stdout}\n${result.stderr}`;
    if (
      (job.agent === "cursor" || job.agent === "kimi") &&
      looksLikeRateLimit(combinedOut)
    ) {
      status = "failed";
      error = "rate_limited";
      this.usage.record({
        agent: job.agent,
        kind: "rate_limited",
        jobId,
        tier: this.jobMeta.get(jobId)?.tier,
        model: this.jobMeta.get(jobId)?.model,
        detail: combinedOut.slice(-500),
      });
    } else if (job.agent === "cursor" || job.agent === "kimi") {
      this.usage.record({
        agent: job.agent,
        kind: "finish",
        jobId,
        tier: this.jobMeta.get(jobId)?.tier,
        model: this.jobMeta.get(jobId)?.model,
        detail: status,
      });
    }

    this.store.updateJob(jobId, {
      status,
      exit_code: result.exitCode,
      error,
      summary,
      session_id: sessionId,
      finished_at: new Date().toISOString(),
      container_id: null,
    });

    this.active.delete(jobId);
    this.jobMeta.delete(jobId);

    // Auto-complete client bugfix requests linked to this job
    if (job.agent === "kimi" && (status === "succeeded" || status === "failed")) {
      try {
        const linked = this.clientRequests
          .list(job.owner_id, { status: "in_progress", limit: 40 })
          .find((r) => r.job_id === jobId);
        if (linked) {
          this.clientRequests.update(job.owner_id, linked.id, {
            status: status === "succeeded" ? "done" : "queued",
            fixSummary:
              status === "succeeded"
                ? (summary ?? "kimi finished").slice(0, 2000)
                : null,
          });
          if (linked.mission_id && status === "succeeded") {
            this.missions.update(job.owner_id, linked.mission_id, {
              status: "done",
              summary: (summary ?? "bugfix done").slice(0, 2000),
              markers: { client: linked.client_id, bugfix: "done" },
            });
          }
        }
      } catch {
        // best-effort
      }
    }

    const remaining = this.store.listFollowups(jobId, "queued");
    // Re-queue on success even without session_id — adapters fold follow-ups
    // into the next prompt. Requiring session_id left jobs stuck in
    // awaiting_followup / succeeded with queued messages and empty resumes.
    if (remaining.length > 0 && status === "succeeded") {
      this.store.updateJob(jobId, {
        status: "queued",
        finished_at: null,
        error: null,
        exit_code: null,
      });
      void this.tick();
      return;
    }

    const latest = this.store.getJob(jobId)!;
    if (mode !== "live" && latest.work_path) {
      try {
        cleanupJobWorkspace({
          sourcePath,
          workPath: latest.work_path,
          mode: mode === "worktree" ? "worktree" : "copy",
        });
      } catch {
        // best-effort
      }
    }
  }
}

export { AuthError };
