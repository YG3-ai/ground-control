#!/usr/bin/env node
/**
 * Idempotent config migration: disable Kimi for new work, enable Codex with absolute binary.
 * Backs up config.yaml before mutating.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";

const root = process.argv[2] ? resolve(process.argv[2]) : resolve(".");
const configPath = join(root, "config.yaml");
if (!existsSync(configPath)) {
  console.error(`missing ${configPath}`);
  process.exit(1);
}

const backup = `${configPath}.bak-${Date.now()}`;
copyFileSync(configPath, backup);
console.log(`backup: ${backup}`);

const doc = YAML.parse(readFileSync(configPath, "utf8"));
doc.agents ??= {};
doc.agents.kimi ??= { adapter: "kimi" };
doc.agents.kimi.enabled = false;
doc.agents.kimi.notes =
  (doc.agents.kimi.notes ? `${doc.agents.kimi.notes}; ` : "") +
  "Retired for new work (historical jobs only).";

doc.agents.codex ??= { adapter: "codex" };
doc.agents.codex.enabled = true;
if (!doc.agents.codex.binary) {
  doc.agents.codex.binary = join(homedir(), ".local", "bin", "codex");
}
doc.agents.codex.usage ??= {};
doc.agents.codex.usage.max_concurrent ??= 1;
doc.agents.codex.usage.max_starts_per_window ??= 25;
doc.agents.codex.usage.min_gap_sec ??= 20;
doc.agents.codex.usage.window_sec ??= 18_000;
doc.agents.codex.usage.default_reasoning_effort ??= "medium";

doc.worker ??= {};
doc.worker.conservation ??= {
  enabled: true,
  agent_fallback_order: ["codex", "cursor"],
};

writeFileSync(configPath, YAML.stringify(doc));
console.log("migrated: kimi disabled, codex enabled, conservation defaults applied");
