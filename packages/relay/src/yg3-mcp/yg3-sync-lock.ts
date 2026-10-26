import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

const LOCK_DIR_NAME = "yg3-sync.lock.d";

export type Yg3SyncLockHandle = {
  release: () => void;
};

export function yg3SyncLockPath(relayDataDir: string): string {
  return join(relayDataDir, "yg3", LOCK_DIR_NAME);
}

/** Process-local exclusive lock via atomic mkdir (no stale PID files). */
export function tryAcquireYg3SyncLock(
  relayDataDir: string,
): Yg3SyncLockHandle | null {
  const path = yg3SyncLockPath(relayDataDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
    mkdirSync(path);
    return {
      release: () => {
        try {
          rmSync(path, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      },
    };
  } catch {
    return null;
  }
}
