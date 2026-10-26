#!/usr/bin/env node
/**
 * macOS first-run guided setup (idempotent).
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import {
  isMacOsPlatform,
  parseSetupCliArgs,
  printSetupHelp,
  runMacSetup,
} from "./setup-mac-lib.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const parsed = parseSetupCliArgs(process.argv.slice(2));

if (parsed.action === "help") {
  printSetupHelp();
  process.exit(0);
}

const root = parsed.testRoot || repoRoot;

if (!isMacOsPlatform()) {
  console.log(
    JSON.stringify({
      ok: false,
      error: "unsupported_os",
      message: "Ground Control first-run setup supports macOS only.",
    }),
  );
  process.exit(1);
}

function makeInteractivePrompts() {
  if (parsed.nonInteractive || parsed.dryRun) {
    return {};
  }
  return {
    promptYesNo: (question, defaultYes) =>
      new Promise((resolve) => {
        const rl = createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        rl.question(question, (answer) => {
          rl.close();
          const t = answer.trim();
          if (!t) resolve(defaultYes);
          else resolve(/^y(es)?$/i.test(t));
        });
      }),
    promptLine: (question) =>
      new Promise((resolve) => {
        const rl = createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        rl.question(question, (answer) => {
          rl.close();
          resolve(answer);
        });
      }),
  };
}

const result = await runMacSetup({
  root,
  dryRun: parsed.dryRun,
  nonInteractive: parsed.nonInteractive,
  brainRoot: parsed.brainRoot,
  testRootMode: Boolean(parsed.testRoot),
  deps: makeInteractivePrompts(),
});

console.log(
  JSON.stringify({
    ok: result.ok,
    blocked: result.blocked,
    blocker: result.blocker,
    steps: result.steps,
    reconnect_note:
      "Reconnect YG3 only if access is revoked or tokens become invalid.",
  }),
);

if (!result.ok) {
  process.exit(1);
}
