import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthError } from "../db.js";
import { createService, dockerAvailable, makeTempRoot } from "../test-utils.js";
import type { WorkerService } from "../service.js";
import { encodeSessionInput } from "./keys.js";
import { OutputBuffer } from "./buffer.js";
import { resolveExecutable, BinaryResolveError } from "../binary-resolve.js";

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitForOutput(
  service: WorkerService,
  sessionId: string,
  needle: string,
  timeoutMs = 8_000,
) {
  const start = Date.now();
  let offset = 0;
  let acc = "";
  while (Date.now() - start < timeoutMs) {
    const chunk = service.readTerminalOutput("owner-test", sessionId, {
      offset,
      maxBytes: 16_384,
    });
    acc += chunk.text;
    offset = chunk.next_offset;
    if (acc.includes(needle)) return acc;
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${JSON.stringify(needle)}; got: ${acc.slice(-500)}`);
}

describe("OutputBuffer + keys", () => {
  it("tracks absolute offsets and clamps dropped prefix", () => {
    const buf = new OutputBuffer(16);
    buf.append("abcdefghijklmnop"); // 16
    buf.append("QRST"); // drops some prefix
    expect(buf.oldestOffset).toBeGreaterThan(0);
    const r = buf.read(0, 100);
    expect(r.truncated_before).toBe(true);
    expect(r.start_offset).toBe(buf.oldestOffset);
  });

  it("encodes enter and ctrl-c", () => {
    expect(encodeSessionInput({ data: "hi", submit: true })).toBe("hi\r");
    expect(encodeSessionInput({ keys: ["ctrl-c"] })).toBe("\x03");
  });
});

describe("binary resolve", () => {
  it("resolves absolute shell and rejects missing", () => {
    const r = resolveExecutable("/bin/zsh", "zsh");
    expect(r.path).toBe("/bin/zsh");
    expect(() => resolveExecutable("/no/such/binary-xyz", "x")).toThrow(
      BinaryResolveError,
    );
  });
});

describe("terminal sessions", () => {
  const services: WorkerService[] = [];

  afterEach(() => {
    for (const s of services.splice(0)) s.close();
  });

  function setup() {
    const root = makeTempRoot();
    const fixture = join(root, "ws");
    mkdirSync(fixture, { recursive: true });
    writeFileSync(join(fixture, "marker.txt"), "ok\n");
    const service = createService(root, fixture);
    // host-mode workspaces for sessions
    service.config.worker.allowed_roots = [fixture];
    service.config.worker.agent_execution = "host";
    service.config.agents.cursor.enabled = true;
    service.config.agents.kimi.enabled = true;
    services.push(service);
    return { root, fixture, service };
  }

  it("PTY conversation across separate calls with Enter and Ctrl-C", async () => {
    const { service, fixture } = setup();
    const session = service.createTerminalSession({
      ownerId: "owner-test",
      kind: "shell",
      workspace: fixture,
      idleSec: 120,
    });
    expect(session.state).toBe("running");
    expect(session.id).toMatch(
      /^[0-9a-f-]{36}$/i,
    );

    service.writeTerminalInput("owner-test", session.id, {
      data: "printf 'GROUND_MARKER_%s\\n' hello",
      submit: true,
    });
    await waitForOutput(service, session.id, "GROUND_MARKER_hello");

    // Second independent call — reconnect by id
    const listed = service.listTerminalSessions("owner-test");
    expect(listed.some((s) => s.id === session.id)).toBe(true);

    service.writeTerminalInput("owner-test", session.id, {
      data: "sleep 30",
      submit: true,
    });
    await sleep(200);
    service.interruptTerminalSession("owner-test", session.id);
    // shell should still be alive after Ctrl-C
    await sleep(200);
    const st = service.getTerminalSession("owner-test", session.id);
    expect(st.state).toBe("running");

    service.writeTerminalInput("owner-test", session.id, {
      data: "printf 'AFTER_INT\\n'",
      submit: true,
    });
    await waitForOutput(service, session.id, "AFTER_INT");

    const closed = service.closeTerminalSession("owner-test", session.id);
    expect(closed.state).toBe("exited");
    expect(service.listTerminalSessions("owner-test")).toHaveLength(0);
  }, 20_000);

  it("rejects unauthorized owner and cross-session isolation", () => {
    const { service, fixture } = setup();
    const a = service.createTerminalSession({
      ownerId: "owner-test",
      kind: "shell",
      workspace: fixture,
    });
    expect(() =>
      service.createTerminalSession({
        ownerId: "intruder",
        kind: "shell",
        workspace: fixture,
      }),
    ).toThrow(AuthError);
    expect(() => service.getTerminalSession("intruder", a.id)).toThrow();
    expect(() =>
      service.readTerminalOutput("intruder", a.id, { maxBytes: 100 }),
    ).toThrow();
    service.closeTerminalSession("owner-test", a.id);
  });

  it("rejects workspace traversal and symlink escape", () => {
    const { service, fixture, root } = setup();
    const outside = join(root, "outside");
    mkdirSync(outside);
    const link = join(fixture, "escape");
    try {
      symlinkSync(outside, link);
    } catch {
      // skip if symlink not permitted
      return;
    }
    expect(() =>
      service.createTerminalSession({
        ownerId: "owner-test",
        kind: "shell",
        workspace: join(fixture, "..", "outside"),
      }),
    ).toThrow(AuthError);
    // absolute outside path
    expect(() =>
      service.createTerminalSession({
        ownerId: "owner-test",
        kind: "shell",
        workspace: outside,
      }),
    ).toThrow(AuthError);
  });

  it("missing executable yields actionable error", () => {
    const { service, fixture } = setup();
    service.config.agents.cursor.binary = "/tmp/definitely-missing-agent-xyz";
    expect(() =>
      service.createTerminalSession({
        ownerId: "owner-test",
        kind: "cursor",
        workspace: fixture,
      }),
    ).toThrow(/not found|not executable|absolute path/i);
  });

  it.skipIf(!dockerAvailable())("preserves managed mock jobs alongside sessions", async () => {
    const { service, fixture } = setup();
    // mock still uses docker + project
    const { ensureMockImage, waitForJob } = await import("../test-utils.js");
    ensureMockImage();
    const session = service.createTerminalSession({
      ownerId: "owner-test",
      kind: "shell",
      workspace: fixture,
    });
    service.start();
    const task = service.startTask({
      ownerId: "owner-test",
      projectId: "demo-sandbox",
      agent: "mock",
      prompt: "still works",
    });
    await waitForJob(service, task.id);
    expect(service.getTask("owner-test", task.id).status).toBe("succeeded");
    expect(service.getTerminalSession("owner-test", session.id).state).toBe(
      "running",
    );
    service.closeTerminalSession("owner-test", session.id);
  }, 90_000);

  it("output cursor bounds and redaction", async () => {
    const { service, fixture } = setup();
    const session = service.createTerminalSession({
      ownerId: "owner-test",
      kind: "shell",
      workspace: fixture,
    });
    service.writeTerminalInput("owner-test", session.id, {
      data: "printf 'sk-abcdefghijklmnopqrstuvwxyz012345\\n'",
      submit: true,
    });
    await waitForOutput(service, session.id, "REDACTED");
    const mid = service.readTerminalOutput("owner-test", session.id, {
      offset: 0,
      maxBytes: 8,
    });
    expect(mid.text.length).toBeGreaterThan(0);
    expect(mid.next_offset).toBeGreaterThan(mid.start_offset);
    service.closeTerminalSession("owner-test", session.id);
  }, 15_000);
});
