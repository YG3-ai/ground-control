import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { loadConfig } from "@agent-control/shared";
import { WorkerService } from "./service.js";
import { RelayClient } from "./relay-client.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
loadDotenv({ path: resolve(repoRoot, ".env") });

function usage(): never {
  console.log(`Usage:
  worker start [--config path]
  worker status [--config path]
`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0] ?? "start";
  let configPath = resolve(repoRoot, "config.yaml");
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--config") {
      configPath = resolve(args[++i] ?? "");
    }
  }

  if (cmd === "status") {
    console.log(JSON.stringify({ configPath, repoRoot }, null, 2));
    return;
  }
  if (cmd !== "start") usage();

  const workerToken = process.env.WORKER_TOKEN;
  if (!workerToken || workerToken.length < 24) {
    throw new Error("WORKER_TOKEN env var required (min 24 chars)");
  }

  const config = loadConfig(configPath);
  // Allow go-live override without editing config.yaml (e.g. ngrok wss URL).
  if (process.env.RELAY_URL) {
    config.relay.url = process.env.RELAY_URL;
  }
  const dbPath = resolve(repoRoot, config.worker.data_dir, "jobs.db");
  const service = new WorkerService({
    config,
    dbPath,
    configRoot: repoRoot,
  });

  service.start();
  const client = new RelayClient(config.relay.url, workerToken, service);
  client.start();

  console.log(`[worker] started; owner=${config.owner.id} db=${dbPath}`);
  console.log("[worker] isolation backend:", config.worker.isolation.backend);
  console.log("[worker] dialing relay:", config.relay.url);

  const shutdown = () => {
    console.log("[worker] shutting down");
    client.stop();
    service.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
