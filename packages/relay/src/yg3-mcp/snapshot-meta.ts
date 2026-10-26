import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { YG3_SNAPSHOT_META_VERSION } from "./constants.js";
import type { normalizeWhoamiIdentity } from "./sanitize.js";

export type Yg3SnapshotMetaV1 = {
  version: typeof YG3_SNAPSHOT_META_VERSION;
  tenantKey: string;
  userKey: string;
  updatedAt: string;
  lastWhoamiOkAt: string;
};

export class Yg3SnapshotMetaStore {
  constructor(private readonly filePath: string) {}

  static defaultPath(relayDataDir: string): Yg3SnapshotMetaStore {
    return new Yg3SnapshotMetaStore(join(relayDataDir, "yg3", "snapshot-meta.json"));
  }

  load(): Yg3SnapshotMetaV1 | null {
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const data = JSON.parse(raw) as Yg3SnapshotMetaV1;
      if (data.version !== YG3_SNAPSHOT_META_VERSION) return null;
      return data;
    } catch {
      return null;
    }
  }

  bindIdentity(identity: ReturnType<typeof normalizeWhoamiIdentity>): Yg3SnapshotMetaV1 {
    const existing = this.load();
    if (
      existing &&
      (existing.tenantKey !== identity.tenantKey ||
        existing.userKey !== identity.userKey)
    ) {
      throw new Error("tenant_identity_mismatch");
    }
    const now = new Date().toISOString();
    const next: Yg3SnapshotMetaV1 = {
      version: YG3_SNAPSHOT_META_VERSION,
      tenantKey: identity.tenantKey,
      userKey: identity.userKey,
      updatedAt: now,
      lastWhoamiOkAt: now,
    };
    this.write(next);
    return next;
  }

  touchWhoamiOk(identity: ReturnType<typeof normalizeWhoamiIdentity>): Yg3SnapshotMetaV1 {
    const existing = this.load();
    if (!existing) return this.bindIdentity(identity);
    if (
      existing.tenantKey !== identity.tenantKey ||
      existing.userKey !== identity.userKey
    ) {
      throw new Error("tenant_identity_mismatch");
    }
    const next: Yg3SnapshotMetaV1 = {
      ...existing,
      updatedAt: new Date().toISOString(),
      lastWhoamiOkAt: new Date().toISOString(),
    };
    this.write(next);
    return next;
  }

  private write(data: Yg3SnapshotMetaV1): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(data, null, 2), "utf8");
    try {
      chmodSync(this.filePath, 0o600);
    } catch {
      /* ignore */
    }
  }
}
