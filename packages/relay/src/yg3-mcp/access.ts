import { isPublicBoardAudience } from "../board-extensions/public-redact.js";
import { isYg3McpEnabled } from "./url.js";

export class Yg3PublicAccessError extends Error {
  constructor() {
    super("yg3_mcp_public_forbidden");
    this.name = "Yg3PublicAccessError";
  }
}

/** Board / HTTP handlers must call before touching YG3 MCP state. */
export function assertOwnerYg3McpAccess(audience: string): void {
  if (isPublicBoardAudience(audience)) {
    throw new Yg3PublicAccessError();
  }
}

export function yg3McpConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return isYg3McpEnabled(env);
}
