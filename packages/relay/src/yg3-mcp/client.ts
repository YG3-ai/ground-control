import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  assertReadOnlyToolArgs,
  assertReadToolAllowed,
} from "./allowlist.js";
import { YG3_READ_TOOL_ALLOWLIST } from "./constants.js";
import {
  normalizeWhoamiIdentity,
  sanitizeUntrustedMcpValue,
} from "./sanitize.js";
import type { Yg3OAuthProvider } from "./oauth-provider.js";
import type { Yg3SnapshotMetaStore } from "./snapshot-meta.js";

export type Yg3McpClientOptions = {
  mcpUrl: URL;
  authProvider: Yg3OAuthProvider;
  snapshotMeta: Yg3SnapshotMetaStore;
  fetchFn?: typeof fetch;
};

export type Yg3IdentityProbeResult = {
  ok: boolean;
  tenantKey?: string;
  userKey?: string;
  error?: string;
};

export type AllowlistedToolSchemaInfo = {
  name: string;
  hasInputSchema: boolean;
  hasOutputSchema: boolean;
};

/**
 * Read-only YG3 MCP client. No generic callTool export to board code.
 */
export class Yg3ReadonlyMcpClient {
  private readonly mcpUrl: URL;
  private readonly authProvider: Yg3OAuthProvider;
  private readonly snapshotMeta: Yg3SnapshotMetaStore;
  private readonly fetchFn?: typeof fetch;

  constructor(opts: Yg3McpClientOptions) {
    this.mcpUrl = opts.mcpUrl;
    this.authProvider = opts.authProvider;
    this.snapshotMeta = opts.snapshotMeta;
    this.fetchFn = opts.fetchFn;
  }

  async probeIdentity(): Promise<Yg3IdentityProbeResult> {
    try {
      const raw = await this.callReadToolInternal("whoami", {});
      const identity = normalizeWhoamiIdentity(raw);
      this.snapshotMeta.touchWhoamiOk(identity);
      return {
        ok: true,
        tenantKey: identity.tenantKey,
        userKey: identity.userKey,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "probe_failed",
      };
    }
  }

  /** whoami payload for sanitized role reporting (caller must not log raw). */
  async fetchWhoamiPayload(): Promise<unknown> {
    return this.callReadToolInternal("whoami", {});
  }

  /** List tools and return schema flags for allowlisted names only (no descriptions). */
  async discoverAllowlistedToolSchemas(): Promise<AllowlistedToolSchemaInfo[]> {
    const allow = new Set<string>(YG3_READ_TOOL_ALLOWLIST);
    const client = new Client(
      { name: "ground-control-yg3", version: "0.1.0" },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(this.mcpUrl, {
      authProvider: this.authProvider,
      fetch: this.fetchFn,
    });
    await client.connect(transport);
    try {
      const listed = await client.listTools();
      const tools = listed.tools ?? [];
      const out: AllowlistedToolSchemaInfo[] = [];
      for (const tool of tools) {
        if (!allow.has(tool.name)) continue;
        const inputSchema = tool.inputSchema;
        const outputSchema = (tool as { outputSchema?: unknown }).outputSchema;
        out.push({
          name: tool.name,
          hasInputSchema: Boolean(
            inputSchema &&
              typeof inputSchema === "object" &&
              Object.keys(inputSchema as object).length > 0,
          ),
          hasOutputSchema: Boolean(
            outputSchema &&
              typeof outputSchema === "object" &&
              Object.keys(outputSchema as object).length > 0,
          ),
        });
      }
      out.sort((a, b) => a.name.localeCompare(b.name));
      return out;
    } finally {
      await transport.close();
    }
  }

  async runReadSession<T>(
    fn: (
      call: (toolName: string, args: Record<string, unknown>) => Promise<unknown>,
    ) => Promise<T>,
  ): Promise<T> {
    const client = new Client(
      { name: "ground-control-yg3", version: "0.1.0" },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(this.mcpUrl, {
      authProvider: this.authProvider,
      fetch: this.fetchFn,
    });
    await client.connect(transport);
    try {
      const call = async (
        toolName: string,
        args: Record<string, unknown>,
      ): Promise<unknown> => {
        assertReadToolAllowed(toolName);
        assertReadOnlyToolArgs(args);
        const result = await client.callTool({
          name: toolName,
          arguments: args,
        });
        const structured = result.structuredContent ?? result.content;
        return sanitizeUntrustedMcpValue(structured);
      };
      return await fn(call);
    } finally {
      await transport.close();
    }
  }

  private async callReadToolInternal(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    return this.runReadSession((call) => call(toolName, args));
  }
}
