import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isTrustedClientUuid } from "./envelope-parsers.js";
import type { Yg3PrincipalTier } from "./workspace-principal.js";
import type { WorkspaceAccountKind } from "./workspace-account-kind.js";

export const WORKSPACE_SEARCH_SESSION_VERSION = 1;

export type WorkspaceSearchSessionEntry = {
  ref: number;
  clientId: string;
  accountKind: WorkspaceAccountKind;
};

export type WorkspaceSearchSessionV1 = {
  version: typeof WORKSPACE_SEARCH_SESSION_VERSION;
  tenantKey: string;
  userKey: string;
  principalTier: Yg3PrincipalTier;
  query: string;
  createdAt: string;
  entries: WorkspaceSearchSessionEntry[];
};

export class WorkspaceSearchSessionStore {
  constructor(private readonly filePath: string) {}

  static defaultPath(relayDataDir: string): WorkspaceSearchSessionStore {
    return new WorkspaceSearchSessionStore(
      join(relayDataDir, "yg3", "workspace-search-session.json"),
    );
  }

  load(): WorkspaceSearchSessionV1 | null {
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const data = JSON.parse(raw) as WorkspaceSearchSessionV1;
      if (data.version !== WORKSPACE_SEARCH_SESSION_VERSION) return null;
      if (!Array.isArray(data.entries)) return null;
      for (const e of data.entries) {
        if (!isTrustedClientUuid(e.clientId)) return null;
      }
      return data;
    } catch {
      return null;
    }
  }

  save(session: WorkspaceSearchSessionV1): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    try {
      chmodSync(dirname(this.filePath), 0o700);
    } catch {
      /* ignore */
    }
    writeFileSync(this.filePath, JSON.stringify(session, null, 2), "utf8");
    try {
      chmodSync(this.filePath, 0o600);
    } catch {
      /* ignore */
    }
  }
}
