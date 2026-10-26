#!/usr/bin/env node
/**
 * Local smoke: temp relay+worker on free ports (does NOT touch LaunchAgents).
 * Usage: node scripts/smoke-terminal-sessions.mjs
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkerService,
  RelayClient,
  buildTestConfig,
} from "../packages/worker/dist/index.js";
import { startRelay } from "../packages/relay/dist/server.js";

const port = 19887;
const root = mkdtempSync(join(tmpdir(), "ac-smoke-"));
const fixture = join(root, "ws");
mkdirSync(fixture);
writeFileSync(join(fixture, "marker.txt"), "ok\n");

const relay = await startRelay({
  host: "127.0.0.1",
  port,
  publicBaseUrl: `http://127.0.0.1:${port}`,
  jwtSecret: "smoke-jwt-secret-at-least-32-chars!!",
  workerToken: "smoke-worker-token-at-least-24c",
  ownerId: "owner-test",
  ownerApprovalSecret: "smoke-approval",
  boardViewSecret: "smoke-approval",
  allowDevToken: true,
  dataDir: join(root, "relay-data"),
});

const cfg = buildTestConfig(root, fixture);
cfg.owner.id = "owner-test";
cfg.relay.url = `ws://127.0.0.1:${port}/worker`;
cfg.worker.agent_execution = "host";
cfg.agents.cursor.enabled = true;
cfg.agents.kimi.enabled = true;

const service = new WorkerService({
  config: cfg,
  dbPath: join(root, "data", "worker", "jobs.db"),
  configRoot: root,
});
service.start();
const client = new RelayClient(cfg.relay.url, "smoke-worker-token-at-least-24c", service);
client.start();

const deadline = Date.now() + 10_000;
while (!relay.hub.connected && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 100));
}
if (!relay.hub.connected) {
  console.error("SMOKE_FAIL: worker did not connect");
  process.exit(1);
}

const session = await relay.hub.request(
  "create_terminal_session",
  { kind: "shell", workspace: fixture, idleSec: 60 },
  "owner-test",
);
await relay.hub.request(
  "write_terminal_input",
  {
    sessionId: session.id,
    data: "printf 'GROUND_SMOKE_OK\\n'",
    submit: true,
  },
  "owner-test",
);

let found = false;
let offset = 0;
const readDeadline = Date.now() + 8_000;
while (Date.now() < readDeadline) {
  const chunk = await relay.hub.request(
    "read_terminal_output",
    { sessionId: session.id, offset, maxBytes: 16384 },
    "owner-test",
  );
  if (chunk.text.includes("GROUND_SMOKE_OK")) {
    found = true;
    break;
  }
  offset = chunk.next_offset;
  await new Promise((r) => setTimeout(r, 100));
}

await relay.hub.request("close_terminal_session", { sessionId: session.id }, "owner-test");
client.stop();
service.close();
await relay.close();

if (!found) {
  console.error("SMOKE_FAIL: marker not seen");
  process.exit(1);
}
console.log("SMOKE_OK: terminal session create/write/read/close via local MCP transport");
process.exit(0);
