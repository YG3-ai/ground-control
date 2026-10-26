import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { YG3_SNAPSHOT_V1_VERSION } from "./constants.js";
import type { Yg3SnapshotV1 } from "./snapshot-v1.js";

export class Yg3SnapshotFileStore {
  constructor(private readonly filePath: string) {}

  static defaultPath(relayDataDir: string): Yg3SnapshotFileStore {
    return new Yg3SnapshotFileStore(
      join(relayDataDir, "yg3", "snapshot-v1.json"),
    );
  }

  load(): Yg3SnapshotV1 | null {
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const data = JSON.parse(raw) as Yg3SnapshotV1;
      if (data.version !== YG3_SNAPSHOT_V1_VERSION) return null;
      if (!data.tenantKey || !data.userKey || !data.syncedAt) return null;
      return data;
    } catch {
      return null;
    }
  }

  saveAtomic(snapshot: Yg3SnapshotV1): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    try {
      chmodSync(dirname(this.filePath), 0o700);
    } catch {
      /* ignore */
    }
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(snapshot, null, 2), "utf8");
    try {
      chmodSync(tmp, 0o600);
    } catch {
      /* ignore */
    }
    renameSync(tmp, this.filePath);
    try {
      chmodSync(this.filePath, 0o600);
    } catch {
      /* ignore */
    }
  }
}
