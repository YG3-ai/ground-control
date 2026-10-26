import { describe, expect, it } from "vitest";
import { HostProcessBackend } from "./host.js";

describe("HostProcessBackend streaming", () => {
  it("emits onOutput chunks before wait resolves", async () => {
    const backend = new HostProcessBackend();
    const chunks: string[] = [];
    const handle = await backend.run({
      command: "/bin/sh",
      args: ["-c", "printf 'STREAM_A\\n'; sleep 0.4; printf 'STREAM_B\\n'"],
      cwd: process.cwd(),
      env: {},
      timeoutSec: 10,
      onOutput: (c) => {
        if (c.stdout) chunks.push(c.stdout);
      },
    });

    // Poll until first chunk while process still running
    const start = Date.now();
    while (Date.now() - start < 5_000 && !chunks.join("").includes("STREAM_A")) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(chunks.join("")).toContain("STREAM_A");

    const result = await handle.wait();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("STREAM_B");
    expect(chunks.join("")).toContain("STREAM_B");
  });
});
