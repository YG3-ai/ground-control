import express from "express";
import { createServer } from "node:http";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BOARD_COOKIE, boardReadAuth, boardWriteAuth } from "./board-auth.js";
import { BoardUnlockRateLimiter, registerBoardUnlockRoute } from "./board-unlock.js";
import {
  applyBoardPasswordUnlock,
  applyBoardPublicPreview,
  applyBoardPublicUrls,
  createBoardHtmlLoader,
} from "./board-html-loader.js";
import { WebSocketServer } from "ws";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { WorkerMessage } from "@agent-control/shared";
import type { RelayConfig } from "./config.js";
import { OAuthStore } from "./oauth/store.js";
import { PersonalOAuthProvider } from "./oauth/provider.js";
import { WorkerHub } from "./worker-hub.js";
import { registerTools } from "./mcp/tools.js";
import { registerBoardExtensionRoutes } from "./board-extensions/routes.js";
import { publicBoardFeedDemo } from "./board-extensions/public-demo.js";
import {
  isPublicBoardAudience,
  redactBoardForPublic,
} from "./board-extensions/public-redact.js";
import { registerEvolutionRoutes } from "./board-extensions/evolution.js";
import { registerWorldRoutes } from "./board-extensions/world.js";
import { resolveLifeMirrorAssetPath } from "./life-mirror-assets.js";

const RELAY_DIR = dirname(fileURLToPath(import.meta.url));

function sendLifeMirrorMp4(
  req: express.Request,
  res: express.Response,
  filePath: string,
): void {
  const stat = statSync(filePath);
  const total = stat.size;
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.type("video/mp4");

  const range = req.headers.range;
  if (!range) {
    res.setHeader("Content-Length", total);
    createReadStream(filePath).pipe(res);
    return;
  }

  const m = /^bytes=(\d+)-(\d*)$/.exec(range);
  if (!m) {
    res.status(416).setHeader("Content-Range", `bytes */${total}`).end();
    return;
  }
  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : total - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= total || end >= total || start > end) {
    res.status(416).setHeader("Content-Range", `bytes */${total}`).end();
    return;
  }
  const chunk = end - start + 1;
  res.status(206);
  res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
  res.setHeader("Content-Length", chunk);
  createReadStream(filePath, { start, end }).pipe(res);
}

export async function startRelay(cfg: RelayConfig): Promise<{
  close: () => Promise<void>;
  hub: WorkerHub;
  provider: PersonalOAuthProvider;
}> {
  const store = new OAuthStore(join(cfg.dataDir, "oauth.db"));
  const provider = new PersonalOAuthProvider(cfg, store);
  const hub = new WorkerHub();

  const app = express();
  // ngrok / tunnels set X-Forwarded-*; required for OAuth rate-limit middleware
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false }));

  const issuerUrl = new URL(cfg.publicBaseUrl);
  const resourceServerUrl = new URL(cfg.publicBaseUrl + "/mcp");
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceServerUrl);

  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl,
      baseUrl: issuerUrl,
      resourceServerUrl,
      resourceName: "Ground Control",
      scopesSupported: ["agent-control", "offline_access"],
    }),
  );

  app.post("/authorize/submit", (req, res) => {
    try {
      const body = req.body as Record<string, string>;
      const { redirectTo } = provider.issueCodeFromApproval({
        clientId: body.client_id ?? "",
        redirectUri: body.redirect_uri ?? "",
        state: body.state || undefined,
        codeChallenge: body.code_challenge ?? "",
        resource: body.resource || undefined,
        scopes: body.scopes || "agent-control",
        approvalSecret: (body.approval_secret ?? "").trim(),
      });
      console.log("[relay] oauth approved; redirecting to ChatGPT callback");
      res.redirect(302, redirectTo);
    } catch (err) {
      console.error("[relay] oauth approve failed:", err);
      res
        .status(400)
        .type("html")
        .send(
          `<p>Approval failed: ${String(err)}</p><p>Check OWNER_APPROVAL_SECRET and try connecting again from ChatGPT.</p>`,
        );
    }
  });

  // Dev-only token mint for automated tests. Never enable on a public deploy.
  app.post("/oauth/dev/token", async (req, res) => {
    if (!cfg.allowDevToken) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const secret = String((req.body as { approval_secret?: string }).approval_secret ?? "");
    if (secret !== cfg.ownerApprovalSecret) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const tokens = await provider.mintTokens({
      clientId: "dev-client",
      scopes: ["agent-control", "offline_access"],
      resource: resourceServerUrl.toString(),
    });
    res.json(tokens);
  });

  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      worker: hub.status(),
      public_base_url: cfg.publicBaseUrl,
      board_url: cfg.publicBaseUrl,
      note: `ChatGPT MCP uses /mcp over PUBLIC_BASE_URL (a phone VPN alone does not expose the Mac). Ground / Life Mirror UI: ${cfg.publicBaseUrl}/ (legacy /board). Owner key on first visit. Same UI on this Mac: http://${cfg.host}:${cfg.port}/ (full mission whiteboard stays on worker local_control port, usually 8788).`,
    });
  });

  // Phone-reachable live board (same public HTTPS as MCP).
  // Unlock once → HttpOnly gc_board_v cookie (~13 months). Public sites may use
  // POST /api/board/unlock (password hash in env) instead of exposing the board key.
  const boardHtmlLoader = createBoardHtmlLoader(RELAY_DIR);
  const manifestPath = join(RELAY_DIR, "manifest.webmanifest");
  const touchIconPath = join(RELAY_DIR, "apple-touch-icon.png");
  const manifestFallback = join(RELAY_DIR, "..", "src", "manifest.webmanifest");
  const touchIconFallback = join(
    RELAY_DIR,
    "..",
    "src",
    "apple-touch-icon.png",
  );

  const boardUnlockLimiter = new BoardUnlockRateLimiter();
  registerBoardUnlockRoute(app, cfg, boardUnlockLimiter);

  const sendBoardPage = (res: express.Response): void => {
    const served = boardHtmlLoader.serve();
    let body = applyBoardPublicPreview(served.body, cfg.boardPublicReadOnly);
    if (cfg.boardPublicReadOnly) {
      body = applyBoardPublicUrls(body, {
        repoUrl: cfg.publicRepoUrl,
        donationUrl: cfg.publicDonationUrl,
      });
    }
    body = applyBoardPasswordUnlock(
      body,
      cfg.boardPublicReadOnly && Boolean(cfg.boardUnlockPasswordHash),
    );
    res.setHeader("Cache-Control", "no-store");
    if (served.version) {
      res.setHeader("X-Ground-UI-Version", served.version);
    }
    if (cfg.boardPublicReadOnly) {
      res.setHeader("X-Ground-Board-Public", "1");
    }
    res.status(served.status).type("html").send(body);
  };

  app.get(["/", "/board", "/board/"], (_req, res) => {
    sendBoardPage(res);
  });
  app.get("/manifest.webmanifest", (_req, res) => {
    const path = existsSync(manifestPath) ? manifestPath : manifestFallback;
    try {
      res.type("application/manifest+json").send(readFileSync(path, "utf8"));
    } catch {
      res.status(404).json({ error: "not_found" });
    }
  });
  app.get("/apple-touch-icon.png", (_req, res) => {
    const path = existsSync(touchIconPath) ? touchIconPath : touchIconFallback;
    try {
      res.type("image/png").send(readFileSync(path));
    } catch {
      res.status(404).json({ error: "not_found" });
    }
  });

  app.get("/assets/life-mirror/:file", (req, res) => {
    let file = String(req.params.file ?? "");
    try {
      file = decodeURIComponent(file);
    } catch {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const path = resolveLifeMirrorAssetPath(RELAY_DIR, file);
    if (!path) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (file.endsWith(".mp4")) {
      sendLifeMirrorMp4(req, res, path);
      return;
    }
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.type("image/webp").send(readFileSync(path));
  });
  app.post("/api/board/logout", (_req, res) => {
    res.setHeader(
      "Set-Cookie",
      `${BOARD_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
    );
    res.json({ ok: true });
  });
  app.get("/api/board", async (req, res) => {
    const audience = boardReadAuth(req, res, cfg);
    if (!audience) return;
    if (!hub.connected) {
      if (isPublicBoardAudience(audience)) {
        res.json(publicBoardFeedDemo());
        return;
      }
      res.status(503).json({ error: "worker_offline" });
      return;
    }
    try {
      const board = (await hub.request("get_board", {}, cfg.ownerId, 20_000)) as Record<
        string,
        unknown
      >;
      const uiVer = boardHtmlLoader.uiVersion();
      if (uiVer) res.setHeader("X-Ground-UI-Version", uiVer);
      res.json(
        isPublicBoardAudience(audience) ? redactBoardForPublic(board) : board,
      );
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
  registerBoardExtensionRoutes(app, cfg, boardReadAuth, boardWriteAuth);
  registerEvolutionRoutes(app, cfg, hub);
  registerWorldRoutes(app, cfg, hub, boardReadAuth);

  app.post("/api/board/approvals/:id", async (req, res) => {
    if (!boardWriteAuth(req, res, cfg)) return;
    const id = String(req.params.id ?? "").trim();
    const action = String(
      (req.body as { action?: string })?.action ?? "",
    ).trim();
    if (!id) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    if (action !== "approve" && action !== "deny") {
      res.status(400).json({ error: "invalid_action" });
      return;
    }
    if (!hub.connected) {
      res.status(503).json({ error: "worker_offline" });
      return;
    }
    const decision = action === "approve" ? "approved" : "denied";
    try {
      const existing = (await hub.request(
        "get_approval",
        { approvalId: id },
        cfg.ownerId,
        10_000,
      )) as { status: string };
      if (existing.status !== "pending") {
        res.status(409).json({ error: "already_resolved", status: existing.status });
        return;
      }
      const rec = await hub.request(
        "resolve_approval",
        {
          approvalId: id,
          decision,
          note: `phone-board:${decision}`,
        },
        cfg.ownerId,
        15_000,
      );
      res.json({ ok: true, approval: rec });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("approval not found")) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.status(502).json({ error: msg });
    }
  });

  const bearer = requireBearerAuth({
    verifier: provider,
    requiredScopes: ["agent-control"],
    resourceMetadataUrl,
    expectedResource: resourceServerUrl,
  });

  app.all("/mcp", bearer, async (req, res) => {
    try {
      await handleMcpRequest(req, res, req.body);
    } catch (err) {
      console.error("[relay] mcp handler error:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal error" },
          id: null,
        });
      }
    }
  });

  async function handleMcpRequest(
    req: express.Request,
    res: express.Response,
    body: unknown,
  ): Promise<void> {
    const server = new McpServer(
      {
        name: "ground-control",
        version: "0.1.0",
      },
      {
        instructions: [
          "You are Ground Control — the owner's phone-side coordinator for work on their Mac. Cursor/Kimi are the hands; you are the PM.",
          "DEFAULT LOOP (hybrid_remote approval policy): (1) create_mission with title/goal/workspace + markers. (2) status=researching; create_terminal_session/start_task for scoped research; update_mission findings + link ids — no Mac plan dialog for routine reads/tests inside the mission workspace. (3) Show the plan in chat AND update_mission status=plan_ready with plan text. (4) After explicit owner consent in this thread, approve_mission with authorization=chat_explicit (records approval_policy=hybrid_remote; no Mac dialog). Use require_dialog=true only when the owner asks to approve locally. Do not re-approve an already-approved mission. (5) status=implementing; execute via Cursor/terminal within approved_scope; no repeated plan approvals. (6) complete_mission + notify_owner. Sensitive actions (destructive, external send/deploy, credentials, scope expansion): explain in chat, request_local_approval, pause if owner is away — never downgrade to chat-only approval.",
          "Situational awareness: get_situation first and when re-orienting (missions, PTY tails, jobs, approvals). Owner watches the live Ground / Life Mirror board on phone at PUBLIC_BASE_URL (or Mac localhost:8788 whiteboard) — you use tools, not the cloud browser, for that data.",
          "Interactive work: create_terminal_session for multi-turn Cursor/shell. Paste thread goals into writes — Cursor does not see this ChatGPT chat automatically.",
          "Approvals (hybrid_remote): chat-explicit mission approval via approve_mission authorization=chat_explicit; Mac dialogs via require_dialog/local_dialog or request_local_approval for sensitive actions only. notify_owner for banners. open_url still requires Mac approval by default.",
          "Credits: call get_usage before Cursor/Kimi batches. Prefer start_task tier=research (Cursor ask + cheap model) for gather-info; tier=bugfix/implement for writes. Kimi is paced for the rolling 5h window (max starts + min gap); if run_next_bugfix returns started=false, wait retry_after_sec — do not spam retries.",
          "Client bugs (Far Beyond, Currency, other email): ingest_client_request(client, subject, body) → run_next_bugfix when budget allows → when a batch finishes, draft_client_update(client) and show the draft in chat for the owner to send (or once/day). Mark client request done via update after verifying the fix summary.",
          "Prefer one mission + one long-lived terminal over many disconnected start_task jobs. Confirm tool results before claiming success.",
        ].join(" "),
      },
    );
    registerTools(server, hub, cfg.ownerId);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer, path: "/worker" });

  wss.on("connection", (ws, req) => {
    let authed = false;
    const timer = setTimeout(() => {
      if (!authed) ws.close(4001, "auth timeout");
    }, 10_000);

    ws.on("message", (raw) => {
      let msg: WorkerMessage;
      try {
        msg = JSON.parse(String(raw)) as WorkerMessage;
      } catch {
        ws.close(4002, "bad json");
        return;
      }

      if (!authed) {
        if (msg.type !== "hello" || msg.token !== cfg.workerToken) {
          ws.close(4003, "unauthorized worker");
          return;
        }
        authed = true;
        clearTimeout(timer);
        hub.attach(ws, msg.worker_id);
        ws.send(JSON.stringify({ type: "ping" }));
        const keepAlive = setInterval(() => {
          if (ws.readyState !== 1) return;
          ws.send(JSON.stringify({ type: "ping" }));
        }, 25_000);
        ws.on("close", () => clearInterval(keepAlive));
        return;
      }

      hub.handleWorkerMessage(msg);
    });

    void req;
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(cfg.port, cfg.host, () => resolve());
  });

  console.log(
    `[relay] listening on http://${cfg.host}:${cfg.port} public=${cfg.publicBaseUrl}`,
  );
  if (cfg.allowDevToken) {
    console.warn("[relay] ALLOW_DEV_TOKEN=1 — disable before any public deploy");
  }

  return {
    hub,
    provider,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
      store.close();
    },
  };
}
