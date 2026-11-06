#!/usr/bin/env bash
# Foreground stable ngrok tunnel for launchd KeepAlive.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
# (ngrok only — no Node ABI concerns)
mkdir -p "$ROOT/logs"
exec node -e '
  const fs = require("fs");
  const { spawn } = require("child_process");
  const dotenv = require("dotenv");
  const env = fs.existsSync(".env") ? dotenv.parse(fs.readFileSync(".env")) : {};
  const base = env.PUBLIC_BASE_URL || process.env.PUBLIC_BASE_URL || "";
  const host = base.replace(/^https?:\/\//, "").split("/")[0];
  const port = env.RELAY_PORT || process.env.RELAY_PORT || "8787";
  if (!host || host.includes("127.0.0.1")) { console.error("PUBLIC_BASE_URL must be your stable ngrok domain"); process.exit(1); }
  spawn("ngrok", ["http", "--url", `https://${host}`, port, "--log=stdout"], { env: { ...process.env, ...env }, stdio: "inherit" })
    .on("exit", (code) => process.exit(code ?? 1));
'
