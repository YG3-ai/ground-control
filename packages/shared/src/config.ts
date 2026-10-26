import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { AppConfig } from "./types.js";

const AgentKindSchema = z.enum(["mock", "cursor", "kimi"]);

const ConfigSchema = z.object({
  owner: z.object({
    id: z.string().min(1),
    display_name: z.string().min(1),
  }),
  relay: z.object({
    url: z.string().min(1),
  }),
  worker: z.object({
    data_dir: z.string().min(1),
    policy_dir: z.string().min(1),
    max_output_bytes: z.number().int().positive().default(262144),
    default_timeout_sec: z.number().int().positive().default(1800),
    agent_execution: z.enum(["host", "docker"]).default("host"),
    allowed_roots: z.array(z.string()).default([]),
    terminal_sessions: z
      .object({
        default_idle_sec: z.number().int().min(0).default(3600),
        default_cols: z.number().int().positive().max(500).default(120),
        default_rows: z.number().int().positive().max(200).default(40),
      })
      .optional(),
    local_control: z
      .object({
        enabled: z.boolean().default(true),
        bind: z.string().default("127.0.0.1"),
        port: z.number().int().positive().default(8788),
        browser_requires_approval: z.boolean().default(true),
        approval_timeout_sec: z.number().int().positive().max(600).default(120),
      })
      .optional(),
    isolation: z.object({
      backend: z.enum(["docker", "mock-fail"]),
      image: z.string().min(1),
      network: z.string().min(1),
      run_as_user: z.string().min(1),
      read_only_rootfs: z.boolean(),
      memory_mb: z.number().int().positive(),
      cpus: z.number().positive(),
    }),
  }),
  supervisor: z.object({
    enabled: z.boolean(),
  }),
  agents: z.record(
    z.object({
      enabled: z.boolean(),
      adapter: AgentKindSchema,
      binary: z.string().optional(),
      notes: z.string().optional(),
      usage: z
        .object({
          window_sec: z.number().int().positive().optional(),
          max_starts_per_window: z.number().int().positive().optional(),
          min_gap_sec: z.number().int().min(0).optional(),
          max_concurrent: z.number().int().positive().optional(),
          default_model: z.string().optional(),
          research_model: z.string().optional(),
          implement_model: z.string().optional(),
          research_mode: z.enum(["ask", "plan"]).optional(),
          cooldown_after_rate_limit_sec: z.number().int().positive().optional(),
        })
        .optional(),
    }),
  ),
  clients: z
    .array(
      z.object({
        id: z
          .string()
          .min(1)
          .regex(/^[a-z0-9][a-z0-9_-]*$/i),
        name: z.string().min(1),
        workspace: z.string().min(1),
        aliases: z.array(z.string()).optional(),
        update_to: z.string().optional(),
      }),
    )
    .optional()
    .default([]),
  projects: z
    .array(
      z.object({
        id: z
          .string()
          .min(1)
          .regex(/^[a-z0-9][a-z0-9_-]*$/i, "project id must be alphanumeric"),
        name: z.string().min(1),
        description: z.string().optional(),
        source_path: z.string().min(1),
        allowed_agents: z.array(AgentKindSchema).min(1),
        permissions: z.object({
          network: z.string().min(1),
          git_write: z.boolean(),
          max_runtime_sec: z.number().int().positive(),
        }),
        credentials: z.array(z.string()).default([]),
      }),
    )
    .default([]),
});

export function parseConfig(raw: unknown): AppConfig {
  return ConfigSchema.parse(raw) as AppConfig;
}

export function loadConfig(path: string): AppConfig {
  const abs = resolve(path);
  const text = readFileSync(abs, "utf8");
  const raw = YAML.parse(text);
  return parseConfig(raw);
}

export function getProject(config: AppConfig, projectId: string) {
  return config.projects.find((p) => p.id === projectId) ?? null;
}

export function isAgentEnabled(config: AppConfig, agent: string): boolean {
  const agentCfg = config.agents[agent];
  return Boolean(agentCfg?.enabled && agentCfg.adapter === agent);
}

export function isAgentAllowed(
  config: AppConfig,
  projectId: string | undefined,
  agent: string,
): boolean {
  if (!isAgentEnabled(config, agent)) return false;
  // Host-mode cursor/kimi: no project registration required.
  if ((agent === "cursor" || agent === "kimi") && !projectId) {
    return config.worker.agent_execution === "host";
  }
  if (!projectId) return agent === "mock" ? false : false;
  const project = getProject(config, projectId);
  if (!project) return false;
  return project.allowed_agents.includes(agent as "mock" | "cursor" | "kimi");
}
