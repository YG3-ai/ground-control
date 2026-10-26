import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  WorkerService,
  RelayClient,
  dockerAvailable,
  ensureMockImage,
  initGitFixture,
  makeTempRoot,
  waitForJob,
  buildTestConfig,
} from "@agent-control/worker";
import { startRelay } from "./server.js";
import type { RelayConfig } from "./config.js";

describe.skipIf(!dockerAvailable())("relay + worker e2e (authenticated)", () => {
  const root = makeTempRoot();
  const fixture = join(root, "fixture");
  let relay: Awaited<ReturnType<typeof startRelay>>;
  let service: WorkerService;
  let client: RelayClient;
  let token: string;
  const port = 18787;

  beforeAll(async () => {
    ensureMockImage();
    mkdirSync(fixture);
    initGitFixture(fixture);

    const cfg: RelayConfig = {
      host: "127.0.0.1",
      port,
      publicBaseUrl: `http://127.0.0.1:${port}`,
      jwtSecret: "test-jwt-secret-at-least-32-chars-long!!",
      workerToken: "test-worker-token-at-least-24c",
      ownerId: "owner-test",
      ownerApprovalSecret: "approval-secret-test",
      boardViewSecret: "approval-secret-test",
      boardPublicReadOnly: false,
      boardUnlockPasswordHash: null,
      allowDevToken: true,
      dataDir: join(root, "relay-data"),
      publicRepoUrl: "https://github.com/YG3-ai/ground-control",
      publicDonationUrl: null,
    };
    relay = await startRelay(cfg);

    const workerCfg = buildTestConfig(root, fixture);
    workerCfg.owner.id = "owner-test";
    workerCfg.relay.url = `ws://127.0.0.1:${port}/worker`;
    service = new WorkerService({
      config: workerCfg,
      dbPath: join(root, "data", "worker", "jobs.db"),
      configRoot: root,
    });
    service.start();
    client = new RelayClient(workerCfg.relay.url, cfg.workerToken, service);
    client.start();

    const start = Date.now();
    while (!relay.hub.connected && Date.now() - start < 10_000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(relay.hub.connected).toBe(true);

    const tokRes = await fetch(`http://127.0.0.1:${port}/oauth/dev/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approval_secret: cfg.ownerApprovalSecret }),
    });
    expect(tokRes.status).toBe(200);
    const body = (await tokRes.json()) as { access_token: string };
    token = body.access_token;
  }, 60_000);

  afterAll(async () => {
    client?.stop();
    service?.close();
    await relay?.close();
  });

  it("rejects unauthenticated MCP traffic", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects wrong worker token", async () => {
    const { default: WebSocket } = await import("ws");
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/worker`);
      ws.on("open", () => {
        ws.send(
          JSON.stringify({
            type: "hello",
            worker_id: "bad",
            token: "wrong-token-wrong-token-xx",
          }),
        );
      });
      ws.on("close", (code) => {
        expect(code).toBe(4003);
        resolve();
      });
      ws.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 5000);
    });
  });

  it("lists projects and starts a mock job via worker RPC", async () => {
    const projects = (await relay.hub.request(
      "list_projects",
      {},
      "owner-test",
    )) as { aliases: { id: string }[]; enabled_agents: string[] };
    expect(projects.aliases.some((a) => a.id === "demo-sandbox")).toBe(true);
    expect(projects.enabled_agents).toContain("mock");

    const task = (await relay.hub.request(
      "start_task",
      {
        projectId: "demo-sandbox",
        agent: "mock",
        prompt: "e2e via relay",
        idempotencyKey: "e2e-1",
      },
      "owner-test",
    )) as { id: string };

    expect(task.id).toBeTruthy();
    await waitForJob(service, task.id);
    const done = (await relay.hub.request(
      "get_task",
      { jobId: task.id },
      "owner-test",
    )) as { status: string };
    expect(done.status).toBe("succeeded");

    const again = (await relay.hub.request(
      "start_task",
      {
        projectId: "demo-sandbox",
        agent: "mock",
        prompt: "e2e via relay",
        idempotencyKey: "e2e-1",
      },
      "owner-test",
    )) as { id: string };
    expect(again.id).toBe(task.id);
  });

  it("healthz documents phone VPN limitation", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    const body = (await res.json()) as { note: string; board_url?: string };
    expect(body.note).toMatch(/phone VPN/i);
    expect(body.board_url).toBe(`http://127.0.0.1:${port}`);
    expect(token.length).toBeGreaterThan(20);
  });

  it("serves phone board API with board view secret", async () => {
    const bad = await fetch(`http://127.0.0.1:${port}/api/board?k=wrong`);
    expect(bad.status).toBe(401);
    const ok = await fetch(
      `http://127.0.0.1:${port}/api/board?k=approval-secret-test`,
    );
    expect(ok.status).toBe(200);
    const setCookie = ok.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/gc_board_v=/);
    const body = (await ok.json()) as { health?: { worker?: boolean } };
    expect(body.health?.worker).toBe(true);
    // Cookie alone should unlock subsequent loads (phone "remember me")
    const viaCookie = await fetch(`http://127.0.0.1:${port}/api/board`, {
      headers: { cookie: setCookie.split(";")[0]! },
    });
    expect(viaCookie.status).toBe(200);
    const page = await fetch(`http://127.0.0.1:${port}/board`);
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toMatch(/no-store/i);
    const uiVer = page.headers.get("x-ground-ui-version");
    expect(uiVer).toMatch(/^[a-f0-9]{16}$/);
    const root = await fetch(`http://127.0.0.1:${port}/`);
    expect(root.status).toBe(200);
    expect(root.headers.get("cache-control")).toMatch(/no-store/i);
    expect(root.headers.get("x-ground-ui-version")).toBe(uiVer);
    const html = await page.text();
    expect(html).toBe(await root.text());
    expect(html).toMatch(/Password/i);
    expect(html).toMatch(/\/api\/board\/unlock/);
    expect(html).toMatch(/safe-area-inset/);
    expect(html).toContain(`content="${uiVer}"`);
    expect(ok.headers.get("x-ground-ui-version")).toBe(uiVer);
  });

  it("serves PWA manifest and apple touch icon", async () => {
    const manifest = await fetch(`http://127.0.0.1:${port}/manifest.webmanifest`);
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get("content-type")).toContain("manifest+json");
    const m = (await manifest.json()) as {
      name?: string;
      icons?: unknown[];
      start_url?: string;
    };
    expect(m.name).toBe("Ground Control");
    expect(m.start_url).toBe("/");
    expect(Array.isArray(m.icons) && m.icons.length).toBeTruthy();

    const icon = await fetch(`http://127.0.0.1:${port}/apple-touch-icon.png`);
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toContain("image/png");
    const buf = Buffer.from(await icon.arrayBuffer());
    expect(buf.length).toBeGreaterThan(100);
    expect(buf.subarray(0, 4).toString("hex")).toBe("89504e47");

    const page = await fetch(`http://127.0.0.1:${port}/board`);
    const html = await page.text();
    expect(html).toContain('rel="manifest"');
    expect(html).toContain('rel="apple-touch-icon"');
    expect(html).toMatch(/Needs you/);
    expect(html).toMatch(/No decisions waiting/);
    expect(html).toMatch(/Completed/);
    expect(html).toMatch(/Operations/);
    expect(html).toMatch(/World/);
    expect(html).toMatch(/Evolution/);
    expect(html).not.toMatch(/Rank /);
    expect(html).toMatch(/Missions/);
    expect(html).toMatch(/viewport-fit=cover/);
  });

  it("board approval endpoint: auth, validation, approve/deny, duplicates", async () => {
    const base = `http://127.0.0.1:${port}`;
    const key = "approval-secret-test";
    const makeApproval = async (title: string) => {
      const rec = (await service.requestLocalApproval({
        ownerId: "owner-test",
        kind: "permission",
        title,
        detail: "e2e credential check approval",
        wait: false,
      })) as { id: string; status: string };
      expect(rec.status).toBe("pending");
      return rec.id;
    };
    const post = (id: string, body: unknown, withKey = true) =>
      fetch(`${base}/api/board/approvals/${id}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(withKey ? { "x-ground-board-key": key } : {}),
        },
        body: JSON.stringify(body),
      });

    // auth fail-closed
    const idAuth = await makeApproval("auth check");
    expect((await post(idAuth, { action: "approve" }, false)).status).toBe(401);

    // invalid action / id
    expect((await post(idAuth, { action: "maybe" })).status).toBe(400);
    expect((await post("%20", { action: "approve" })).status).toBe(400);

    // nonexistent id
    expect(
      (await post("00000000-0000-0000-0000-000000000000", { action: "approve" })).status,
    ).toBe(404);

    // approve flow
    const idA = await makeApproval("approve me");
    const okA = await post(idA, { action: "approve" });
    expect(okA.status).toBe(200);
    const bodyA = (await okA.json()) as { ok: boolean; approval: { status: string } };
    expect(bodyA.ok).toBe(true);
    expect(bodyA.approval.status).toBe("approved");
    expect(service.getApproval("owner-test", idA).status).toBe("approved");

    // duplicate resolve is 409, not success
    const dup = await post(idA, { action: "approve" });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { error: string }).error).toBe("already_resolved");

    // deny flow
    const idD = await makeApproval("deny me");
    const okD = await post(idD, { action: "deny" });
    expect(okD.status).toBe(200);
    expect(service.getApproval("owner-test", idD).status).toBe("denied");
    expect((await post(idD, { action: "deny" })).status).toBe(409);
  });

  it("creates a shell PTY session via worker RPC and reads a marker", async () => {
    const session = (await relay.hub.request(
      "create_terminal_session",
      { kind: "shell", workspace: fixture, idleSec: 120 },
      "owner-test",
    )) as { id: string; state: string };
    expect(session.state).toBe("running");

    await relay.hub.request(
      "write_terminal_input",
      {
        sessionId: session.id,
        data: "printf 'GROUND_E2E_MARKER\\n'",
        submit: true,
      },
      "owner-test",
    );

    let found = false;
    let offset = 0;
    const start = Date.now();
    while (Date.now() - start < 10_000) {
      const chunk = (await relay.hub.request(
        "read_terminal_output",
        { sessionId: session.id, offset, maxBytes: 16_384 },
        "owner-test",
      )) as { text: string; next_offset: number };
      if (chunk.text.includes("GROUND_E2E_MARKER")) {
        found = true;
        break;
      }
      offset = chunk.next_offset;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(found).toBe(true);

    const closed = (await relay.hub.request(
      "close_terminal_session",
      { sessionId: session.id },
      "owner-test",
    )) as { state: string };
    expect(closed.state).toBe("exited");
  }, 30_000);
});
