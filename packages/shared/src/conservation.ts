import type {
  AgentKind,
  AgentUsageConfig,
  AppConfig,
  WorkTier,
} from "./types.js";
import { isAgentEnabled } from "./config.js";

export type TaskClass =
  | "lookup_triage"
  | "research"
  | "implementation"
  | "verification"
  | "high_risk";

export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

export type ConservationAgent = "codex" | "cursor";

export type StageLimits = {
  max_context_chars: number;
  max_output_chars: number;
  max_tool_calls: number;
  max_retries: number;
  max_elapsed_sec: number;
};

export type ClassRoute = {
  preferred_agent: ConservationAgent;
  /** Which field on agent usage config supplies the model when model is omitted. */
  model_from: "research_model" | "implement_model" | "default_model";
  reasoning_effort: ReasoningEffort;
  limits: StageLimits;
};

export type ConservationConfig = {
  enabled: boolean;
  classes: Record<TaskClass, ClassRoute>;
  /** When preferred agent unavailable, try this order (never includes kimi). */
  agent_fallback_order: ConservationAgent[];
};

export type ConservationOwnerOverride = {
  agent?: ConservationAgent;
  model?: string;
  reasoning_effort?: ReasoningEffort;
  task_class?: TaskClass;
  note?: string;
};

export type ConservationPlan = {
  task_class: TaskClass;
  agent: AgentKind;
  model: string | null;
  reasoning_effort: ReasoningEffort;
  cursor_mode: "ask" | "plan" | null;
  limits: StageLimits;
  escalation_required: boolean;
  escalation_reason: string | null;
  budget_label: "actual" | "estimate";
  tokens_used: number | null;
  tokens_budget: number | null;
  owner_override_applied: boolean;
};

export const DEFAULT_CONSERVATION_LIMITS: StageLimits = {
  max_context_chars: 24_000,
  max_output_chars: 12_000,
  max_tool_calls: 40,
  max_retries: 2,
  max_elapsed_sec: 900,
};

export const DEFAULT_CONSERVATION_CONFIG: ConservationConfig = {
  enabled: true,
  agent_fallback_order: ["codex", "cursor"],
  classes: {
    lookup_triage: {
      preferred_agent: "codex",
      model_from: "research_model",
      reasoning_effort: "low",
      limits: {
        max_context_chars: 8_000,
        max_output_chars: 4_000,
        max_tool_calls: 12,
        max_retries: 1,
        max_elapsed_sec: 300,
      },
    },
    research: {
      preferred_agent: "cursor",
      model_from: "research_model",
      reasoning_effort: "low",
      limits: {
        max_context_chars: 16_000,
        max_output_chars: 8_000,
        max_tool_calls: 24,
        max_retries: 1,
        max_elapsed_sec: 600,
      },
    },
    implementation: {
      preferred_agent: "codex",
      model_from: "implement_model",
      reasoning_effort: "medium",
      limits: {
        max_context_chars: 32_000,
        max_output_chars: 16_000,
        max_tool_calls: 60,
        max_retries: 2,
        max_elapsed_sec: 1800,
      },
    },
    verification: {
      preferred_agent: "codex",
      model_from: "research_model",
      reasoning_effort: "low",
      limits: {
        max_context_chars: 12_000,
        max_output_chars: 6_000,
        max_tool_calls: 20,
        max_retries: 2,
        max_elapsed_sec: 600,
      },
    },
    high_risk: {
      preferred_agent: "codex",
      model_from: "implement_model",
      reasoning_effort: "high",
      limits: {
        max_context_chars: 40_000,
        max_output_chars: 20_000,
        max_tool_calls: 80,
        max_retries: 1,
        max_elapsed_sec: 2400,
      },
    },
  },
};

export function tierToTaskClass(tier: WorkTier | string | undefined): TaskClass {
  switch (tier) {
    case "triage":
      return "lookup_triage";
    case "research":
      return "research";
    case "implement":
    case "bugfix":
    case "default":
      return "implementation";
    default:
      if (tier === "verification") return "verification";
      if (tier === "high_risk") return "high_risk";
      return "implementation";
  }
}

export function parseConservationConfig(
  raw: unknown,
): ConservationConfig {
  if (!raw || typeof raw !== "object") return DEFAULT_CONSERVATION_CONFIG;
  const o = raw as Record<string, unknown>;
  const enabled = o.enabled !== false;
  const order = Array.isArray(o.agent_fallback_order)
    ? (o.agent_fallback_order as string[]).filter(
        (a): a is ConservationAgent => a === "codex" || a === "cursor",
      )
    : DEFAULT_CONSERVATION_CONFIG.agent_fallback_order;
  const classes = { ...DEFAULT_CONSERVATION_CONFIG.classes };
  if (o.classes && typeof o.classes === "object") {
    for (const key of Object.keys(DEFAULT_CONSERVATION_CONFIG.classes) as TaskClass[]) {
      const patch = (o.classes as Record<string, unknown>)[key];
      if (!patch || typeof patch !== "object") continue;
      const p = patch as Record<string, unknown>;
      const base = classes[key];
      classes[key] = {
        preferred_agent:
          p.preferred_agent === "cursor" || p.preferred_agent === "codex"
            ? p.preferred_agent
            : base.preferred_agent,
        model_from:
          p.model_from === "research_model" ||
          p.model_from === "implement_model" ||
          p.model_from === "default_model"
            ? p.model_from
            : base.model_from,
        reasoning_effort:
          p.reasoning_effort === "minimal" ||
          p.reasoning_effort === "low" ||
          p.reasoning_effort === "medium" ||
          p.reasoning_effort === "high"
            ? p.reasoning_effort
            : base.reasoning_effort,
        limits: mergeLimits(base.limits, p.limits),
      };
    }
  }
  return { enabled, agent_fallback_order: order, classes };
}

function mergeLimits(base: StageLimits, raw: unknown): StageLimits {
  if (!raw || typeof raw !== "object") return base;
  const l = raw as Record<string, unknown>;
  return {
    max_context_chars: num(l.max_context_chars, base.max_context_chars),
    max_output_chars: num(l.max_output_chars, base.max_output_chars),
    max_tool_calls: num(l.max_tool_calls, base.max_tool_calls),
    max_retries: num(l.max_retries, base.max_retries),
    max_elapsed_sec: num(l.max_elapsed_sec, base.max_elapsed_sec),
  };
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
}

function agentUsage(
  config: AppConfig,
  agent: ConservationAgent,
): AgentUsageConfig | null {
  if (!config.agents[agent]?.enabled) return null;
  return config.agents[agent]?.usage ?? null;
}

function pickModel(
  policy: AgentUsageConfig | null,
  from: ClassRoute["model_from"],
  explicit?: string | null,
): string | null {
  if (explicit) return explicit;
  if (!policy) return null;
  if (from === "research_model") {
    return policy.research_model ?? policy.default_model ?? null;
  }
  if (from === "implement_model") {
    return policy.implement_model ?? policy.default_model ?? null;
  }
  return policy.default_model ?? null;
}

function agentAvailable(config: AppConfig, agent: ConservationAgent): boolean {
  return isAgentEnabled(config, agent);
}

function pickAgent(
  config: AppConfig,
  route: ClassRoute,
  order: ConservationAgent[],
  override?: ConservationOwnerOverride,
): ConservationAgent {
  if (override?.agent && agentAvailable(config, override.agent)) {
    return override.agent;
  }
  if (agentAvailable(config, route.preferred_agent)) {
    return route.preferred_agent;
  }
  for (const a of order) {
    if (agentAvailable(config, a)) return a;
  }
  throw new Error(
    "conservation_blocked: no host agent available (enable codex or cursor)",
  );
}

export function buildConservationPlan(input: {
  config: AppConfig;
  tier?: WorkTier | string;
  explicitAgent?: AgentKind;
  explicitModel?: string | null;
  ownerOverride?: ConservationOwnerOverride | null;
  highRiskHint?: boolean;
  escalationReason?: string | null;
}): ConservationPlan {
  if (input.explicitAgent === "mock") {
    const taskClass = input.ownerOverride?.task_class ?? tierToTaskClass(input.tier);
    return {
      task_class: taskClass,
      agent: "mock",
      model: input.explicitModel ?? null,
      reasoning_effort: "low",
      cursor_mode: null,
      limits: DEFAULT_CONSERVATION_LIMITS,
      escalation_required: Boolean(input.escalationReason),
      escalation_reason: input.escalationReason ?? null,
      budget_label: "estimate",
      tokens_used: null,
      tokens_budget: DEFAULT_CONSERVATION_LIMITS.max_output_chars,
      owner_override_applied: false,
    };
  }

  const conservation = parseConservationConfig(
    (input.config.worker as { conservation?: unknown }).conservation,
  );
  const taskClass =
    input.ownerOverride?.task_class ??
    (input.highRiskHint ? "high_risk" : tierToTaskClass(input.tier));
  const route = conservation.classes[taskClass];
  const ownerOverrideApplied = Boolean(
    input.ownerOverride?.agent ||
      input.ownerOverride?.model ||
      input.ownerOverride?.reasoning_effort ||
      input.ownerOverride?.task_class,
  );

  let agent: AgentKind;
  if (input.explicitAgent) {
    if (input.explicitAgent === "kimi") {
      throw new Error(
        "kimi_retired: explicit kimi agent is not allowed for new work",
      );
    }
    agent = input.explicitAgent;
  } else if (!conservation.enabled) {
    agent = agentAvailable(input.config, "codex")
      ? "codex"
      : agentAvailable(input.config, "cursor")
        ? "cursor"
        : (() => {
            throw new Error("no host agent enabled");
          })();
  } else {
    agent = pickAgent(
      input.config,
      route,
      conservation.agent_fallback_order,
      input.ownerOverride ?? undefined,
    );
  }

  const policy = agentUsage(input.config, agent as ConservationAgent);
  const model = pickModel(
    policy,
    route.model_from,
    input.ownerOverride?.model ?? input.explicitModel,
  );
  const reasoning_effort =
    input.ownerOverride?.reasoning_effort ?? route.reasoning_effort;
  const cursor_mode =
    agent === "cursor" &&
    (taskClass === "lookup_triage" ||
      taskClass === "research" ||
      taskClass === "verification") &&
    policy?.research_mode
      ? policy.research_mode
      : null;

  const escalation_required = Boolean(input.escalationReason);
  return {
    task_class: taskClass,
    agent,
    model,
    reasoning_effort,
    cursor_mode,
    limits: route.limits,
    escalation_required,
    escalation_reason: input.escalationReason ?? null,
    budget_label: "estimate",
    tokens_used: null,
    tokens_budget: route.limits.max_output_chars,
    owner_override_applied: ownerOverrideApplied,
  };
}

export function conservationPlanToMeta(plan: ConservationPlan): string {
  return JSON.stringify({
    task_class: plan.task_class,
    agent: plan.agent,
    model: plan.model,
    reasoning_effort: plan.reasoning_effort,
    cursor_mode: plan.cursor_mode,
    limits: plan.limits,
    escalation_reason: plan.escalation_reason,
    budget_label: plan.budget_label,
    tokens_used: plan.tokens_used,
    tokens_budget: plan.tokens_budget,
    owner_override_applied: plan.owner_override_applied,
  });
}

export function parseConservationMeta(
  raw: string | null | undefined,
): ConservationPlan | null {
  if (!raw?.trim()) return null;
  try {
    return JSON.parse(raw) as ConservationPlan;
  } catch {
    return null;
  }
}
