import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WorkerHub } from "../worker-hub.js";
import {
  getMacConnectivity,
  recoverMacServices,
  type ServiceRecoveryContext,
} from "../service-recovery.js";

const AgentSchema = z.enum(["mock", "cursor", "codex", "kimi"]);
const ConservationOverrideSchema = z
  .object({
    agent: z.enum(["codex", "cursor"]).optional(),
    model: z.string().max(200).optional(),
    reasoning_effort: z.enum(["minimal", "low", "medium", "high"]).optional(),
    task_class: z
      .enum([
        "lookup_triage",
        "research",
        "implementation",
        "verification",
        "high_risk",
      ])
      .optional(),
    note: z.string().max(500).optional(),
  })
  .optional();

function textResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

/**
 * ChatGPT coordination surface for local Codex + Cursor (Kimi retired for new work).
 * Direct workspaces those tools already have git access to — no per-repo wiring.
 */
export type RegisterToolsOptions = {
  repoRoot: string;
  relayPort: number;
  publicBaseUrl: string;
  workerLocalControlPort?: number;
};

export function registerTools(
  server: McpServer,
  hub: WorkerHub,
  defaultOwnerId: string,
  recovery?: RegisterToolsOptions,
): void {
  const recoveryCtx: ServiceRecoveryContext | undefined = recovery
    ? {
        repoRoot: recovery.repoRoot,
        relayPort: recovery.relayPort,
        publicBaseUrl: recovery.publicBaseUrl,
        ownerId: defaultOwnerId,
        workerLocalControlPort: recovery.workerLocalControlPort,
        hub,
      }
    : undefined;

  if (recoveryCtx) {
    server.tool(
      "get_mac_connectivity",
      "Relay-side health (no worker required): WebSocket link, local /healthz, LaunchAgent states. Call when tools fail with 'Mac worker is not connected' or before recover_mac_services.",
      {},
      { readOnlyHint: true },
      async () => textResult(await getMacConnectivity(recoveryCtx)),
    );

    server.tool(
      "recover_mac_services",
      "Restart Mac Ground Control processes via launchd so the worker reconnects. Runs on the relay — works when the worker socket is down. Default scope=worker (keeps this MCP session alive). scope=relay_and_worker only if the relay is broken (drops ChatGPT MCP until reconnect). scope=full_stack also kicks cloudflared/ngrok if installed.",
      {
        scope: z
          .enum(["worker", "relay_and_worker", "full_stack"])
          .optional()
          .describe("Default worker — safest during ChatGPT chat"),
        wait_for_worker_sec: z
          .number()
          .int()
          .min(5)
          .max(120)
          .optional()
          .describe("Seconds to wait for worker WebSocket after kick (default 45)"),
      },
      async (args) =>
        textResult(
          await recoverMacServices(recoveryCtx, {
            scope: args.scope,
            wait_for_worker_sec: args.wait_for_worker_sec,
          }),
        ),
    );
  }

  server.tool(
    "list_projects",
    "Discover workspaces under allowed_roots and list enabled agents (codex/cursor). Kimi is historical-only. Use workspace names when starting tasks.",
    {},
    async (_args, extra) => {
      const ownerId = ownerFromAuth(extra, defaultOwnerId);
      const result = await hub.request("list_projects", {}, ownerId);
      return textResult(result);
    },
  );

  server.tool(
    "list_tasks",
    "Check in on recent and in-flight agent jobs (status, workspace, agent, conservation metadata).",
    {
      limit: z.number().int().positive().max(100).optional(),
    },
    async (args, extra) => {
      const ownerId = ownerFromAuth(extra, defaultOwnerId);
      const result = await hub.request(
        "list_tasks",
        { limit: args.limit },
        ownerId,
      );
      return textResult(result);
    },
  );

  server.tool(
    "start_task",
    "Fire-and-forget managed job (one-shot CLI -p), NOT an interactive terminal. Prefer create_terminal_session for multi-turn / REPL work. Each agent has its own max_concurrent and rolling start budget (get_usage preflight). If the workspace already has a queued/running job, start_task fails busy unless idempotency_key retries the same logical attempt — durable mission supervision uses idempotency keys and queues the next step on the existing worker tick instead of occupying a second slot. Job lifecycle: queued → running → succeeded|failed|timed_out|cancelled (distinct from mission verifying/ready_for_review/done). Returns job id immediately; work continues on the Mac after this turn. notify_owner is only used for mission review/done flows, not per-job completion. For mock/demo only, pass project_id instead.",
    {
      agent: AgentSchema.describe(
        "codex or cursor for real local agents; kimi is rejected for new work; mock for isolation demo",
      ),
      prompt: z.string().min(1).max(20_000).describe("Instructions for the agent"),
      mission_id: z.string().uuid().optional().describe("Mission with the currently approved plan. Required for implementation when Advisor is enabled."),
      workspace: z
        .string()
        .min(1)
        .max(500)
        .optional()
        .describe(
          "Workspace folder name or path under allowed_roots. Required for cursor/codex.",
        ),
      project_id: z
        .string()
        .optional()
        .describe("Optional registered alias id (mock/demo only)"),
      idempotency_key: z.string().max(200).optional(),
      timeout_sec: z.number().int().positive().max(86_400).optional(),
      tier: z
        .enum([
          "research",
          "triage",
          "implement",
          "bugfix",
          "verification",
          "high_risk",
          "default",
        ])
        .optional()
        .describe(
          "Conservation routing: research/triage → lighter models; implement/bugfix → Codex writes; respects usage budgets.",
        ),
      model: z
        .string()
        .max(200)
        .optional()
        .describe("Optional model override; defaults come from usage policy"),
      conservation_override: ConservationOverrideSchema.describe(
        "Owner override for agent/model/reasoning/task class on this job",
      ),
    },
    async (args, extra) => {
      const ownerId = ownerFromAuth(extra, defaultOwnerId);
      const result = await hub.request(
        "start_task",
        {
          projectId: args.project_id,
          workspace: args.workspace,
          agent: args.agent,
          prompt: args.prompt,
          missionId: args.mission_id,
          idempotencyKey: args.idempotency_key,
          timeoutSec: args.timeout_sec,
          tier: args.tier,
          model: args.model,
          conservation_override: args.conservation_override,
        },
        ownerId,
      );
      return textResult(result);
    },
  );

  server.tool(
    "get_task",
    "Get status for a job you own. Use this to check progress.",
    { job_id: z.string().uuid() },
    async (args, extra) => {
      const ownerId = ownerFromAuth(extra, defaultOwnerId);
      const result = await hub.request("get_task", { jobId: args.job_id }, ownerId);
      return textResult(result);
    },
  );

  server.tool(
    "get_task_output",
    "Fetch bounded logs/summary/diff for a job. Best-effort redaction; anything returned is shared with OpenAI.",
    { job_id: z.string().uuid() },
    async (args, extra) => {
      const ownerId = ownerFromAuth(extra, defaultOwnerId);
      const result = await hub.request(
        "get_task_output",
        { jobId: args.job_id },
        ownerId,
      );
      return textResult(result);
    },
  );

  server.tool(
    "send_followup",
    "Send follow-up directions to a job. Queued until Cursor/Kimi can resume safely if a run is mid-flight.",
    {
      job_id: z.string().uuid(),
      message: z.string().min(1).max(20_000),
    },
    async (args, extra) => {
      const ownerId = ownerFromAuth(extra, defaultOwnerId);
      const result = await hub.request(
        "send_followup",
        { jobId: args.job_id, message: args.message },
        ownerId,
      );
      return textResult(result);
    },
  );

  server.tool(
    "cancel_task",
    "Cancel a managed Cursor/Kimi/mock job. Does not take over your personal terminal sessions.",
    { job_id: z.string().uuid() },
    async (args, extra) => {
      const ownerId = ownerFromAuth(extra, defaultOwnerId);
      const result = await hub.request("cancel_task", { jobId: args.job_id }, ownerId);
      return textResult(result);
    },
  );

  // --- Interactive terminal sessions (persistent PTY on the Mac) ---

  server.tool(
    "terminal_capabilities",
    "Report installed shell/cursor/codex binaries, verified model flags, Codex probe (version/auth, no secrets), supported control keys, and restart behavior for interactive sessions.",
    {},
    async (_args, extra) => {
      const ownerId = ownerFromAuth(extra, defaultOwnerId);
      const result = await hub.request("terminal_capabilities", {}, ownerId);
      return textResult(result);
    },
  );

  server.tool(
    "create_terminal_session",
    "PRIMARY tool for interactive control: start a persistent PTY on the Mac (shell, cursor, or codex) like a real terminal. Kimi sessions are disabled. Survives chat turns while the worker is up; dies on worker restart. Then write_terminal_input / read_terminal_output in a loop. workspace sets initial cwd under allowed_roots (not an OS sandbox).",
    {
      kind: z
        .enum(["shell", "cursor", "codex"])
        .describe("shell for ordinary commands; cursor/codex for interactive agent CLIs"),
      workspace: z
        .string()
        .min(1)
        .max(500)
        .describe("Workspace folder name or path under allowed_roots (initial cwd)"),
      model: z
        .string()
        .max(200)
        .optional()
        .describe(
          "Optional per-session model. Only applied if the installed CLI exposes a verified flag; does not change global defaults.",
        ),
      cols: z.number().int().positive().max(500).optional(),
      rows: z.number().int().positive().max(200).optional(),
      idle_sec: z
        .number()
        .int()
        .min(0)
        .max(86_400)
        .nullable()
        .optional()
        .describe("Idle auto-close seconds; null uses worker default; 0 disables"),
    },
    async (args, extra) => {
      const ownerId = ownerFromAuth(extra, defaultOwnerId);
      const result = await hub.request(
        "create_terminal_session",
        {
          kind: args.kind,
          workspace: args.workspace,
          model: args.model,
          cols: args.cols,
          rows: args.rows,
          idleSec: args.idle_sec,
        },
        ownerId,
      );
      return textResult(result);
    },
  );

  server.tool(
    "list_terminal_sessions",
    "List your interactive PTY sessions (id, kind, state, workspace). Reconnect by session id.",
    {},
    async (_args, extra) => {
      const ownerId = ownerFromAuth(extra, defaultOwnerId);
      const result = await hub.request("list_terminal_sessions", {}, ownerId);
      return textResult(result);
    },
  );

  server.tool(
    "get_terminal_session",
    "Get status for one of your interactive sessions (waiting|running|exited|error).",
    { session_id: z.string().uuid() },
    async (args, extra) => {
      const ownerId = ownerFromAuth(extra, defaultOwnerId);
      const result = await hub.request(
        "get_terminal_session",
        { sessionId: args.session_id },
        ownerId,
      );
      return textResult(result);
    },
  );

  server.tool(
    "read_terminal_output",
    "Read bounded PTY output with absolute byte cursor/offset. Credential patterns redacted best-effort. Call timeout is per-RPC, not a conversational kill.",
    {
      session_id: z.string().uuid(),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Absolute byte offset; omit to read from oldest retained byte"),
      max_bytes: z.number().int().positive().max(262_144).optional(),
    },
    async (args, extra) => {
      const ownerId = ownerFromAuth(extra, defaultOwnerId);
      const result = await hub.request(
        "read_terminal_output",
        {
          sessionId: args.session_id,
          offset: args.offset,
          maxBytes: args.max_bytes,
        },
        ownerId,
      );
      return textResult(result);
    },
  );

  server.tool(
    "write_terminal_input",
    "Write to a session PTY. Use data for typed text; keys for enter/ctrl-c/etc; submit=true appends Enter. Intentional shell input is user-authorized execution — launch metadata is never shell-interpolated.",
    {
      session_id: z.string().uuid(),
      data: z.string().max(100_000).optional(),
      keys: z
        .array(z.string().max(40))
        .max(20)
        .optional()
        .describe("Control keys e.g. enter, ctrl-c, tab, backspace"),
      submit: z
        .boolean()
        .optional()
        .describe("If true, append Enter (CR) after data/keys"),
    },
    async (args, extra) => {
      const ownerId = ownerFromAuth(extra, defaultOwnerId);
      const result = await hub.request(
        "write_terminal_input",
        {
          sessionId: args.session_id,
          data: args.data,
          keys: args.keys,
          submit: args.submit,
        },
        ownerId,
      );
      return textResult(result);
    },
  );

  server.tool(
    "resize_terminal_session",
    "Resize an interactive PTY (cols/rows).",
    {
      session_id: z.string().uuid(),
      cols: z.number().int().positive().max(500),
      rows: z.number().int().positive().max(200),
    },
    async (args, extra) => {
      const ownerId = ownerFromAuth(extra, defaultOwnerId);
      const result = await hub.request(
        "resize_terminal_session",
        { sessionId: args.session_id, cols: args.cols, rows: args.rows },
        ownerId,
      );
      return textResult(result);
    },
  );

  server.tool(
    "interrupt_terminal_session",
    "Send Ctrl-C to an interactive session.",
    { session_id: z.string().uuid() },
    async (args, extra) => {
      const ownerId = ownerFromAuth(extra, defaultOwnerId);
      const result = await hub.request(
        "interrupt_terminal_session",
        { sessionId: args.session_id },
        ownerId,
      );
      return textResult(result);
    },
  );

  server.tool(
    "close_terminal_session",
    "Close and cleanup an interactive PTY session you own.",
    { session_id: z.string().uuid() },
    async (args, extra) => {
      const ownerId = ownerFromAuth(extra, defaultOwnerId);
      const result = await hub.request(
        "close_terminal_session",
        { sessionId: args.session_id },
        ownerId,
      );
      return textResult(result);
    },
  );

  // --- Situational awareness, local approvals, browser ---

  server.tool(
    "get_situation",
    "PRIMARY awareness tool: snapshot of active/recent jobs, interactive terminal sessions with output tails, local approvals, and approval_policy (hybrid_remote + owner_control_mode/markers for Mac vs routine routing). Call before acting or when re-orienting mid-thread.",
    {
      tail_bytes: z
        .number()
        .int()
        .positive()
        .max(32_768)
        .optional()
        .describe("Bytes of PTY tail per session (default 4096)"),
      task_limit: z.number().int().positive().max(40).optional(),
    },
    async (args, extra) => {
      const ownerId = ownerFromAuth(extra, defaultOwnerId);
      const result = await hub.request(
        "get_situation",
        { tail_bytes: args.tail_bytes, task_limit: args.task_limit },
        ownerId,
      );
      return textResult(result);
    },
  );

  server.tool(
    "request_local_approval",
    "Mac Approve/Deny dialog for sensitive actions only (hybrid_remote + Owner Control): destructive deletion, financial actions, external representational sends, credentials/access/permission changes, ambiguous irreversible work, or when the owner asks to approve locally. Do NOT use for routine read/code/test/terminal/build/restart/deploy/self-repair authorized by the authenticated owner in chat — those are logged without duplicate Mac dialogs. wait=true blocks until dialog gives up (approval may stay pending); wait=false returns pending for menu-bar resolve.",
    {
      kind: z
        .enum(["browser_open", "permission", "general", "destructive"])
        .describe("Category shown on the Mac dialog"),
      title: z.string().min(1).max(200),
      detail: z
        .string()
        .min(1)
        .max(4000)
        .describe("What you want to do and why"),
      timeout_sec: z.number().int().positive().max(600).optional(),
      wait: z.boolean().optional(),
    },
    async (args, extra) => {
      const ownerId = ownerFromAuth(extra, defaultOwnerId);
      const waitMs = ((args.timeout_sec ?? 120) + 30) * 1000;
      const result = await hub.request(
        "request_local_approval",
        {
          kind: args.kind,
          title: args.title,
          detail: args.detail,
          timeoutSec: args.timeout_sec,
          wait: args.wait,
        },
        ownerId,
        args.wait === false ? 30_000 : waitMs,
      );
      return textResult(result);
    },
  );

  server.tool(
    "list_approvals",
    "List pending (and optionally recent resolved) local approvals.",
    {
      include_resolved: z.boolean().optional(),
      limit: z.number().int().positive().max(50).optional(),
    },
    async (args, extra) => {
      const ownerId = ownerFromAuth(extra, defaultOwnerId);
      const result = await hub.request(
        "list_approvals",
        {
          includeResolved: args.include_resolved,
          limit: args.limit,
        },
        ownerId,
      );
      return textResult(result);
    },
  );

  server.tool(
    "get_approval",
    "Get one local approval by id.",
    { approval_id: z.string().uuid() },
    async (args, extra) => {
      const ownerId = ownerFromAuth(extra, defaultOwnerId);
      const result = await hub.request(
        "get_approval",
        { approvalId: args.approval_id },
        ownerId,
      );
      return textResult(result);
    },
  );

  server.tool(
    "notify_owner",
    "Show a non-blocking macOS notification banner on the owner's Mac (no Approve/Deny).",
    {
      title: z.string().min(1).max(80),
      body: z.string().min(1).max(240),
    },
    async (args, extra) => {
      const ownerId = ownerFromAuth(extra, defaultOwnerId);
      const result = await hub.request(
        "notify_owner",
        { title: args.title, body: args.body },
        ownerId,
      );
      return textResult(result);
    },
  );

  server.tool(
    "open_url",
    "Open an http(s) URL in the owner's default browser on the Mac. By default shows a local Approve/Deny dialog first. Returns whether it was approved and opened.",
    {
      url: z.string().url().max(2000),
      title: z.string().max(200).optional(),
      require_approval: z
        .boolean()
        .optional()
        .describe("Default true — Mac dialog before open"),
      wait: z.boolean().optional(),
    },
    async (args, extra) => {
      const ownerId = ownerFromAuth(extra, defaultOwnerId);
      const waitMs = 150_000;
      const result = await hub.request(
        "open_url",
        {
          url: args.url,
          title: args.title,
          requireApproval: args.require_approval,
          wait: args.wait,
        },
        ownerId,
        args.wait === false || args.require_approval === false ? 30_000 : waitMs,
      );
      return textResult(result);
    },
  );

  // --- Missions (orchestrated work: research → plan → approve → ship) ---

  const MissionStatusSchema = z.enum([
    "intake",
    "researching",
    "plan_ready",
    "approved",
    "implementing",
    "verifying",
    "ready_for_review",
    "done",
    "blocked",
    "cancelled",
  ]);

  server.tool(
    "create_mission",
    "Start an orchestrated mission on the Mac whiteboard. Typical flow: research → plan_ready → approve_mission → implementing/verifying. With supervisor.enabled and mission_contract_json markers, bounded stages advance on the worker without further chat. Finish with submit_mission_review (ready_for_review queue — does not block other jobs) then complete_mission only after explicit owner release. complete_mission alone does not deploy or merge to main.",
    {
      title: z.string().min(1).max(200),
      goal: z.string().min(1).max(20_000),
      workspace: z
        .string()
        .max(500)
        .optional()
        .describe("Default workspace for Cursor/Kimi (e.g. partha-work)"),
      markers: z
        .record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
        .optional()
        .describe("Status chips / KPIs shown on the whiteboard"),
    },
    async (args, extra) => {
      const ownerId = ownerFromAuth(extra, defaultOwnerId);
      const result = await hub.request(
        "create_mission",
        {
          title: args.title,
          goal: args.goal,
          workspace: args.workspace,
          markers: args.markers,
        },
        ownerId,
      );
      return textResult(result);
    },
  );

  server.tool(
    "list_missions",
    "List missions (newest first). Filter by status for the whiteboard columns.",
    {
      status: MissionStatusSchema.optional(),
      limit: z.number().int().positive().max(100).optional(),
    },
    async (args, extra) => {
      const ownerId = ownerFromAuth(extra, defaultOwnerId);
      const result = await hub.request(
        "list_missions",
        { status: args.status, limit: args.limit },
        ownerId,
      );
      return textResult(result);
    },
  );

  server.tool(
    "get_mission",
    "Get one mission including plan, findings, linked jobs/sessions, markers.",
    { mission_id: z.string().uuid() },
    async (args, extra) => {
      const ownerId = ownerFromAuth(extra, defaultOwnerId);
      const result = await hub.request(
        "get_mission",
        { missionId: args.mission_id },
        ownerId,
      );
      return textResult(result);
    },
  );

  server.tool(
    "update_mission",
    "Update mission fields/status/findings/plan/markers, or link a job_id / session_id. Use status researching|plan_ready|implementing|verifying|blocked as you progress.",
    {
      mission_id: z.string().uuid(),
      title: z.string().max(200).optional(),
      goal: z.string().max(20_000).optional(),
      workspace: z.string().max(500).nullable().optional(),
      status: MissionStatusSchema.optional(),
      plan: z.string().max(50_000).nullable().optional(),
      findings: z.string().max(50_000).nullable().optional(),
      summary: z.string().max(20_000).nullable().optional(),
      markers: z
        .record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
        .optional(),
      link_job_id: z.string().uuid().optional(),
      link_session_id: z.string().uuid().optional(),
    },
    async (args, extra) => {
      const ownerId = ownerFromAuth(extra, defaultOwnerId);
      const result = await hub.request(
        "update_mission",
        {
          missionId: args.mission_id,
          title: args.title,
          goal: args.goal,
          workspace: args.workspace,
          status: args.status,
          plan: args.plan,
          findings: args.findings,
          summary: args.summary,
          markers: args.markers,
          linkJobId: args.link_job_id,
          linkSessionId: args.link_session_id,
        },
        ownerId,
      );
      return textResult(result);
    },
  );

  server.tool(
    "submit_mission_plan",
    "Submit or revise a mission plan for human review. Increments the plan revision, invalidates any older approval, moves the mission to plan_ready, and sends the owner an 'All good?' notification.",
    {
      mission_id: z.string().uuid(),
      plan: z.string().min(1).max(50_000),
      findings: z.string().max(50_000).optional(),
      notify: z.boolean().optional(),
    },
    async (args, extra) => {
      const ownerId = ownerFromAuth(extra, defaultOwnerId);
      const result = await hub.request(
        "submit_mission_plan",
        {
          missionId: args.mission_id,
          plan: args.plan,
          findings: args.findings,
          notify: args.notify,
        },
        ownerId,
      );
      return textResult(result);
    },
  );

  server.tool(
    "approve_mission",
    "Record mission plan approval (hybrid_remote). After showing the plan in chat: use authorization=chat_explicit when the owner clearly consents in this thread (no Mac dialog; sets approval_source=chat_explicit, approval_policy=hybrid_remote, bounded approved_scope). Use require_dialog=true or authorization=local_dialog when the owner asks to approve on the Mac. Do not re-call if the mission is already approved for routine scope. Never use this to bypass sensitive-action Mac confirmation.",
    {
      mission_id: z.string().uuid(),
      note: z.string().max(2000).optional(),
      require_dialog: z
        .boolean()
        .optional()
        .describe("Force Mac Approve/Deny dialog (approve locally)"),
      authorization: z
        .enum(["chat_explicit", "local_dialog"])
        .optional()
        .describe("chat_explicit = owner consented in ChatGPT; local_dialog = Mac dialog"),
      approved_scope: z
        .string()
        .max(120)
        .optional()
        .describe("Bounded routine scope (default read_code_test_terminal)"),
    },
    async (args, extra) => {
      const ownerId = ownerFromAuth(extra, defaultOwnerId);
      const result = await hub.request(
        "approve_mission",
        {
          missionId: args.mission_id,
          note: args.note,
          requireDialog: args.require_dialog,
          authorization: args.authorization,
          approvedScope: args.approved_scope,
        },
        ownerId,
        args.require_dialog || args.authorization === "local_dialog" ? 150_000 : 30_000,
      );
      return textResult(result);
    },
  );

  server.tool(
    "submit_mission_review",
    "Stage a finished implementation for owner review (status ready_for_review). Fail-closed gates: contract steps complete, linked succeeded jobs, evidence_git_head matches workspace when required, review_packet_version set, usability QA job markers when completion_requires_usability. On failure sets blocked + block_reason. Optional notify_owner banner; does not push/merge/deploy.",
    {
      mission_id: z.string().uuid(),
      summary: z.string().min(1).max(20_000),
      review_packet_version: z.number().int().positive().optional(),
      markers: z
        .record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
        .optional(),
      notify: z.boolean().optional(),
    },
    async (args, extra) => {
      const ownerId = ownerFromAuth(extra, defaultOwnerId);
      const result = await hub.request(
        "submit_mission_review",
        {
          missionId: args.mission_id,
          summary: args.summary,
          reviewPacketVersion: args.review_packet_version,
          markers: args.markers,
          notify: args.notify,
        },
        ownerId,
      );
      return textResult(result);
    },
  );

  server.tool(
    "enqueue_mission_project",
    "Enqueue an approved mission on Ground's durable project queue (idempotent enqueue_key). Persists priority, FIFO order, dependencies, schedule windows, and resource class. The worker scheduler claims entries atomically, respects per-agent concurrency via start_task/get_usage, advances supervised steps without chat nudges, and stops at ready_for_review (review does not hold execution slots).",
    {
      mission_id: z.string().uuid(),
      enqueue_key: z.string().min(1).max(120),
      priority: z.number().int().min(-100).max(100).optional(),
      depends_on: z.array(z.string().uuid()).optional(),
      earliest_start_at: z.string().optional(),
      schedule_until_at: z.string().optional(),
      resource_class: z.string().max(40).optional(),
      max_retries: z.number().int().min(0).max(10).optional(),
      backoff_sec: z.number().int().min(0).max(3600).optional(),
    },
    async (args, extra) => {
      const ownerId = ownerFromAuth(extra, defaultOwnerId);
      const result = await hub.request(
        "enqueue_mission_project",
        {
          missionId: args.mission_id,
          enqueueKey: args.enqueue_key,
          priority: args.priority,
          dependsOn: args.depends_on,
          earliestStartAt: args.earliest_start_at,
          scheduleUntilAt: args.schedule_until_at,
          resourceClass: args.resource_class,
          maxRetries: args.max_retries,
          backoffSec: args.backoff_sec,
        },
        ownerId,
      );
      return textResult(result);
    },
  );

  server.tool(
    "list_mission_queue",
    "List Ground mission queue entries (priority/FIFO order) with queue_state, blockers, and next_run_at.",
    {
      states: z
        .array(
          z.enum([
            "queued",
            "scheduled",
            "running",
            "blocked",
            "verifying",
            "ready_for_review",
            "completed",
            "cancelled",
          ]),
        )
        .optional(),
      limit: z.number().int().positive().max(100).optional(),
    },
    async (args, extra) => {
      const ownerId = ownerFromAuth(extra, defaultOwnerId);
      const result = await hub.request(
        "list_mission_queue",
        { states: args.states, limit: args.limit },
        ownerId,
      );
      return textResult(result);
    },
  );

  server.tool(
    "update_mission_queue_entry",
    "Update queue metadata (priority, dependencies, schedule window, retries) for a queued/blocked entry.",
    {
      entry_id: z.string().uuid(),
      priority: z.number().int().min(-100).max(100).optional(),
      depends_on: z.array(z.string().uuid()).optional(),
      earliest_start_at: z.string().nullable().optional(),
      schedule_until_at: z.string().nullable().optional(),
      resource_class: z.string().max(40).optional(),
      max_retries: z.number().int().min(0).max(10).optional(),
      backoff_sec: z.number().int().min(0).max(3600).optional(),
    },
    async (args, extra) => {
      const ownerId = ownerFromAuth(extra, defaultOwnerId);
      const result = await hub.request(
        "update_mission_queue_entry",
        {
          entryId: args.entry_id,
          priority: args.priority,
          dependsOn: args.depends_on,
          earliestStartAt: args.earliest_start_at,
          scheduleUntilAt: args.schedule_until_at,
          resourceClass: args.resource_class,
          maxRetries: args.max_retries,
          backoffSec: args.backoff_sec,
        },
        ownerId,
      );
      return textResult(result);
    },
  );

  server.tool(
    "cancel_mission_queue_entry",
    "Cancel a supervised project by queue entry id (cascades jobs, queue lease, and mission status).",
    {
      entry_id: z.string().uuid(),
      reason: z.string().max(500).optional(),
    },
    async (args, extra) => {
      const ownerId = ownerFromAuth(extra, defaultOwnerId);
      const result = await hub.request(
        "cancel_mission_queue_entry",
        { entryId: args.entry_id, reason: args.reason },
        ownerId,
      );
      return textResult(result);
    },
  );

  server.tool(
    "cancel_mission_project",
    "Cancel a supervised project by mission id: stop active jobs, release queue capacity, clear supervision, mark mission cancelled.",
    {
      mission_id: z.string().uuid(),
      reason: z.string().max(500).optional(),
    },
    async (args, extra) => {
      const ownerId = ownerFromAuth(extra, defaultOwnerId);
      const result = await hub.request(
        "cancel_mission_project",
        { missionId: args.mission_id, reason: args.reason },
        ownerId,
      );
      return textResult(result);
    },
  );

  server.tool(
    "reschedule_mission_queue_entry",
    "Reschedule a queue entry (earliest_start, schedule_until, next_run_at, priority).",
    {
      entry_id: z.string().uuid(),
      earliest_start_at: z.string().nullable().optional(),
      schedule_until_at: z.string().nullable().optional(),
      next_run_at: z.string().nullable().optional(),
      priority: z.number().int().min(-100).max(100).optional(),
    },
    async (args, extra) => {
      const ownerId = ownerFromAuth(extra, defaultOwnerId);
      const result = await hub.request(
        "reschedule_mission_queue_entry",
        {
          entryId: args.entry_id,
          earliestStartAt: args.earliest_start_at,
          scheduleUntilAt: args.schedule_until_at,
          nextRunAt: args.next_run_at,
          priority: args.priority,
        },
        ownerId,
      );
      return textResult(result);
    },
  );

  server.tool(
    "complete_mission",
    "Mark mission done after owner release. Contract missions must be ready_for_review and pass the same evidence gates; set owner_release_authorized=true only after explicit owner consent to ship. Sets summary + markers and optional notify_owner banner.",
    {
      mission_id: z.string().uuid(),
      summary: z.string().min(1).max(20_000),
      markers: z
        .record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
        .optional(),
      notify: z.boolean().optional(),
      owner_release_authorized: z
        .boolean()
        .optional()
        .describe("Required for contract missions — explicit post-review ship consent"),
    },
    async (args, extra) => {
      const ownerId = ownerFromAuth(extra, defaultOwnerId);
      const result = await hub.request(
        "complete_mission",
        {
          missionId: args.mission_id,
          summary: args.summary,
          markers: args.markers,
          notify: args.notify,
          ownerReleaseAuthorized: args.owner_release_authorized,
        },
        ownerId,
      );
      return textResult(result);
    },
  );

  // --- Usage budgets + client bugfix / update drafts ---

  server.tool(
    "list_events",
    "Read the Ground Life Mirror event spine: normalized facts (missions/jobs/approvals lifecycle) newest first. References + metadata only — no prompts, bodies, or logs are ever stored. Private events (jobs/approvals) are excluded unless include_private=true.",
    {
      limit: z.number().int().positive().max(500).optional(),
      since: z
        .string()
        .optional()
        .describe("ISO timestamp; only events at/after it"),
      source: z
        .string()
        .optional()
        .describe("missions | jobs | approvals | sessions | usage | ..."),
      verb: z
        .string()
        .optional()
        .describe("e.g. mission.created, job.status_changed, approval.resolved"),
      include_private: z.boolean().optional(),
    },
    { readOnlyHint: true },
    async (args, extra) => {
      const ownerId = ownerFromAuth(extra, defaultOwnerId);
      const result = await hub.request(
        "list_events",
        {
          limit: args.limit,
          since: args.since,
          source: args.source,
          verb: args.verb,
          includePrivate: args.include_private,
        },
        ownerId,
      );
      return textResult(result);
    },
  );

  server.tool(
    "get_usage",
    "Credit/rate-window snapshot for Cursor + Kimi (starts left in rolling window, cooldowns, queued bugfixes). Call before kicking off batches — especially Kimi (5h window).",
    {},
    async (_args, extra) => {
      const ownerId = ownerFromAuth(extra, defaultOwnerId);
      const result = await hub.request("get_usage", {}, ownerId);
      return textResult(result);
    },
  );

  server.tool(
    "ingest_client_request",
    "Queue a client bug/email for Kimi (Far Beyond, Currency, or inbox). Creates a mission card. Then call run_next_bugfix when budget allows.",
    {
      client: z
        .string()
        .min(1)
        .describe("far-beyond | currency | inbox (or alias)"),
      subject: z.string().min(1).max(500),
      body: z.string().min(1).max(50_000),
      from_email: z.string().max(320).optional(),
    },
    async (args, extra) => {
      const ownerId = ownerFromAuth(extra, defaultOwnerId);
      const result = await hub.request(
        "ingest_client_request",
        {
          client: args.client,
          subject: args.subject,
          body: args.body,
          fromEmail: args.from_email,
        },
        ownerId,
      );
      return textResult(result);
    },
  );

  server.tool(
    "list_client_requests",
    "List queued/in-progress/done client bugfix requests.",
    {
      client_id: z.string().optional(),
      status: z
        .enum(["queued", "in_progress", "done", "deferred", "cancelled"])
        .optional(),
      limit: z.number().int().positive().max(100).optional(),
    },
    async (args, extra) => {
      const ownerId = ownerFromAuth(extra, defaultOwnerId);
      const result = await hub.request(
        "list_client_requests",
        {
          clientId: args.client_id,
          status: args.status,
          limit: args.limit,
        },
        ownerId,
      );
      return textResult(result);
    },
  );

  server.tool(
    "run_next_bugfix",
    "Start the oldest queued client bugfix on Kimi if the 5h usage budget allows. Returns started=false + retry_after_sec when paced.",
    {},
    async (_args, extra) => {
      const ownerId = ownerFromAuth(extra, defaultOwnerId);
      const result = await hub.request("run_next_bugfix", {}, ownerId);
      return textResult(result);
    },
  );

  server.tool(
    "draft_client_update",
    "Draft a client update email from completed bugfixes since a time (default last 24h). Writes a markdown draft on the Mac — does NOT send.",
    {
      client: z.string().min(1),
      since_iso: z
        .string()
        .optional()
        .describe("ISO timestamp; default = 24h ago"),
    },
    async (args, extra) => {
      const ownerId = ownerFromAuth(extra, defaultOwnerId);
      const result = await hub.request(
        "draft_client_update",
        { client: args.client, sinceIso: args.since_iso },
        ownerId,
      );
      return textResult(result);
    },
  );
}

function ownerFromAuth(
  extra: { authInfo?: { extra?: Record<string, unknown>; clientId?: string } },
  fallback: string,
): string {
  const fromToken = extra.authInfo?.extra?.owner_id;
  if (typeof fromToken === "string" && fromToken.length > 0) return fromToken;
  return fallback;
}
