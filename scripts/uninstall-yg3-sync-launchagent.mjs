#!/usr/bin/env node
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { uninstallYg3SyncLaunchAgent } from "./setup-mac-launchagent.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const launchAgentsDir =
  process.env.GROUND_CONTROL_LAUNCH_AGENTS_DIR?.trim() ||
  join(process.env.HOME || "", "Library", "LaunchAgents");

const dryRun = process.argv.includes("--dry-run");
const result = uninstallYg3SyncLaunchAgent({
  root,
  launchAgentsDir,
  dryRun,
});
console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
