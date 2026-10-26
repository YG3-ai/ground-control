import { DEFAULT_YG3_MCP_URL } from "./constants.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export class Yg3McpUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Yg3McpUrlError";
  }
}

/** HTTPS required except explicit loopback (mock/tests). */
export function validateYg3McpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Yg3McpUrlError("invalid_url");
  }
  const host = url.hostname.toLowerCase();
  const loopback = LOOPBACK_HOSTS.has(host);
  if (!loopback && url.protocol !== "https:") {
    throw new Yg3McpUrlError("https_required");
  }
  if (loopback && url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Yg3McpUrlError("invalid_loopback_protocol");
  }
  return url;
}

export function resolveYg3McpUrl(env: NodeJS.ProcessEnv = process.env): URL {
  const raw = env.YG3_MCP_URL?.trim() || DEFAULT_YG3_MCP_URL;
  return validateYg3McpUrl(raw);
}

export function isYg3McpEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.YG3_MCP_ENABLED?.trim();
  return v === "1" || v?.toLowerCase() === "true";
}
