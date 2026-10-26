import { readFileSync } from "node:fs";
import { parse } from "dotenv";
import { join } from "node:path";
import { loadRelayConfig } from "../packages/relay/src/config.ts";
import { OAuthStore } from "../packages/relay/src/oauth/store.ts";
import { PersonalOAuthProvider } from "../packages/relay/src/oauth/provider.ts";

const root = new URL("..", import.meta.url).pathname;
const env = parse(readFileSync(join(root, ".env"), "utf8"));
for (const [k, v] of Object.entries(env)) process.env[k] = v;
process.env.RELAY_DATA_DIR = join(root, process.env.RELAY_DATA_DIR ?? "data/relay");
const cfg = loadRelayConfig(process.env);
const store = new OAuthStore(join(cfg.dataDir, "oauth.db"));
const provider = new PersonalOAuthProvider(cfg, store);
const tokens = await provider.mintTokens({
  clientId: "diag-client",
  scopes: ["agent-control"],
  resource: cfg.publicBaseUrl + "/mcp",
});

async function mcp(method, params) {
  const res = await fetch(`http://127.0.0.1:${cfg.port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${tokens.access_token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  return { status: res.status, text };
}

for (const tool of [
  "terminal_capabilities",
  "list_projects",
  "get_situation",
]) {
  const r = await mcp("tools/call", { name: tool, arguments: {} });
  console.log("\n===", tool, "http", r.status);
  console.log(r.text.slice(0, 1200));
}
