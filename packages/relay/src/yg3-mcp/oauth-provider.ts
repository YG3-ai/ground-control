import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Yg3MetadataStore } from "./metadata-store.js";
import type { TokenStore } from "./token-store.js";

export type Yg3OAuthProviderOptions = {
  redirectUrl: string;
  metadataStore: Yg3MetadataStore;
  tokenStore: TokenStore;
  clientName?: string;
};

export class Yg3OAuthProvider implements OAuthClientProvider {
  readonly redirectUrl: string;
  private readonly metadataStore: Yg3MetadataStore;
  private readonly tokenStore: TokenStore;
  private readonly clientName: string;

  constructor(opts: Yg3OAuthProviderOptions) {
    this.redirectUrl = opts.redirectUrl;
    this.metadataStore = opts.metadataStore;
    this.tokenStore = opts.tokenStore;
    this.clientName = opts.clientName ?? "Ground Control";
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.clientName,
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.metadataStore.load().client;
  }

  saveClientInformation(
    clientInformation: OAuthClientInformationMixed,
  ): void {
    const cur = this.metadataStore.load();
    this.metadataStore.save({
      ...cur,
      client: clientInformation as OAuthClientInformationFull,
    });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return this.tokenStore.load();
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.tokenStore.save(tokens);
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    const { execFile } = await import("node:child_process");
    await new Promise<void>((resolve, reject) => {
      execFile("open", [authorizationUrl.toString()], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    const cur = this.metadataStore.load();
    this.metadataStore.save({ ...cur, codeVerifier });
  }

  async codeVerifier(): Promise<string> {
    const v = this.metadataStore.load().codeVerifier;
    if (!v) throw new Error("pkce_verifier_missing");
    return v;
  }

  state(): string {
    const cur = this.metadataStore.load();
    if (!cur.oauthState) throw new Error("oauth_state_missing");
    return cur.oauthState;
  }

  setPkceSession(state: string, redirectUri: string): void {
    const cur = this.metadataStore.load();
    this.metadataStore.save({
      ...cur,
      oauthState: state,
      redirectUri,
    });
  }

  getRedirectUriFromSession(): string {
    return this.metadataStore.load().redirectUri ?? this.redirectUrl;
  }
}
