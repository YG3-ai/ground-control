#!/usr/bin/env node
/** Print BOARD_UNLOCK_PASSWORD_HASH for .env (password read from stdin, not argv). */
import { randomBytes, scryptSync } from "node:crypto";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const password = Buffer.concat(chunks).toString("utf8");
if (!password) {
  console.error("Read password from stdin, e.g.: printf '%s' 'your-password' | node scripts/hash-board-unlock-password.mjs");
  process.exit(1);
}
const salt = randomBytes(16).toString("hex");
const hash = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 }).toString("hex");
process.stdout.write(`scrypt$${salt}$${hash}\n`);
process.stderr.write("Add to .env in single quotes: BOARD_UNLOCK_PASSWORD_HASH='...'\n");
