import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

export type Yg3OAuthMetadataFile = {
  client?: OAuthClientInformationFull;
  oauthState?: string;
  codeVerifier?: string;
  redirectUri?: string;
};

export class Yg3MetadataStore {
  constructor(private readonly filePath: string) {}

  static defaultPath(relayDataDir: string): Yg3MetadataStore {
    return new Yg3MetadataStore(join(relayDataDir, "yg3", "oauth-client.json"));
  }

  load(): Yg3OAuthMetadataFile {
    try {
      const raw = readFileSync(this.filePath, "utf8");
      return JSON.parse(raw) as Yg3OAuthMetadataFile;
    } catch {
      return {};
    }
  }

  save(data: Yg3OAuthMetadataFile): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(data, null, 2), "utf8");
    try {
      chmodSync(this.filePath, 0o600);
    } catch {
      /* windows / sandbox */
    }
    try {
      chmodSync(dirname(this.filePath), 0o700);
    } catch {
      /* ignore */
    }
  }

  clearPkceSession(): void {
    const cur = this.load();
    this.save({
      ...cur,
      oauthState: undefined,
      codeVerifier: undefined,
      redirectUri: undefined,
    });
  }
}
