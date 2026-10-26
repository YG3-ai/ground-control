import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Response } from "express";
import { SignJWT, jwtVerify } from "jose";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { RelayConfig } from "../config.js";
import { OAuthStore } from "./store.js";

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function verifyPkce(verifier: string, challenge: string): boolean {
  const computed = createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return computed === challenge;
}

/**
 * Personal OAuth 2.1 authorization server for ChatGPT MCP.
 * Uses PKCE + DCR + refresh tokens. Single-owner approval via OWNER_APPROVAL_SECRET.
 */
export class PersonalOAuthProvider implements OAuthServerProvider {
  private readonly secret: Uint8Array;

  constructor(
    private readonly cfg: RelayConfig,
    private readonly store: OAuthStore,
  ) {
    this.secret = new TextEncoder().encode(cfg.jwtSecret);
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: async (clientId) => this.store.getClient(clientId),
      registerClient: async (client) => {
        const full: OAuthClientInformationFull = {
          ...client,
          client_id: randomUUID(),
          client_id_issued_at: Math.floor(Date.now() / 1000),
        };
        this.store.saveClient(full);
        return full;
      },
    };
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    // Simple approval page — owner must present the approval secret.
    const resource = params.resource?.toString() ?? "";
    const scopes = (params.scopes ?? ["agent-control"]).join(" ");
    const submitUrl = `${this.cfg.publicBaseUrl}/authorize/submit`;
    const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Approve Ground Control</title>
<style>
  body{font-family:system-ui;max-width:420px;margin:3rem auto;padding:0 1rem}
  input,button{display:block;width:100%;margin:.5rem 0;padding:.6rem;font-size:1rem}
  .warn{color:#833;font-size:.9rem}
</style></head><body>
<h1>Approve Ground Control</h1>
<p>ChatGPT client <code>${escapeHtml(client.client_id)}</code> wants access to agents on your Mac.</p>
<p class="warn">Only approve if you initiated this from your ChatGPT account.</p>
<form method="POST" action="${escapeHtml(submitUrl)}">
  <input type="hidden" name="client_id" value="${escapeHtml(client.client_id)}" />
  <input type="hidden" name="redirect_uri" value="${escapeHtml(params.redirectUri)}" />
  <input type="hidden" name="state" value="${escapeHtml(params.state ?? "")}" />
  <input type="hidden" name="code_challenge" value="${escapeHtml(params.codeChallenge)}" />
  <input type="hidden" name="resource" value="${escapeHtml(resource)}" />
  <input type="hidden" name="scopes" value="${escapeHtml(scopes)}" />
  <label>Owner approval secret</label>
  <input type="password" name="approval_secret" required autocomplete="current-password" />
  <button type="submit">Approve</button>
</form>
</body></html>`;
    res.status(200).type("html").send(html);
  }

  /** Called by /authorize/submit after the owner approves. */
  issueCodeFromApproval(input: {
    clientId: string;
    redirectUri: string;
    state?: string;
    codeChallenge: string;
    resource?: string;
    scopes: string;
    approvalSecret: string;
  }): { redirectTo: string } {
    if (input.approvalSecret !== this.cfg.ownerApprovalSecret) {
      throw new Error("invalid approval secret");
    }
    const client = this.store.getClient(input.clientId);
    if (!client) throw new Error("unknown client");
    if (!client.redirect_uris.includes(input.redirectUri)) {
      throw new Error("redirect_uri not registered");
    }
    const code = randomBytes(24).toString("base64url");
    this.store.saveAuthCode({
      code,
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
      code_challenge: input.codeChallenge,
      resource: input.resource || null,
      scopes: input.scopes,
      expires_at: Date.now() + 5 * 60_000,
    });
    const url = new URL(input.redirectUri);
    url.searchParams.set("code", code);
    if (input.state) url.searchParams.set("state", input.state);
    return { redirectTo: url.toString() };
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const row = this.store.peekAuthCode(authorizationCode);
    if (!row || row.expires_at < Date.now()) {
      throw new Error("invalid authorization code");
    }
    return row.code_challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const row = this.store.takeAuthCode(authorizationCode);
    if (!row || row.expires_at < Date.now()) {
      throw new Error("invalid authorization code");
    }
    if (row.client_id !== client.client_id) throw new Error("client mismatch");
    if (redirectUri && row.redirect_uri !== redirectUri) {
      throw new Error("redirect_uri mismatch");
    }
    // MCP SDK token handler already verifies PKCE and then calls us with
    // codeVerifier=undefined. Only re-check when a verifier is supplied.
    if (codeVerifier && !verifyPkce(codeVerifier, row.code_challenge)) {
      throw new Error("pkce verification failed");
    }
    const resourceStr = resource?.toString() ?? row.resource ?? undefined;
    return this.mintTokens({
      clientId: client.client_id,
      scopes: row.scopes.split(" ").filter(Boolean),
      resource: resourceStr,
    });
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const hash = sha256(refreshToken);
    const row = this.store.getToken(hash);
    if (!row || row.kind !== "refresh" || row.expires_at < Date.now()) {
      throw new Error("invalid refresh token");
    }
    if (row.client_id !== client.client_id) throw new Error("client mismatch");
    this.store.deleteToken(hash);
    return this.mintTokens({
      clientId: client.client_id,
      scopes: scopes ?? row.scopes.split(" ").filter(Boolean),
      resource: resource?.toString() ?? row.resource ?? undefined,
    });
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const { payload } = await jwtVerify(token, this.secret, {
      algorithms: ["HS256"],
      audience: this.cfg.publicBaseUrl + "/mcp",
      issuer: this.cfg.publicBaseUrl,
    });
    const hash = sha256(token);
    const row = this.store.getToken(hash);
    if (!row || row.kind !== "access" || row.expires_at < Date.now()) {
      throw new Error("token revoked or expired");
    }
    const resource = row.resource ? new URL(row.resource) : new URL(this.cfg.publicBaseUrl + "/mcp");
    return {
      token,
      clientId: String(payload.client_id ?? row.client_id),
      scopes: row.scopes.split(" ").filter(Boolean),
      expiresAt: Math.floor(row.expires_at / 1000),
      resource,
      extra: { owner_id: row.owner_id },
    };
  }

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    this.store.deleteToken(sha256(request.token));
  }

  async mintTokens(input: {
    clientId: string;
    scopes: string[];
    resource?: string;
  }): Promise<OAuthTokens> {
    const resource = input.resource ?? this.cfg.publicBaseUrl + "/mcp";
    const now = Math.floor(Date.now() / 1000);
    const expiresIn = 3600;
    const access = await new SignJWT({
      client_id: input.clientId,
      owner_id: this.cfg.ownerId,
      scope: input.scopes.join(" "),
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(this.cfg.publicBaseUrl)
      .setAudience(this.cfg.publicBaseUrl + "/mcp")
      .setSubject(this.cfg.ownerId)
      .setIssuedAt(now)
      .setExpirationTime(now + expiresIn)
      .setJti(randomUUID())
      .sign(this.secret);

    const refresh = randomBytes(32).toString("base64url");
    this.store.saveToken({
      token_hash: sha256(access),
      kind: "access",
      client_id: input.clientId,
      owner_id: this.cfg.ownerId,
      scopes: input.scopes.join(" "),
      resource,
      expires_at: (now + expiresIn) * 1000,
      refresh_of: null,
    });
    this.store.saveToken({
      token_hash: sha256(refresh),
      kind: "refresh",
      client_id: input.clientId,
      owner_id: this.cfg.ownerId,
      scopes: input.scopes.join(" "),
      resource,
      expires_at: (now + 30 * 24 * 3600) * 1000,
      refresh_of: sha256(access),
    });

    return {
      access_token: access,
      token_type: "bearer",
      expires_in: expiresIn,
      refresh_token: refresh,
      scope: input.scopes.join(" "),
    };
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
