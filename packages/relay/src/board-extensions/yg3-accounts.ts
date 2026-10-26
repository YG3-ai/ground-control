import type { BoardExtensionPaths } from "./paths.js";
import { workRootAdapterConfigured } from "./paths.js";
import { runBounded } from "./safe-exec.js";
import { yg3AccountsFeedFromSnapshot } from "../yg3-mcp/feed-from-snapshot.js";
import {
  loadYg3OwnerSnapshot,
  resolveYg3PathsFromRelayPackage,
} from "../yg3-mcp/snapshot-service.js";
import {
  mapYg3AccountRows,
  type Yg3AccountsFeedPayload,
} from "../board-yg3-accounts-present.js";

type CacheEntry = { at: number; payload: Yg3AccountsFeedPayload };
let cache: CacheEntry | null = null;
const TTL_MS = 60_000;

function unavailable(err?: string): Yg3AccountsFeedPayload {
  return {
    ok: false,
    health: "unavailable",
    measuredAt: null,
    items: [],
    error: err,
  };
}

export async function getYg3AccountsFeed(
  pathsCfg: BoardExtensionPaths,
  relayPackageRoot?: string,
): Promise<Yg3AccountsFeedPayload> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) {
    return cache.payload;
  }

  if (relayPackageRoot) {
    const yg3Paths = resolveYg3PathsFromRelayPackage(relayPackageRoot);
    const yg3Load = await loadYg3OwnerSnapshot({
      ...yg3Paths,
      audience: "owner",
    });
    const fromMcp = yg3AccountsFeedFromSnapshot(yg3Load);
    if (fromMcp && fromMcp.health !== "unavailable") {
      cache = { at: now, payload: fromMcp };
      return fromMcp;
    }
  }

  if (!workRootAdapterConfigured(pathsCfg) || !pathsCfg.parthaWorkEnvFile) {
    return unavailable("work_root_adapter_not_configured");
  }

  const node = process.execPath;
  const args = [
    "--conditions=react-server",
    `--env-file=${pathsCfg.parthaWorkEnvFile}`,
    "--import",
    "tsx",
    pathsCfg.yg3AccountsRunnerScript,
    "--limit=40",
  ];
  const result = await runBounded(node, args, {
    cwd: pathsCfg.parthaWorkRoot!,
    timeoutMs: 45_000,
    maxBuffer: 2_000_000,
    env: {
      ...process.env,
      GROUND_CONTROL_WORK_ROOT: pathsCfg.parthaWorkRoot!,
      PARTHA_WORK_ROOT: pathsCfg.parthaWorkRoot!,
    },
  });
  if (result.code !== 0) {
    return unavailable(result.stderr.slice(0, 200) || "yg3 accounts runner failed");
  }
  try {
    const body = JSON.parse(result.stdout) as {
      items?: Array<{ id?: string; name?: string; email?: string; createdAt?: string }>;
    };
    const payload: Yg3AccountsFeedPayload = {
      ok: true,
      health: "ok",
      measuredAt: new Date().toISOString(),
      items: mapYg3AccountRows(body.items ?? []),
    };
    cache = { at: now, payload };
    return payload;
  } catch {
    return unavailable("invalid yg3 accounts JSON");
  }
}

export function clearYg3AccountsCache(): void {
  cache = null;
}
