import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  brainAdapterConfigured,
  resolveBoardExtensionPaths,
  resolveWorkRootFromEnv,
  workRootAdapterConfigured,
} from "./paths.js";

const relayPkg = join(import.meta.dirname, "..");

describe("resolveBoardExtensionPaths", () => {
  it("has no hardcoded owner work or brain roots by default", () => {
    const cfg = resolveBoardExtensionPaths(relayPkg, {});
    expect(cfg.parthaWorkRoot).toBeNull();
    expect(cfg.brainRoot).toBeNull();
    expect(workRootAdapterConfigured(cfg)).toBe(false);
    expect(brainAdapterConfigured(cfg)).toBe(false);
  });

  it("prefers GROUND_CONTROL_WORK_ROOT over legacy key", () => {
    expect(
      resolveWorkRootFromEnv({
        GROUND_CONTROL_WORK_ROOT: "/tmp/gc-new",
        PARTHA_WORK_ROOT: "/tmp/gc-old",
      }),
    ).toBe("/tmp/gc-new");
    expect(resolveWorkRootFromEnv({ PARTHA_WORK_ROOT: "/tmp/gc-old" })).toBe(
      "/tmp/gc-old",
    );
  });

  it("enables adapters only when env is set", () => {
    const cfg = resolveBoardExtensionPaths(relayPkg, {
      GROUND_CONTROL_WORK_ROOT: "/tmp/gc-work",
      BRAIN_ROOT: "/tmp/gc-brain",
    });
    expect(cfg.parthaWorkRoot).toBe("/tmp/gc-work");
    expect(cfg.brainVault).toBe("/tmp/gc-brain/vault");
    expect(workRootAdapterConfigured(cfg)).toBe(true);
    expect(brainAdapterConfigured(cfg)).toBe(true);
  });
});
