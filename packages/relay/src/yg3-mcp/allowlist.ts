import {
  YG3_FORBIDDEN_ARG_KEYS,
  YG3_READ_TOOL_ALLOWLIST,
} from "./constants.js";

const ALLOW_SET = new Set<string>(YG3_READ_TOOL_ALLOWLIST);

export class Yg3ToolPolicyError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "Yg3ToolPolicyError";
  }
}

export function assertReadToolAllowed(toolName: string): void {
  if (!ALLOW_SET.has(toolName)) {
    throw new Yg3ToolPolicyError("tool_not_allowlisted", "tool_not_allowlisted");
  }
}

export function assertReadOnlyToolArgs(
  args: Record<string, unknown> | undefined,
): void {
  if (!args) return;
  for (const key of Object.keys(args)) {
    if (YG3_FORBIDDEN_ARG_KEYS.has(key)) {
      throw new Yg3ToolPolicyError("write_semantics_forbidden", "write_semantics_forbidden");
    }
    const lower = key.toLowerCase();
    if (lower.includes("confirm") || lower.includes("idempotency")) {
      throw new Yg3ToolPolicyError("write_semantics_forbidden", "write_semantics_forbidden");
    }
    if (args[key] === true && key.toLowerCase().includes("confirm")) {
      throw new Yg3ToolPolicyError("write_semantics_forbidden", "write_semantics_forbidden");
    }
  }
}
