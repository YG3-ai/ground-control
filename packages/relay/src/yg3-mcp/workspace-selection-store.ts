import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { isTrustedClientUuid } from "./envelope-parsers.js";
import type { Yg3PrincipalTier } from "./workspace-principal.js";

export const WORKSPACE_SELECTION_VERSION = 1;

export type WorkspaceSelectionV1 = {
  version: typeof WORKSPACE_SELECTION_VERSION;
  tenantKey: string;
  userKey: string;
  principalTier: Yg3PrincipalTier;
  clientId: string;
  selectionBasis: string;
  normalizedSlug: string | null;
  displayNameCorroborated: boolean;
  accountKind: "client";
  selectedAt: string;
};

export class WorkspaceSelectionStore {
  constructor(private readonly filePath: string) {}

  static defaultPath(relayDataDir: string): WorkspaceSelectionStore {
    return new WorkspaceSelectionStore(
      join(relayDataDir, "yg3", "workspace-selection.json"),
    );
  }

  load(): WorkspaceSelectionV1 | null {
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const data = JSON.parse(raw) as WorkspaceSelectionV1;
      if (data.version !== WORKSPACE_SELECTION_VERSION) return null;
      if (!isTrustedClientUuid(data.clientId)) return null;
      return data;
    } catch {
      return null;
    }
  }

  save(selection: WorkspaceSelectionV1): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    try {
      chmodSync(dirname(this.filePath), 0o700);
    } catch {
      /* ignore */
    }
    writeFileSync(this.filePath, JSON.stringify(selection, null, 2), "utf8");
    try {
      chmodSync(this.filePath, 0o600);
    } catch {
      /* ignore */
    }
  }

  clear(): void {
    try {
      writeFileSync(this.filePath, "{}", "utf8");
    } catch {
      /* ignore */
    }
  }
}
