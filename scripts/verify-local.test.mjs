import assert from "node:assert/strict";
import { test } from "node:test";
import { assertLoopbackHealthUrl } from "./doctor-lib.mjs";

test("verify-local rejects non-loopback URLs by default", () => {
  assert.throws(() => assertLoopbackHealthUrl("http://10.0.0.1:8787/healthz"));
  assert.ok(assertLoopbackHealthUrl("http://localhost:8787/healthz"));
});
