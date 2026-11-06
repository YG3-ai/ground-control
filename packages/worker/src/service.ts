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
  assertAgentAllowedForNewWork,
  buildConservationPlan,
  conservationPlanToMeta,
  parseConservationMeta,
  deriveMissionDeliveryPresentation,
  buildNeedsYouRail,
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
import {
  killProcessGroup,
  parseHostProcessGroupPid,
} from "./isolation/process-group.js";
import { missionTimelineFromEvents } from "./missions/timeline.js";
import {
  deploymentRecordMarkers,
} from "./missions/deployment-record.js";
import { BinaryResolveError, resolveExecutable } from "./binary-resolve.js";
import { probeCodexBinary } from "./codex/detect.js";
import { parseCodexUsageFromJsonl } from "./adapters/codex.js";
import { isHostManagedAgent, hostBinaryFallback } from "./host-agents.js";
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
import { buildOwnerControlPolicySurface } from "./owner-control-policy.js";
import { openUrlInBrowser } from "./local/browser.js";
import { startLocalControlServer } from "./local/control-server.js";
import {
  MissionStore,
  MISSION_STATUSES,
  type MissionStatus,
  type MissionRecord,
} from "./missions/store.js";
import {
  contractFromMission,
  contractMarkerPayload,
  acknowledgeOwnerCheckpointMarker,
} from "./missions/contract.js";
import {
  compileAndMarkContractFromQualification,
  enrollApprovedMissionInQueue,
} from "./missions/compile-contract.js";
import {
  assertQualificationForV2Approval,
  isGroundDeliveryV2Mission,
} from "./missions/qualification.js";
import {
  assertCanComplete,
  assertCanSubmitReview,
  assertPlanEditAllowed,
  resolveGitHead,
} from "./missions/completion-gate.js";
import {
  missionHasActiveSupervisorJob,
  missionSupervisorOnJobFinished,
} from "./missions/supervisor.js";
import { recoverMissionSupervisionOnWorkerStart } from "./missions/recovery.js";
import { MissionQueueStore, type MissionQueueState } from "./missions/queue-store.js";
import {
  missionQueueOnJobFinished,
  missionQueueTick,
} from "./missions/queue-scheduler.js";
import { inventoryMissionQueueDrift } from "./missions/queue-lifecycle.js";
import { buildBoardSystemFocus } from "./board-system-focus.js";
import {
  UsageLedger,
  DEFAULT_CURSOR_POLICY,
  DEFAULT_CODEX_POLICY,
  DEFAULT_KIMI_POLICY,
  isProviderRateLimitFailure,
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
  readonly missionQueue: MissionQueueStore;
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
    {
      tier: string;
      model: string | null;
      cursorMode: "ask" | "plan" | null;
      reasoningEffort: "minimal" | "low" | "medium" | "high" | null;
      conservationMeta: string | null;
    }
  >();
  private readonly retryLoopGuard = new Map<string, { count: number; at: number }>();
  private ticking = false;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  readonly configRoot: string;

  /** advisor is canonical; supervisor remains a compatible legacy switch. */
  private get advisorEnabled(): boolean {
    return this.config.advisor?.enabled ?? this.config.supervisor.enabled;
  }

  /** Canonical Advisor settings, with the old supervisor block as an alias. */
  private get advisorConfig() {
    return this.config.advisor ?? this.config.supervisor;
  }

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
      pendingExpirySec: lc?.approval_pending_expiry_sec ?? 0,
    });
    this.missions = new MissionStore(
      join(
        resolve(opts.configRoot, opts.config.worker.data_dir),
        "missions.db",
      ),
    );
    this.missionQueue = new MissionQueueStore(this.missions.db);
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
    // Do not probe Codex while bringing the worker up. The probe uses a
    // synchronous CLI invocation (including `codex doctor`), so doing it here
    // can block the event loop before the local-control listener and relay
    // WebSocket are established. It remains demand-driven and cached at the
    // metadata call sites below.
    for (const row of this.store.listInFlightHostContainerIds()) {
      const pid = parseHostProcessGroupPid(row.container_id);
      if (pid) killProcessGroup(pid, "SIGTERM");
    }
    const recovered = this.store.recoverAfterRestart();
    if (recovered > 0) {
      console.error(`[worker] marked ${recovered} in-flight job(s) failed after restart`);
    }
    const missionFixes = recoverMissionSupervisionOnWorkerStart(this);
    if (missionFixes > 0) {
      console.error(
        `[worker] reconciled ${missionFixes} supervised mission state(s) after restart`,
      );
    }
    this.running = true;
    this.timer = setInterval(() => {
      void this.tick();
    }, 500);
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
      agent === "kimi"
        ? DEFAULT_KIMI_POLICY
        : agent === "codex"
          ? DEFAULT_CODEX_POLICY
          : DEFAULT_CURSOR_POLICY;
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

  resolveMissionWorkPath(mission: MissionRecord): string | null {
    if (typeof mission.markers.supervisor_work_path === "string") {
      return mission.markers.supervisor_work_path;
    }
    if (!mission.workspace) return null;
    try {
      return resolveWorkspacePath(
        mission.workspace,
        this.config.worker.allowed_roots,
        this.configRoot,
      );
    } catch {
      return null;
    }
  }

  getMissionTimeline(ownerId: string, missionId: string) {
    this.assertOwner(ownerId);
    const mission = this.getMission(ownerId, missionId);
    const queueEntry = this.missionQueue.getByMissionId(ownerId, missionId);
    const events = this.events
      .list({ limit: 500, includePrivate: false })
      .filter(
        (e) =>
          (e.source === "missions" && e.source_ref === missionId) ||
          e.evidence_refs.includes(`mission:${missionId}`) ||
          mission.linked_job_ids.some(
            (j) => e.source === "jobs" && e.source_ref === j,
          ),
      );
    return missionTimelineFromEvents({
      mission,
      events,
      queueState: queueEntry?.queue_state ?? null,
      hasActiveSupervisorJob: missionHasActiveSupervisorJob(mission, this.store),
    });
  }

  recordMissionDeployment(
    ownerId: string,
    missionId: string,
    input: { kind: "staging" | "owner_release" | "none" },
  ) {
    this.assertOwner(ownerId);
    const mission = this.getMission(ownerId, missionId);
    const contract = contractFromMission(mission);
    const policyMode =
      contract?.deployment_policy?.mode ??
      (typeof mission.markers.deployment_policy_mode === "string"
        ? (mission.markers.deployment_policy_mode as
            | "no_production"
            | "staging_only"
            | "owner_release_required")
        : "owner_release_required");
    const gitHead = resolveGitHead(this.resolveMissionWorkPath(mission));
    const now = new Date().toISOString();
    return this.missions.update(ownerId, missionId, {
      markers: deploymentRecordMarkers({
        kind: input.kind,
        recordedAt: now,
        gitHead,
        policyMode,
      }),
    });
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
    const codexInFlight = this.store
      .listRecent(ownerId, 50)
      .filter(
        (j) =>
          j.agent === "codex" &&
          (j.status === "queued" ||
            j.status === "preparing" ||
            j.status === "running" ||
            j.status === "awaiting_followup"),
      ).length;
    const kimi = this.usage.snapshot("kimi", this.usagePolicy("kimi"));
    const codex = this.usage.snapshot("codex", this.usagePolicy("codex"));
    const codexProbe = probeCodexBinary({
      configuredBinary: this.config.agents.codex?.binary,
    });
    return {
      at: new Date().toISOString(),
      cursor: { ...cursor, in_flight: cursorInFlight },
      codex: {
        ...codex,
        in_flight: codexInFlight,
        probe: codexProbe,
        note: "Primary noninteractive agent via `codex exec --json`. Conservation routing picks model + reasoning effort per task class.",
      },
      kimi: {
        ...kimi,
        in_flight: kimiInFlight,
        retired_for_new_work: true,
        note: "Historical Kimi usage only — new work is blocked. Legacy rolling-window stats remain for past jobs.",
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
    return { request: req, mission, next: "run_next_bugfix when codex budget allows" };
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
   * Pull the next queued client bug email and start a paced Codex bugfix job.
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
        agent: "codex",
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
        usage: this.getUsage(ownerId).codex,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("usage budget")) {
        return {
          started: false as const,
          reason: msg,
          request: oldest,
          usage: this.getUsage(ownerId).codex,
          hint: "Left queued. Retry run_next_bugfix after retry_after_sec.",
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
    if (input.kind === "kimi") {
      throw new AuthError(
        "kimi_retired: Kimi interactive sessions are disabled. Use codex or cursor.",
      );
    }
    if (input.kind === "codex" && !isAgentEnabled(this.config, "codex")) {
      throw new AuthError("agent not enabled: codex");
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
        codexBinary: this.config.agents.codex?.binary,
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
    return {
      ...this.sessions.capabilities(ownerId, {
        cursorBinary: this.config.agents.cursor?.binary,
        codexBinary: this.config.agents.codex?.binary,
        kimiBinary: this.config.agents.kimi?.binary,
      }),
      codex_probe: probeCodexBinary({
        configuredBinary: this.config.agents.codex?.binary,
      }),
    };
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
    const missions = this.missions.list(ownerId, { limit: 20 }).map((m) =>
      this.enrichMissionPresentation(m),
    );
    const lc = this.config.worker.local_control;
    return {
      at: new Date().toISOString(),
      owner: this.config.owner,
      agent_execution: this.config.worker.agent_execution,
      supervisor: {
        enabled: this.advisorConfig.enabled,
        poll_missions_sec: this.advisorConfig.poll_missions_sec ?? 2,
        queue_max_concurrent: this.advisorConfig.queue_max_concurrent ?? 1,
      },
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
        approval_dialog_wait_sec: lc?.approval_timeout_sec ?? 120,
        approval_pending_expiry_sec: lc?.approval_pending_expiry_sec ?? 0,
        whiteboard_url: `http://${lc?.bind ?? "127.0.0.1"}:${lc?.port ?? 8788}/`,
        menu_bar_url: `http://${lc?.bind ?? "127.0.0.1"}:${lc?.port ?? 8788}`,
      },
      approval_policy: buildOwnerControlPolicySurface(lc),
      note:
        "Orchestration (hybrid_remote + owner_control when permanent): authenticated owner in ChatGPT authorizes routine repo/shell/test/build/safe-restart/deploy/self-repair without duplicate Mac dialogs (logged). Mac confirmation still required for destructive deletion, financial actions, external representational sends, credentials/access changes, ambiguous irreversible work, and browser_open by default. create_mission → research/terminal → plan in chat → approve_mission authorization=chat_explicit → implement. Sensitive: request_local_approval only. Pending approvals survive dialog timeout (approval_pending_expiry_sec=0). Re-call get_situation to refresh.",
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
    const systemFocus = buildBoardSystemFocus(
      situation.missions as MissionRecord[],
      situation.active_tasks,
    );
    const mission_queue = this.listMissionQueueBoard(ownerId);
    const mission_queue_drift = inventoryMissionQueueDrift(
      this.missionQueue.list(ownerId, { limit: 200 }),
      (missionId) => this.missions.get(ownerId, missionId),
    );
    const needs_you = buildNeedsYouRail(situation.missions);
    return {
      ...situation,
      columns: byStatus,
      mission_queue,
      mission_queue_drift,
      needs_you,
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
        codex_starts_left: usage.codex.starts_remaining,
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

  private enrichMissionPresentation(m: MissionRecord) {
    const queueEntry = this.missionQueue.getByMissionId(this.config.owner.id, m.id);
    const hasActive = missionHasActiveSupervisorJob(m, this.store);
    const presentation = deriveMissionDeliveryPresentation(
      m,
      queueEntry ? { queue_state: queueEntry.queue_state } : null,
      hasActive,
    );
    return { ...m, ...presentation };
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
    if (patch.status === "approved") {
      throw new AuthError("use approve_mission to record explicit approval for the current plan revision");
    }
    if (patch.plan !== undefined && patch.plan !== cur.plan) {
      const planGate = assertPlanEditAllowed(cur);
      if (!planGate.ok) {
        throw new AuthError(planGate.message);
      }
    }
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
      const { mission: prepared, contractMarkers } = this.prepareMissionApprovalState(
        ownerId,
        m,
      );
      const updated = this.missions.update(ownerId, id, {
        status: "approved",
        workspace: prepared.workspace ?? undefined,
        markers: {
          ...hybridRemoteMarkers(APPROVAL_SOURCE_LOCAL_DIALOG, opts?.approvedScope),
          ...contractMarkers,
        },
      });
      void updated;
      this.finalizeGroundDeliveryEnrollment(ownerId, id);
      return {
        mission: this.getMission(ownerId, id),
        approval,
        approved: true as const,
      };
    }
    if (opts?.authorization !== APPROVAL_SOURCE_CHAT_EXPLICIT) {
      throw new AuthError(
        "hybrid_remote: routine chat approval requires authorization=chat_explicit after owner consent in this thread, or require_dialog/local_dialog for Mac Approve",
      );
    }
    const scope = (opts?.approvedScope ?? ROUTINE_APPROVED_SCOPE).slice(0, 120);
    const { mission: prepared, contractMarkers } = this.prepareMissionApprovalState(
      ownerId,
      m,
    );
    const updated = this.missions.update(ownerId, id, {
      status: "approved",
      workspace: prepared.workspace ?? undefined,
      markers: {
        ...hybridRemoteMarkers(APPROVAL_SOURCE_CHAT_EXPLICIT, scope),
        ...contractMarkers,
      },
    });
    void updated;
    this.finalizeGroundDeliveryEnrollment(ownerId, id);
    return {
      mission: this.getMission(ownerId, id),
      approval: null,
      approved: true as const,
      approval_source: APPROVAL_SOURCE_CHAT_EXPLICIT,
      approval_policy: "hybrid_remote",
      approved_scope: scope,
    };
  }

  private prepareMissionApprovalState(
    ownerId: string,
    m: MissionRecord,
  ): {
    mission: MissionRecord;
    contractMarkers: Record<string, string | number | boolean | null>;
  } {
    if (isGroundDeliveryV2Mission(m)) {
      let mission = m;
      try {
        const packet = assertQualificationForV2Approval(m);
        mission = compileAndMarkContractFromQualification(
          ownerId,
          m,
          packet,
          this.missions,
        );
      } catch (err) {
        throw new AuthError(err instanceof Error ? err.message : String(err));
      }
      const contract = contractFromMission(mission);
      if (!contract) {
        throw new AuthError("ground delivery v2: contract compile failed");
      }
      return {
        mission,
        contractMarkers: {
          ...contractMarkerPayload(contract),
          approved_contract_version: contract.version,
          supervision_state: "idle",
        },
      };
    }
    const contract = contractFromMission(m);
    const contractMarkers: Record<string, string | number | boolean | null> = contract
      ? {
          ...contractMarkerPayload(contract),
          approved_contract_version: contract.version,
          supervision_state: "idle",
        }
      : {
          supervision_state: m.markers.supervision_state ?? null,
        };
    return { mission: m, contractMarkers };
  }

  private finalizeGroundDeliveryEnrollment(ownerId: string, missionId: string): void {
    if (!this.advisorEnabled) return;
    const m = this.getMission(ownerId, missionId);
    if (!isGroundDeliveryV2Mission(m)) return;
    enrollApprovedMissionInQueue({
      ownerId,
      missionId,
      missionStore: this.missions,
      missionQueue: this.missionQueue,
      enqueue: (oid, input) => this.enqueueMissionProject(oid, input),
    });
  }

  /** Records a new plan revision; MissionStore clears stale approval revisions. */
  async submitMissionPlan(
    ownerId: string,
    id: string,
    input: { plan: string; findings?: string; notify?: boolean },
  ) {
    this.assertOwner(ownerId);
    if (!input.plan.trim()) throw new AuthError("mission plan cannot be empty");
    const updated = this.missions.update(ownerId, id, {
      plan: input.plan,
      findings: input.findings,
      status: "plan_ready",
      markers: { plan_approved: false, decision: "plan_review" },
    });
    if (input.notify !== false) {
      await this.approvals.notifyOwner(
        ownerId,
        `Plan ready · ${updated.title}`,
        `Revision ${updated.plan_revision} is ready. All good?`,
      );
    }
    return updated;
  }

  acknowledgeMissionOwnerCheckpoint(ownerId: string, missionId: string, stepId: string) {
    this.assertOwner(ownerId);
    const m = this.getMission(ownerId, missionId);
    const contract = contractFromMission(m);
    if (!contract) {
      throw new AuthError("mission has no contract");
    }
    const step = contract.steps.find((s) => s.id === stepId);
    if (!step || step.kind !== "owner_checkpoint") {
      throw new AuthError(`step ${stepId} is not an owner checkpoint`);
    }
    return this.missions.update(ownerId, missionId, {
      markers: {
        ...acknowledgeOwnerCheckpointMarker(stepId),
        supervision_state: "idle",
        owner_checkpoint_pending: null,
        block_reason: null,
        next_owner_action: null,
      },
    });
  }

  private missionJobsMap(mission: MissionRecord): Map<string, import("@agent-control/shared").JobRecord> {
    const map = new Map<string, import("@agent-control/shared").JobRecord>();
    for (const jobId of mission.linked_job_ids) {
      const job = this.store.getJob(jobId);
      if (job) map.set(jobId, job);
    }
    return map;
  }

  async submitMissionReview(
    ownerId: string,
    id: string,
    input: {
      summary: string;
      markers?: Record<string, string | number | boolean | null>;
      review_packet_version?: number;
      notify?: boolean;
    },
  ) {
    this.assertOwner(ownerId);
    const m = this.getMission(ownerId, id);
    const gate = assertCanSubmitReview(m, this.missionJobsMap(m));
    if (!gate.ok) {
      const blocked = this.missions.update(ownerId, id, {
        status: "blocked",
        markers: {
          block_reason: `${gate.code}: ${gate.message}`,
          supervision_state: "blocked",
        },
      });
      return { blocked: true as const, gate, mission: blocked };
    }
    const updated = this.missions.update(ownerId, id, {
      status: "ready_for_review",
      summary: input.summary,
      markers: {
        ...input.markers,
        review_state: "ready_for_review",
        project_active: false,
        queue_capacity_released: true,
        review_packet_version:
          input.review_packet_version ?? m.markers.review_packet_version ?? 1,
      },
    });
    const queueEntry = this.missionQueue.getByMissionId(ownerId, id);
    if (queueEntry && queueEntry.queue_state !== "cancelled") {
      this.missionQueue.update(ownerId, queueEntry.id, {
        queue_state: "ready_for_review",
        claim_token: null,
        claimed_at: null,
        lease_until: null,
      });
    }
    if (input.notify !== false) {
      await this.approvals.notifyOwner(
        ownerId,
        `Ready for review · ${updated.title}`,
        input.summary.slice(0, 200),
      );
    }
    return { blocked: false as const, mission: updated };
  }

  async completeMission(
    ownerId: string,
    id: string,
    input: {
      summary: string;
      markers?: Record<string, string | number | boolean | null>;
      notify?: boolean;
      owner_release_authorized?: boolean;
    },
  ) {
    this.assertOwner(ownerId);
    const m = this.getMission(ownerId, id);
    const gate = assertCanComplete(m, this.missionJobsMap(m), {
      ownerReleaseAuthorized: input.owner_release_authorized === true,
    });
    if (!gate.ok) {
      const blocked = this.missions.update(ownerId, id, {
        status: "blocked",
        markers: {
          block_reason: `${gate.code}: ${gate.message}`,
        },
      });
      return { blocked: true as const, gate, mission: blocked };
    }
    const contract = contractFromMission(m);
    const policyMode =
      contract?.deployment_policy?.mode ?? "owner_release_required";
    const gitHead = resolveGitHead(this.resolveMissionWorkPath(m));
    const deployMarkers = deploymentRecordMarkers({
      kind:
        policyMode === "staging_only"
          ? "staging"
          : policyMode === "no_production"
            ? "none"
            : "owner_release",
      recordedAt: new Date().toISOString(),
      gitHead,
      policyMode,
    });
    const updated = this.missions.update(ownerId, id, {
      status: "done",
      summary: input.summary,
      markers: {
        ...deployMarkers,
        ...input.markers,
        review_state: null,
        project_active: false,
        queue_capacity_released: true,
        supervision_state: null,
        current_step_id: null,
        supervision_next_run_at: null,
        supervision_wait_reason: null,
      },
    });
    const queueEntry = this.missionQueue.getByMissionId(ownerId, id);
    if (
      queueEntry &&
      queueEntry.queue_state !== "completed" &&
      queueEntry.queue_state !== "cancelled"
    ) {
      this.missionQueue.update(ownerId, queueEntry.id, {
        queue_state: "completed",
        claim_token: null,
        claimed_at: null,
        lease_until: null,
        blocker_code: null,
        blocker_detail: null,
      });
    }
    if (input.notify !== false) {
      await this.approvals.notifyOwner(
        ownerId,
        `Mission done · ${updated.title}`,
        input.summary.slice(0, 200),
      );
    }
    return { blocked: false as const, mission: updated };
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
      allowed_agents: (["cursor", "codex"] as AgentKind[]).filter((a) =>
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
        "Pass workspace with agent codex|cursor. Kimi is retired for new work. Client bugfixes: ingest_client_request → run_next_bugfix (Codex). Research: start_task tier=research (conservation may route to Cursor ask mode).",
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

    try {
      assertAgentAllowedForNewWork(this.config, input.agent);
    } catch (err) {
      throw new AuthError(err instanceof Error ? err.message : String(err));
    }

    const tier = (input.tier ?? "default") as string;
    const mutatingTier = tier !== "research" && tier !== "triage";
    const mission = input.missionId
      ? this.getMission(input.ownerId, input.missionId)
      : null;
    if (this.advisorEnabled && mutatingTier) {
      if (!mission) {
        throw new AuthError("Advisor: implementation requires mission_id with an approved plan");
      }
      if (!missionRoutineScopeApproved(mission)) {
        throw new AuthError(`Advisor: mission plan revision ${mission.plan_revision} is not approved`);
      }
    }
    const conservation = buildConservationPlan({
      config: this.config,
      tier: input.tier,
      explicitAgent: input.agent,
      explicitModel: input.model,
      ownerOverride: input.conservation_override ?? null,
    });
    const effectiveAgent = conservation.agent;
    if (!isAgentEnabled(this.config, effectiveAgent)) {
      throw new AuthError(`agent not enabled: ${effectiveAgent}`);
    }

    let resolvedModel: string | null = conservation.model;
    let cursorMode: "ask" | "plan" | null = conservation.cursor_mode;
    let reasoningEffort = conservation.reasoning_effort;

    if (isHostManagedAgent(effectiveAgent)) {
      const usageAgent = effectiveAgent as UsageAgent;
      const policy = this.usagePolicy(usageAgent);
      if (!input.conservation_override?.model) {
        resolvedModel =
          resolvedModel ??
          resolveModelForTier(policy, tier, input.model);
      }
      const agentInFlight = this.store
        .listRecent(input.ownerId, 40)
        .filter(
          (j) =>
            j.agent === effectiveAgent &&
            (j.status === "queued" ||
              j.status === "preparing" ||
              j.status === "running" ||
              j.status === "awaiting_followup"),
        ).length;
      const budget = this.usage.checkBudget(usageAgent, policy, agentInFlight);
      // Advisor may durably queue approved mission work while capacity is
      // occupied. launch() rechecks the same budget immediately before any
      // executor starts, so this is not a bypass of launch-time limits.
      if (!budget.allowed && !(this.advisorEnabled && mission)) {
        this.usage.record({
          agent: usageAgent,
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
      if (input.idempotencyKey) {
        const guardKey = `${effectiveAgent}:${input.idempotencyKey}`;
        const prev = this.retryLoopGuard.get(guardKey);
        const now = Date.now();
        if (prev && now - prev.at < 120_000 && prev.count >= 3) {
          throw new AuthError(
            "conservation_blocked: retry loop detected for idempotency key (wait or escalate)",
          );
        }
        this.retryLoopGuard.set(guardKey, {
          count: (prev && now - prev.at < 120_000 ? prev.count : 0) + 1,
          at: now,
        });
      }
    }

    let projectId: string;
    let workPath: string | null = null;
    let timeoutSec =
      input.timeoutSec ??
      Math.min(
        this.config.worker.default_timeout_sec,
        conservation.limits.max_elapsed_sec,
      );

    if (effectiveAgent === "mock" || input.projectId) {
      if (!input.projectId) throw new AuthError("project_id required for mock/alias");
      if (!isAgentAllowed(this.config, input.projectId, effectiveAgent)) {
        throw new AuthError("agent or project not permitted");
      }
      const project = getProject(this.config, input.projectId);
      if (!project) throw new AuthError("unknown project");
      projectId = project.id;
      timeoutSec = Math.min(timeoutSec, project.permissions.max_runtime_sec);
    } else {
      // cursor / codex host mode — workspace required, no project registry
      if (!input.workspace) {
        throw new AuthError("workspace is required for cursor/codex");
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
        if (blockers.length > 0 && !input.idempotencyKey && !(this.advisorEnabled && mission)) {
          throw new AuthError(
            `workspace busy with job ${blockers[0]!.id} (${blockers[0]!.status}); check in with get_task or send_followup`,
          );
        }
      }
    }

    const missionPacket = mission
      ? [
          "[Ground Control mission packet]",
          `Mission: ${mission.id}`,
          `Goal: ${mission.goal}`,
          `Workspace: ${mission.workspace ?? "unresolved"}`,
          `Plan revision: ${mission.plan_revision}; approved revision: ${mission.approved_revision ?? "none"}`,
          `Approved scope: ${mission.plan ?? ""}`,
          `Current step: ${String(mission.markers.current_step_id ?? "unassigned")}`,
          `Definition of done: ${String(mission.markers.definition_of_done ?? "see approved plan")}`,
          `Findings: ${mission.findings ?? "none"}`,
          `Latest handoff: ${mission.handoff ? JSON.stringify(mission.handoff) : mission.summary ?? "none"}`,
          `Linked jobs: ${mission.linked_job_ids.join(", ") || "none"}`,
          `Evidence: ${String(mission.markers.evidence_git_head ?? "none")}`,
          "[End Ground Control mission packet]",
        ].join("\n")
      : "";
    // Put authority ahead of task prose; only the latter may be truncated.
    const availablePrompt = Math.max(0, conservation.limits.max_context_chars - missionPacket.length - (missionPacket ? 2 : 0));
    const taskPrompt = input.prompt.length > availablePrompt
      ? `${input.prompt.slice(0, availablePrompt)}\n\n[truncated by conservation max_context_chars]`
      : input.prompt;
    const boundedPrompt = missionPacket ? `${missionPacket}\n\n${taskPrompt}` : taskPrompt;

    const conservationMeta = conservationPlanToMeta({
      ...conservation,
      model: resolvedModel,
      tokens_budget: conservation.limits.max_output_chars,
    });

    const job = this.store.createJob({
      ...input,
      agent: effectiveAgent,
      prompt: boundedPrompt,
      projectId,
      workPath,
      timeoutSec,
      resolvedModel,
      cursorMode,
    });
    this.store.updateJob(job.id, { execution_meta: conservationMeta });
    if (mission) this.missions.update(input.ownerId, mission.id, { linkJobId: job.id });

    if (isHostManagedAgent(effectiveAgent)) {
      this.jobMeta.set(job.id, {
        tier,
        model: resolvedModel,
        cursorMode,
        reasoningEffort,
        conservationMeta,
      });
      if (!this.advisorEnabled) {
      this.usage.record({
        agent: effectiveAgent as UsageAgent,
        kind: "start",
        jobId: job.id,
        tier,
        model: resolvedModel,
      });
      }
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
    } else {
      const pid = parseHostProcessGroupPid(job.container_id);
      if (pid) killProcessGroup(pid, "SIGTERM");
      else if (job.status === "queued" || job.status === "awaiting_followup") {
        this.store.updateJob(jobId, {
          status: "cancelled",
          finished_at: new Date().toISOString(),
          summary: "cancelled before start",
        });
      }
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
      mission_id: job.mission_id,
      tier: job.tier,
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
      conservation: parseConservationMeta(job.execution_meta ?? null),
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
      await missionQueueTick(this);
    } finally {
      this.ticking = false;
    }
  }

  private async launch(jobId: string): Promise<void> {
    const job = this.store.getJob(jobId);
    if (!job || job.status !== "queued") return;
    if (this.advisorEnabled) {
      if (job.mission_id) {
        const mission = this.missions.get(job.owner_id, job.mission_id);
        const readOnly = job.tier === "research" || job.tier === "triage";
        if (!mission || ["blocked", "cancelled", "done", "ready_for_review"].includes(mission.status) ||
          ["paused", "blocked"].includes(String(mission.markers.supervision_state)) ||
          (!readOnly && !missionRoutineScopeApproved(mission))) return;
      }
      if (job.work_path && this.store.listActiveForWorkPath(job.work_path).some(
        (candidate) => candidate.id !== job.id && candidate.status !== "queued",
      )) return;
    }
    // Recheck at the execution boundary. Queued Advisor work is intentionally
    // admitted FIFO, but it must never start beyond model/concurrency budget.
    if (this.advisorEnabled && isHostManagedAgent(job.agent)) {
      const usageAgent = job.agent as UsageAgent;
      const policy = this.usagePolicy(usageAgent);
      const activeForAgent = this.store.listRecent(job.owner_id, 100).filter(
        (candidate) => candidate.id !== job.id && candidate.agent === job.agent &&
          (candidate.status === "preparing" || candidate.status === "running" || candidate.status === "awaiting_followup"),
      ).length;
      if (!this.usage.checkBudget(usageAgent, policy, activeForAgent).allowed) return;
      this.usage.record({agent: usageAgent, kind: "start", jobId: job.id, tier: job.tier, model: job.model});
    }

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
        isHostManagedAgent(job.agent) &&
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
      if (useHost && isHostManagedAgent(job.agent)) {
        try {
          binary = resolveExecutable(
            agentCfg?.binary,
            hostBinaryFallback(job.agent),
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
        model: job.model ?? meta?.model,
        tier: job.tier ?? meta?.tier,
        cursorMode: job.cursor_mode ?? meta?.cursorMode,
        reasoningEffort: meta?.reasoningEffort ?? parseConservationMeta(job.execution_meta ?? null)?.reasoning_effort,
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
      if (this.advisorEnabled && job.mission_id) {
        this.missions.update(job.owner_id, job.mission_id, {
          status: "blocked",
          handoff: { job_id: job.id, agent: job.agent, status: "failed", summary: null, recorded_at: new Date().toISOString() },
          markers: { block_reason: err instanceof Error ? err.message : String(err) },
        });
      }
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

    const hostAgent = isHostManagedAgent(job.agent);
    if (hostAgent && isProviderRateLimitFailure({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr })) {
      status = "failed";
      error = "rate_limited";
      this.usage.record({
        agent: job.agent as UsageAgent,
        kind: "rate_limited",
        jobId,
        tier: this.jobMeta.get(jobId)?.tier,
        model: this.jobMeta.get(jobId)?.model,
        detail: result.stderr.slice(-500),
      });
    } else if (hostAgent) {
      this.usage.record({
        agent: job.agent as UsageAgent,
        kind: "finish",
        jobId,
        tier: this.jobMeta.get(jobId)?.tier,
        model: this.jobMeta.get(jobId)?.model,
        detail: status,
      });
    }

    let executionMeta = job.execution_meta ?? null;
    if (job.agent === "codex") {
      const metrics = parseCodexUsageFromJsonl(result.stdout);
      const parsed = parseConservationMeta(executionMeta);
      if (parsed) {
        const used =
          metrics.input_tokens != null || metrics.output_tokens != null
            ? (metrics.input_tokens ?? 0) + (metrics.output_tokens ?? 0)
            : null;
        executionMeta = conservationPlanToMeta({
          ...parsed,
          tokens_used: used,
          budget_label: metrics.label,
        });
      }
    }

    this.store.updateJob(jobId, {
      status,
      exit_code: result.exitCode,
      error,
      summary,
      session_id: sessionId,
      finished_at: new Date().toISOString(),
      container_id: null,
      execution_meta: executionMeta,
    });

    this.active.delete(jobId);
    this.jobMeta.delete(jobId);

    // Auto-complete client bugfix requests linked to this job
    if (
      (job.agent === "codex" || job.agent === "kimi") &&
      (status === "succeeded" || status === "failed")
    ) {
      try {
        const linked = this.clientRequests
          .list(job.owner_id, { status: "in_progress", limit: 40 })
          .find((r) => r.job_id === jobId);
        if (linked) {
          this.clientRequests.update(job.owner_id, linked.id, {
            status: status === "succeeded" ? "done" : "queued",
            fixSummary:
              status === "succeeded"
                ? (summary ?? `${job.agent} finished`).slice(0, 2000)
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

    missionSupervisorOnJobFinished(this, jobId, status);
    if (this.advisorEnabled && job.mission_id) {
      const mission = this.missions.get(job.owner_id, job.mission_id);
      if (mission) {
        this.missions.update(job.owner_id, mission.id, {
          ...(missionRoutineScopeApproved(mission) && !["paused", "blocked"].includes(String(mission.markers.supervision_state)) ? {
            status: status === "succeeded" ? "verifying" as const : "blocked" as const,
            markers: status === "succeeded" ? {} : { block_reason: error ?? "agent failed" },
          } : {}),
          handoff: { job_id: job.id, agent: job.agent, status, summary, recorded_at: new Date().toISOString() },
        });
      }
    }
    const missionForJob = this.missions
      .list(job.owner_id, { limit: 50 })
      .find((m) => m.linked_job_ids.includes(jobId));
    if (missionForJob) {
      missionQueueOnJobFinished(this, missionForJob.id);
    }
    if (this.running) void this.tick();
  }

  private listMissionQueueBoard(ownerId: string) {
    const entries = this.missionQueue.list(ownerId, { limit: 40 });
    return entries.map((e) => {
      const m = this.missions.get(ownerId, e.mission_id);
      const presentation = m
        ? deriveMissionDeliveryPresentation(
            m,
            { queue_state: e.queue_state },
            missionHasActiveSupervisorJob(m, this.store),
          )
        : null;
      return {
        ...e,
        mission_title: m?.title ?? null,
        mission_status: m?.status ?? null,
        display_state: presentation?.display_state ?? null,
        display_state_label: presentation?.display_state_label ?? null,
        why: e.blocker_detail ?? presentation?.blocker ?? null,
        next_run_at: e.next_run_at,
      };
    });
  }

  enqueueMissionProject(
    ownerId: string,
    input: {
      missionId: string;
      enqueueKey: string;
      priority?: number;
      dependsOn?: string[];
      earliestStartAt?: string | null;
      scheduleUntilAt?: string | null;
      resourceClass?: string;
      maxRetries?: number;
      backoffSec?: number;
    },
  ) {
    this.assertOwner(ownerId);
    const m = this.getMission(ownerId, input.missionId);
    if (!contractFromMission(m)) {
      throw new AuthError(
        "mission needs mission_contract_json before enqueue — approve_mission with contract markers",
      );
    }
    const okStatus =
      m.status === "approved" ||
      m.status === "implementing" ||
      m.status === "verifying" ||
      m.status === "plan_ready";
    if (!okStatus) {
      throw new AuthError(
        `mission status ${m.status} cannot be enqueued — approve plan first`,
      );
    }
    const entry = this.missionQueue.enqueue({
      ownerId,
      missionId: input.missionId,
      enqueueKey: input.enqueueKey,
      priority: input.priority,
      dependsOn: input.dependsOn,
      earliestStartAt: input.earliestStartAt,
      scheduleUntilAt: input.scheduleUntilAt,
      resourceClass: input.resourceClass,
      maxRetries: input.maxRetries,
      backoffSec: input.backoffSec,
    });
    this.missions.update(ownerId, input.missionId, {
      markers: {
        queue_entry_id: entry.id,
        queue_enqueue_key: entry.enqueue_key,
        queue_state: entry.queue_state,
      },
    });
    return entry;
  }

  listMissionQueue(
    ownerId: string,
    opts?: { states?: MissionQueueState[]; limit?: number },
  ) {
    this.assertOwner(ownerId);
    return this.missionQueue.list(ownerId, opts);
  }

  getMissionQueueEntry(ownerId: string, entryId: string) {
    this.assertOwner(ownerId);
    const e = this.missionQueue.get(ownerId, entryId);
    if (!e) throw new AuthError(`mission queue entry not found: ${entryId}`);
    return e;
  }

  updateMissionQueueEntry(
    ownerId: string,
    entryId: string,
    patch: {
      priority?: number;
      dependsOn?: string[];
      earliestStartAt?: string | null;
      scheduleUntilAt?: string | null;
      resourceClass?: string;
      maxRetries?: number;
      backoffSec?: number;
    },
  ) {
    this.assertOwner(ownerId);
    return this.missionQueue.update(ownerId, entryId, {
      priority: patch.priority,
      depends_on: patch.dependsOn,
      earliest_start_at: patch.earliestStartAt,
      schedule_until_at: patch.scheduleUntilAt,
      resource_class: patch.resourceClass,
      max_retries: patch.maxRetries,
      backoff_sec: patch.backoffSec,
    });
  }

  cancelMissionQueueEntry(ownerId: string, entryId: string, reason?: string) {
    this.assertOwner(ownerId);
    const entry = this.getMissionQueueEntry(ownerId, entryId);
    return this.cancelMissionProject(ownerId, entry.mission_id, reason);
  }

  cancelMissionProject(ownerId: string, missionId: string, reason?: string) {
    this.assertOwner(ownerId);
    const m = this.getMission(ownerId, missionId);
    if (m.status === "cancelled") {
      const entry = this.missionQueue.getByMissionId(ownerId, missionId);
      return { mission: m, queue_entry: entry };
    }
    if (m.status === "done") {
      const queueEntry = this.missionQueue.getByMissionId(ownerId, missionId);
      if (
        queueEntry &&
        queueEntry.queue_state !== "completed" &&
        queueEntry.queue_state !== "cancelled"
      ) {
        const reconciled = this.missionQueue.update(ownerId, queueEntry.id, {
          queue_state: "completed",
          claim_token: null,
          claimed_at: null,
          lease_until: null,
          blocker_code: null,
          blocker_detail: null,
        });
        return { mission: m, queue_entry: reconciled };
      }
      return { mission: m, queue_entry: queueEntry };
    }

    const contract = contractFromMission(m);
    const cancelJobs = contract?.cleanup?.cancel_active_jobs !== false;
    if (cancelJobs) {
      for (const jobId of m.linked_job_ids) {
        const job = this.store.getJob(jobId);
        if (job && !isTerminal(job.status)) {
          this.cancelTask(ownerId, jobId);
        }
      }
    }

    let queueEntry = this.missionQueue.getByMissionId(ownerId, missionId);
    const releaseLease = contract?.cleanup?.release_queue_lease !== false;
    if (
      releaseLease &&
      queueEntry &&
      queueEntry.queue_state !== "cancelled" &&
      queueEntry.queue_state !== "completed"
    ) {
      if (queueEntry.queue_state === "running" || queueEntry.claim_token) {
        queueEntry = this.missionQueue.releaseClaim(ownerId, queueEntry.id, {
          queue_state: "cancelled",
          blocker_code: "cancelled",
          blocker_detail: reason ?? "project cancelled",
        });
      } else {
        queueEntry = this.missionQueue.cancel(ownerId, queueEntry.id, reason);
      }
    }

    const updated = this.missions.update(ownerId, missionId, {
      status: "cancelled",
      markers: {
        project_active: false,
        supervision_state: null,
        current_step_id: null,
        supervision_next_run_at: null,
        supervision_wait_reason: null,
        block_reason: null,
        queue_state: "cancelled",
        queue_capacity_released: true,
        cancel_reason: reason ?? null,
      },
    });
    return { mission: updated, queue_entry: queueEntry };
  }

  rescheduleMissionQueueEntry(
    ownerId: string,
    entryId: string,
    input: {
      earliestStartAt?: string | null;
      scheduleUntilAt?: string | null;
      nextRunAt?: string | null;
      priority?: number;
    },
  ) {
    this.assertOwner(ownerId);
    const entry = this.missionQueue.update(ownerId, entryId, {
      earliest_start_at: input.earliestStartAt,
      schedule_until_at: input.scheduleUntilAt,
      next_run_at: input.nextRunAt,
      priority: input.priority,
      queue_state: "scheduled",
      blocker_code: null,
      blocker_detail: null,
    });
    return entry;
  }
}

export { AuthError };
