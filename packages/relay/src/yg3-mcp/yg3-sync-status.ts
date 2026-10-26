import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const YG3_SYNC_STATUS_VERSION = 1;

export type Yg3SyncTrigger =
  | "calendar"
  | "run_at_load"
  | "manual"
  | "setup"
  | "unknown";

export type Yg3SyncState = "idle" | "running" | "ok" | "error";

export type Yg3SyncStatusV1 = {
  version: typeof YG3_SYNC_STATUS_VERSION;
  tenantKey: string;
  userKey: string;
  state: Yg3SyncState;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastTrigger: Yg3SyncTrigger | null;
  lastErrorCode: string | null;
};

export type PublicYg3SyncStatus = {
  state: Yg3SyncState;
  running: boolean;
  lastSyncedAt: string | null;
  lastAttemptAt: string | null;
  lastTrigger: Yg3SyncTrigger | null;
  lastErrorCode: string | null;
};

const MAX_ERROR_LEN = 64;

export function sanitizeSyncErrorCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw
    .replace(/[^a-zA-Z0-9_.-]/g, "_")
    .slice(0, MAX_ERROR_LEN);
  return cleaned || "error";
}

export class Yg3SyncStatusStore {
  constructor(private readonly filePath: string) {}

  static defaultPath(relayDataDir: string): Yg3SyncStatusStore {
    return new Yg3SyncStatusStore(
      join(relayDataDir, "yg3", "sync-status.json"),
    );
  }

  load(): Yg3SyncStatusV1 | null {
    try {
      const data = JSON.parse(readFileSync(this.filePath, "utf8")) as Yg3SyncStatusV1;
      if (data.version !== YG3_SYNC_STATUS_VERSION) return null;
      return data;
    } catch {
      return null;
    }
  }

  saveAtomic(status: Yg3SyncStatusV1): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    try {
      chmodSync(dirname(this.filePath), 0o700);
    } catch {
      /* ignore */
    }
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(status, null, 2), "utf8");
    renameSync(tmp, this.filePath);
    try {
      chmodSync(this.filePath, 0o600);
    } catch {
      /* ignore */
    }
  }
}

export function toPublicYg3SyncStatus(
  status: Yg3SyncStatusV1 | null,
): PublicYg3SyncStatus {
  if (!status) {
    return {
      state: "idle",
      running: false,
      lastSyncedAt: null,
      lastAttemptAt: null,
      lastTrigger: null,
      lastErrorCode: null,
    };
  }
  return {
    state: status.state,
    running: status.state === "running",
    lastSyncedAt: status.lastSuccessAt,
    lastAttemptAt: status.lastAttemptAt,
    lastTrigger: status.lastTrigger,
    lastErrorCode: status.lastErrorCode,
  };
}
