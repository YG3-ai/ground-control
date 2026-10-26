import {
  chmodSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { sanitizeUntrustedMcpValue } from "./sanitize.js";

const RAW_SCHEMA_VERSION = 1;

export type Yg3RawEnvelope = {
  version: typeof RAW_SCHEMA_VERSION;
  tool: string;
  capturedAt: string;
  payload: unknown;
};

export class Yg3RawResponseStore {
  constructor(private readonly dir: string) {}

  static defaultPath(relayDataDir: string): Yg3RawResponseStore {
    return new Yg3RawResponseStore(join(relayDataDir, "yg3", "raw"));
  }

  write(tool: string, payload: unknown, capturedAt = new Date().toISOString()): string {
    mkdirSync(this.dir, { recursive: true });
    try {
      chmodSync(this.dir, 0o700);
    } catch {
      /* ignore */
    }
    const safeTool = tool.replace(/[^a-z0-9_]+/gi, "_").slice(0, 64);
    const stamp = capturedAt.replace(/[:.]/g, "-");
    const name = `${stamp}__${safeTool}__v${RAW_SCHEMA_VERSION}.json`;
    const filePath = join(this.dir, name);
    const envelope: Yg3RawEnvelope = {
      version: RAW_SCHEMA_VERSION,
      tool: safeTool,
      capturedAt,
      payload: sanitizeUntrustedMcpValue(payload),
    };
    writeFileSync(filePath, JSON.stringify(envelope), "utf8");
    try {
      chmodSync(filePath, 0o600);
    } catch {
      /* ignore */
    }
    return name;
  }
}

export function purgeYg3RawCache(relayDataDir: string): number {
  const dir = join(relayDataDir, "yg3", "raw");
  let removed = 0;
  try {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      try {
        if (!statSync(full).isFile()) continue;
        if (!name.endsWith(".json")) continue;
        unlinkSync(full);
        removed += 1;
      } catch {
        /* skip */
      }
    }
  } catch {
    return 0;
  }
  return removed;
}
