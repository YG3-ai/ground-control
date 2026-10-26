import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import {
  YG3_AUTHORIZATION_SERVER,
  YG3_OAUTH_SCOPE,
} from "./constants.js";
import type { Yg3MetadataStore } from "./metadata-store.js";
import type { Yg3OAuthProvider } from "./oauth-provider.js";
import { validateYg3McpUrl } from "./url.js";

export type LoginFlowOptions = {
  mcpUrl: URL;
  provider: Yg3OAuthProvider;
  metadataStore: Yg3MetadataStore;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  openBrowser?: (url: string) => Promise<void>;
};

export type LoginFlowResult =
  | { ok: true }
  | { ok: false; error: string };

function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1";
}

export async function runYg3LoginFlow(
  opts: LoginFlowOptions,
): Promise<LoginFlowResult> {
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const fetchFn = opts.fetchFn ?? fetch;
  validateYg3McpUrl(opts.mcpUrl.toString());

  const state = randomBytes(24).toString("hex");
  const serverInfo = await discoverOAuthServerInfo(opts.mcpUrl, { fetchFn });
  const authorizationServerUrl =
    serverInfo.authorizationServerUrl || YG3_AUTHORIZATION_SERVER;

  let clientInfo = opts.provider.clientInformation();
  if (!clientInfo?.client_id) {
    const registered = await registerClient(authorizationServerUrl, {
      metadata: serverInfo.authorizationServerMetadata,
      clientMetadata: opts.provider.clientMetadata,
      scope: YG3_OAUTH_SCOPE,
      fetchFn,
    });
    await opts.provider.saveClientInformation(registered);
    clientInfo = registered;
  }

  return new Promise<LoginFlowResult>((resolve) => {
    const httpServer = createServer();
    const timer = setTimeout(() => {
      finish({ ok: false, error: "login_timeout" });
    }, timeoutMs);

    function finish(result: LoginFlowResult) {
      clearTimeout(timer);
      httpServer.close(() => resolve(result));
    }

    httpServer.listen(0, "127.0.0.1", async () => {
      const addr = httpServer.address();
      if (!addr || typeof addr === "string") {
        finish({ ok: false, error: "listen_failed" });
        return;
      }
      const redirectUri = `http://127.0.0.1:${addr.port}/callback`;
      opts.provider.setPkceSession(state, redirectUri);

      try {
        const { authorizationUrl, codeVerifier } = await startAuthorization(
          authorizationServerUrl,
          {
            metadata: serverInfo.authorizationServerMetadata,
            clientInformation: clientInfo!,
            redirectUrl: redirectUri,
            scope: YG3_OAUTH_SCOPE,
            state,
            resource: opts.mcpUrl,
          },
        );
        const cur = opts.metadataStore.load();
        opts.metadataStore.save({ ...cur, codeVerifier, oauthState: state });

        const open = opts.openBrowser ?? defaultOpenBrowser;
        await open(authorizationUrl.toString());
      } catch {
        finish({ ok: false, error: "authorization_start_failed" });
        return;
      }
    });

    httpServer.on("request", (req, res) => {
      const host = req.headers.host?.split(":")[0] ?? "";
      if (!isLoopbackHost(host)) {
        res.statusCode = 403;
        res.end("forbidden");
        finish({ ok: false, error: "non_loopback_callback" });
        return;
      }
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      if (url.pathname !== "/callback") {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      const returnedState = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      if (!code || returnedState !== state) {
        res.statusCode = 400;
        res.end("invalid callback");
        finish({ ok: false, error: "invalid_oauth_callback" });
        return;
      }
      void (async () => {
        try {
          const session = opts.metadataStore.load();
          const verifier = session.codeVerifier;
          if (!verifier) throw new Error("pkce_missing");
          const tokens = await exchangeAuthorization(authorizationServerUrl, {
            metadata: serverInfo.authorizationServerMetadata,
            clientInformation: clientInfo!,
            authorizationCode: code,
            codeVerifier: verifier,
            redirectUri: opts.provider.getRedirectUriFromSession(),
            resource: opts.mcpUrl,
            fetchFn,
          });
          await opts.provider.saveTokens(tokens);
          opts.metadataStore.clearPkceSession();
          res.statusCode = 200;
          res.end("YG3 login complete. You can close this tab.");
          finish({ ok: true });
        } catch {
          res.statusCode = 500;
          res.end("login failed");
          finish({ ok: false, error: "token_exchange_failed" });
        }
      })();
    });
  });
}

async function defaultOpenBrowser(url: string): Promise<void> {
  const { execFile } = await import("node:child_process");
  await new Promise<void>((resolve, reject) => {
    execFile("open", [url], (err) => (err ? reject(err) : resolve()));
  });
}
