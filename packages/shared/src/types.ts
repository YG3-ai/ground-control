export type AgentKind = "mock" | "cursor" | "kimi" | "codex";

export type JobStatus =
  | "queued"
  | "preparing"
  | "running"
  | "awaiting_followup"
  | "cancelling"
  | "cancelled"
  | "succeeded"
  | "failed"
  | "timed_out";

export interface ProjectPermissions {
  network: "none" | string;
  git_write: boolean;
  max_runtime_sec: number;
}

/** Optional named aliases (mainly for mock/isolated demos). */
export interface ProjectConfig {
  id: string;
  name: string;
  description?: string;
  source_path: string;
  allowed_agents: AgentKind[];
  permissions: ProjectPermissions;
  credentials: string[];
}

export type WorkTier =
  | "research"
  | "triage"
  | "implement"
  | "bugfix"
  | "verification"
  | "high_risk"
  | "default";

export interface AgentUsageConfig {
  /** Rolling window seconds (Kimi ≈ 18000 = 5h). */
  window_sec?: number;
  max_starts_per_window?: number;
  min_gap_sec?: number;
  max_concurrent?: number;
  default_model?: string;
  research_model?: string;
  implement_model?: string;
  /** Cursor only: --mode ask|plan for research/triage. */
  research_mode?: "ask" | "plan";
  /** Codex only: default reasoning effort override via -c model_reasoning_effort */
  default_reasoning_effort?: "minimal" | "low" | "medium" | "high";
  cooldown_after_rate_limit_sec?: number;
}

export interface AgentConfig {
  enabled: boolean;
  adapter: AgentKind;
  /** Host binary name or absolute path (cursor/kimi/codex host mode). */
  binary?: string;
  notes?: string;
  /** Credit / rate-window guards + default models. */
  usage?: AgentUsageConfig;
}

/** Clients whose email bugs Kimi should triage (Far Beyond, Currency, …). */
export interface ClientConfig {
  id: string;
  name: string;
  /** Workspace under allowed_roots for bugfix agent. */
  workspace: string;
  aliases?: string[];
  /** Optional email address for drafted updates. */
  update_to?: string;
}

export interface AppConfig {
  owner: {
    id: string;
    display_name: string;
  };
  relay: {
    url: string;
  };
  worker: {
    data_dir: string;
    policy_dir: string;
    max_output_bytes: number;
    default_timeout_sec: number;
    /**
     * host = run Cursor/Kimi as managed local CLIs in real workspaces
     *        (they keep their normal git/codebase access).
     * docker = isolated containers (mock / strict mode).
     */
    agent_execution: "host" | "docker";
    /** Directories ChatGPT may target via workspace name/path. */
    allowed_roots: string[];
    /** Interactive PTY sessions (survive chat turns; die on worker restart). */
    terminal_sessions?: {
      /** Idle close after N seconds of no read/write (default 3600). 0 = never. */
      default_idle_sec?: number;
      default_cols?: number;
      default_rows?: number;
    };
    /**
     * Local Mac control: approvals dialogs, menu-bar HTTP, browser open.
     * Loopback only — never exposed via the public relay URL.
     */
    local_control?: {
      enabled?: boolean;
      bind?: string;
      port?: number;
      browser_requires_approval?: boolean;
      approval_timeout_sec?: number;
      approval_pending_expiry_sec?: number;
      /** permanent = authenticated ChatGPT owner authorizes routine Mac work without duplicate dialogs */
      owner_control_mode?: "permanent" | "off";
    };
    isolation: {
      backend: "docker" | "mock-fail";
      image: string;
      network: string;
      run_as_user: string;
      read_only_rootfs: boolean;
      memory_mb: number;
      cpus: number;
    };
    /** Token conservation routing for start_task + mission supervisor. */
    conservation?: Record<string, unknown>;
  };
  /** @deprecated Use advisor. Retained for existing config files. */
  supervisor: {
    enabled: boolean;
    poll_missions_sec?: number;
    default_max_step_retries?: number;
    /** Max missions the queue may run concurrently (review/verify do not hold slots). */
    queue_max_concurrent?: number;
    /** Lease for a running queue claim before stale recovery re-queues. */
    queue_claim_lease_sec?: number;
    /** When true, queue tick may call submit_mission_review after evidence gates pass. */
    queue_auto_review?: boolean;
    /** Stop a running supervised job when it has produced no output for this interval. */
    job_stale_sec?: number;
    /** Repeated connection-retry messages that make a job unavailable. */
    connection_retry_limit?: number;
  };
  advisor?: {
    enabled: boolean;
    poll_missions_sec?: number;
    default_max_step_retries?: number;
    queue_max_concurrent?: number;
    queue_claim_lease_sec?: number;
    queue_auto_review?: boolean;
    job_stale_sec?: number;
    connection_retry_limit?: number;
  };
  agents: Record<string, AgentConfig>;
  /** Client roster for bugfix + update-email drafts. */
  clients?: ClientConfig[];
  projects: ProjectConfig[];
}

export interface JobRecord {
  id: string;
  owner_id: string;
  project_id: string;
  agent: AgentKind;
  mission_id: string | null;
  prompt: string;
  tier: WorkTier;
  model: string | null;
  cursor_mode: "ask" | "plan" | null;
  status: JobStatus;
  idempotency_key: string | null;
  session_id: string | null;
  work_path: string | null;
  container_id: string | null;
  exit_code: number | null;
  error: string | null;
  summary: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  timeout_sec: number;
  /** JSON conservation / usage metadata for job detail UI. */
  execution_meta?: string | null;
}

export interface FollowupRecord {
  id: string;
  job_id: string;
  message: string;
  status: "queued" | "delivered" | "failed";
  created_at: string;
  delivered_at: string | null;
}

export interface StartTaskInput {
  ownerId: string;
  agent: AgentKind;
  prompt: string;
  /** Mission supplying the approved plan and durable context packet. */
  missionId?: string;
  /** Workspace name or path under allowed_roots (cursor/kimi/codex). */
  workspace?: string;
  /** Optional registered project id (mock / aliases). */
  projectId?: string;
  idempotencyKey?: string;
  timeoutSec?: number;
  /** research|triage|implement|bugfix — picks cheaper models + modes. */
  tier?: WorkTier;
  /** Explicit model override (still subject to usage pacing). */
  model?: string;
  /** Owner override: force agent/model/reasoning for this job. */
  conservation_override?: {
    agent?: "codex" | "cursor";
    model?: string;
    reasoning_effort?: "minimal" | "low" | "medium" | "high";
    task_class?:
      | "lookup_triage"
      | "research"
      | "implementation"
      | "verification"
      | "high_risk";
    note?: string;
  };
}

export interface TaskView {
  id: string;
  owner_id: string;
  project_id: string;
  agent: AgentKind;
  mission_id: string | null;
  tier: WorkTier;
  status: JobStatus;
  summary: string | null;
  error: string | null;
  exit_code: number | null;
  session_id: string | null;
  work_path: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  followups_queued: number;
  conservation?: Record<string, unknown> | null;
}

export interface TaskOutputView {
  job_id: string;
  status: JobStatus;
  logs: string;
  truncated: boolean;
  redaction_note: string;
  summary: string | null;
  diff: string | null;
  test_results: string | null;
}

/** Interactive terminal session (PTY) — separate from managed one-shot jobs. */
export type TerminalSessionKind = "shell" | "cursor" | "kimi" | "codex";

export type TerminalSessionState =
  | "waiting"
  | "running"
  | "exited"
  | "error";

/** Wire protocol: ChatGPT MCP <-> relay <-> worker */
export type WorkerMessage =
  | { type: "hello"; worker_id: string; token: string }
  | { type: "heartbeat"; worker_id: string }
  | { type: "job_update"; job: TaskView }
  | { type: "ack"; request_id: string; ok: true; result?: unknown }
  | { type: "ack"; request_id: string; ok: false; error: string };

export type WorkerRpcMethod =
  | "list_projects"
  | "list_tasks"
  | "start_task"
  | "get_task"
  | "get_task_output"
  | "send_followup"
  | "cancel_task"
  | "create_terminal_session"
  | "list_terminal_sessions"
  | "get_terminal_session"
  | "read_terminal_output"
  | "write_terminal_input"
  | "resize_terminal_session"
  | "interrupt_terminal_session"
  | "close_terminal_session"
  | "terminal_capabilities"
  | "get_situation"
  | "request_local_approval"
  | "list_approvals"
  | "get_approval"
  | "resolve_approval"
  | "notify_owner"
  | "open_url"
  | "create_mission"
  | "list_missions"
  | "get_mission"
  | "update_mission"
  | "submit_mission_plan"
  | "approve_mission"
  | "complete_mission"
  | "get_mission_timeline"
  | "record_mission_deployment"
  | "submit_mission_review"
  | "enqueue_mission_project"
  | "update_mission_queue_entry"
  | "cancel_mission_queue_entry"
  | "cancel_mission_project"
  | "reschedule_mission_queue_entry"
  | "list_mission_queue"
  | "get_usage"
  | "list_events"
  | "rebuild_events"
  | "ingest_client_request"
  | "list_client_requests"
  | "draft_client_update"
  | "run_next_bugfix"
  | "list_meaning_candidates"
  | "get_meaning_candidate"
  | "meaning_summary"
  | "decide_meaning_candidate"
  | "get_board"
  | "world_summary"
  | "list_world_entities"
  | "get_world_entity";

export type RelayToWorkerMessage =
  | {
      type: "request";
      request_id: string;
      method: WorkerRpcMethod;
      params: Record<string, unknown>;
      owner_id: string;
    }
  | { type: "ping" };
