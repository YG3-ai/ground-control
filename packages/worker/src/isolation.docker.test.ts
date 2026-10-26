import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DockerIsolationBackend } from "./isolation/docker.js";
import { dockerAvailable, ensureMockImage } from "./test-utils.js";

describe.skipIf(!dockerAvailable())("Docker isolation sentinel evidence", () => {
  const backend = new DockerIsolationBackend();

  beforeAll(() => {
    ensureMockImage();
  });

  it("cannot read a host sentinel file that is not mounted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ac-sentinel-"));
    const sentinelPath = join(dir, "SENTINEL_SECRET.txt");
    writeFileSync(sentinelPath, "SENTINEL_SHOULD_NEVER_BE_READ\n", {
      mode: 0o600,
    });

    const probe = await backend.assertHostPathInvisible(sentinelPath);
    expect(probe).toEqual({ ok: true });

    // Also run the mock image and confirm /host-sentinel is absent unless mounted.
    const handle = await backend.run({
      image: "agent-control-mock:local",
      command: [
        "sh",
        "-c",
        `
          if [ -e '${sentinelPath}' ]; then echo VISIBLE_ABS; exit 1; fi
          if [ -e /host-sentinel ]; then echo VISIBLE_MOUNT; exit 1; fi
          echo INVISIBLE_OK
        `,
      ],
      workdir: "/work",
      env: {},
      mounts: [],
      network: "none",
      runAsUser: "1000:1000",
      readOnlyRootfs: true,
      memoryMb: 256,
      cpus: 1,
      timeoutSec: 30,
    });
    const result = await handle.wait();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("INVISIBLE_OK");
    expect(result.stdout).not.toMatch(/(^|\n)VISIBLE(_ABS|_MOUNT)?(\n|$)/);
  });


  it("refuses docker.sock and home mounts", async () => {
    await expect(
      backend.run({
        image: "agent-control-mock:local",
        command: ["true"],
        workdir: "/work",
        env: {},
        mounts: [
          {
            hostPath: "/var/run/docker.sock",
            containerPath: "/var/run/docker.sock",
            readOnly: false,
          },
        ],
        network: "none",
        runAsUser: "1000:1000",
        readOnlyRootfs: true,
        memoryMb: 256,
        cpus: 1,
        timeoutSec: 10,
      }),
    ).rejects.toThrow(/docker\.sock/i);

    await expect(
      backend.run({
        image: "agent-control-mock:local",
        command: ["true"],
        workdir: "/work",
        env: {},
        mounts: [
          {
            hostPath: process.env.HOME || "/Users",
            containerPath: "/host-home",
            readOnly: true,
          },
        ],
        network: "none",
        runAsUser: "1000:1000",
        readOnlyRootfs: true,
        memoryMb: 256,
        cpus: 1,
        timeoutSec: 10,
      }),
    ).rejects.toThrow(/home directory/i);
  });

  it("refuses host networking", async () => {
    await expect(
      backend.run({
        image: "agent-control-mock:local",
        command: ["true"],
        workdir: "/work",
        env: {},
        mounts: [],
        network: "host",
        runAsUser: "1000:1000",
        readOnlyRootfs: true,
        memoryMb: 256,
        cpus: 1,
        timeoutSec: 10,
      }),
    ).rejects.toThrow(/host networking/i);
  });
});
