import { describe, expect, it } from "vitest";
import {
  clearCodexProbeCacheForTests,
  probeCodexBinary,
} from "./detect.js";

describe("probeCodexBinary", () => {
  it("caches the expensive probe for repeated board snapshots", () => {
    clearCodexProbeCacheForTests();
    const first = probeCodexBinary({
      configuredBinary: `${process.env.HOME}/.local/bin/codex`,
    });
    const second = probeCodexBinary({
      configuredBinary: `${process.env.HOME}/.local/bin/codex`,
    });
    expect(second).toBe(first);
  });

  it("detects local codex without exposing credentials", () => {
    const probe = probeCodexBinary();
    if (!probe.ok) {
      expect(probe.error).toBeTruthy();
      return;
    }
    expect(probe.path).toMatch(/codex/);
    expect(probe.version).toMatch(/\d+\.\d+/);
    expect(JSON.stringify(probe)).not.toMatch(/sk-|Bearer|access_token/);
  });

  it("resolves configured absolute binary under thin PATH", () => {
    const probe = probeCodexBinary({
      configuredBinary: `${process.env.HOME}/.local/bin/codex`,
    });
    if (probe.ok) {
      expect(probe.launchd_path_ok).toBe(true);
    }
  });
});
