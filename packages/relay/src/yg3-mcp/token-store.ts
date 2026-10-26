import { spawn } from "node:child_process";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  buildKeychainAddArgs,
  buildKeychainDeleteArgs,
  buildKeychainFindArgs,
} from "./keychain.js";

export type TokenStore = {
  load(): Promise<OAuthTokens | undefined>;
  save(tokens: OAuthTokens): Promise<void>;
  clear(): Promise<void>;
  hasTokens(): Promise<boolean>;
};

export class MemoryTokenStore implements TokenStore {
  private tokens: OAuthTokens | undefined;

  async load(): Promise<OAuthTokens | undefined> {
    return this.tokens;
  }

  async save(tokens: OAuthTokens): Promise<void> {
    this.tokens = tokens;
  }

  async clear(): Promise<void> {
    this.tokens = undefined;
  }

  async hasTokens(): Promise<boolean> {
    return Boolean(this.tokens?.access_token);
  }
}

export class KeychainTokenStore implements TokenStore {
  async load(): Promise<OAuthTokens | undefined> {
    const json = await this.readSecret();
    if (!json) return undefined;
    try {
      return JSON.parse(json) as OAuthTokens;
    } catch {
      return undefined;
    }
  }

  async save(tokens: OAuthTokens): Promise<void> {
    const payload = JSON.stringify(tokens);
    await this.runSecurity(buildKeychainAddArgs(payload));
  }

  async clear(): Promise<void> {
    await this.runSecurity(buildKeychainDeleteArgs(), true);
  }

  async hasTokens(): Promise<boolean> {
    const code = await this.runSecurity(buildKeychainFindArgs(), true);
    return code === 0;
  }

  private readSecret(): Promise<string | undefined> {
    return new Promise((resolve, reject) => {
      const args = [...buildKeychainFindArgs(), "-w"];
      const child = spawn("security", args, { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (c) => {
        out += String(c);
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) resolve(undefined);
        else resolve(out.trim() || undefined);
      });
    });
  }

  private runSecurity(args: string[], allowFail = false): Promise<number> {
    return new Promise((resolve, reject) => {
      const child = spawn("security", args, { stdio: "ignore" });
      child.on("error", reject);
      child.on("close", (code) => {
        if (!allowFail && code !== 0) {
          reject(new Error("keychain_command_failed"));
        } else {
          resolve(code ?? 1);
        }
      });
    });
  }
}
