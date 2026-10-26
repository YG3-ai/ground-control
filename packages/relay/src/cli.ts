import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { loadRelayConfig } from "./config.js";
import { startRelay } from "./server.js";

// Load repo-root .env if present (optional dependency-free fallback below).
try {
  loadDotenv({ path: resolve(process.cwd(), ".env") });
} catch {
  // dotenv may be absent; env can be exported by the shell instead.
}

async function main(): Promise<void> {
  const cfg = loadRelayConfig();
  // Keep OAuth DB under the repo even when npm workspace cwd is packages/relay
  if (!cfg.dataDir.startsWith("/")) {
    const { resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
    cfg.dataDir = resolve(repoRoot, cfg.dataDir);
  }
  const relay = await startRelay(cfg);
  const shutdown = async () => {
    console.log("[relay] shutting down");
    await relay.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
