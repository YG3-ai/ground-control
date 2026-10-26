/**
 * Controlled, idempotent backfill of the event spine (+ world model) from the
 * source stores. Prints COUNTS ONLY — never event content — so the report is
 * safe to log/share. Default mode is a dry run; pass --apply to write.
 *
 *   node --import tsx packages/worker/src/backfill-cli.ts [--config path]
 *       [--apply] [--world] [--mission-evidence] [--data-dir path]
 *
 * --mission-evidence additionally backfills historical mission completion
 * events that lack job:<id> evidence refs by appending deterministic
 * correction events (append-only; the originals are never updated).
 */
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { unlinkSync } from "node:fs";
import { config as loadDotenv } from "dotenv";
import { loadConfig } from "@agent-control/shared";
import { JobStore } from "./db.js";
import { ApprovalManager } from "./local/approvals.js";
import { MissionStore } from "./missions/store.js";
import { UsageLedger } from "./usage/ledger.js";
import { ClientRequestStore } from "./clients/store.js";
import { EventStore } from "./events/store.js";
import type { NewEvent } from "./events/types.js";
import { WorldStore } from "./world/store.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
loadDotenv({ path: resolve(repoRoot, ".env") });

function main(): void {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const withWorld = args.includes("--world") || apply;
  const missionEvidence = args.includes("--mission-evidence");
  let configPath = resolve(repoRoot, "config.yaml");
  let dataDirOverride: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config") configPath = resolve(args[++i] ?? "");
    if (args[i] === "--data-dir") dataDirOverride = resolve(args[++i] ?? "");
  }

  const config = loadConfig(configPath);
  const dataDir = dataDirOverride ?? resolve(repoRoot, config.worker.data_dir);

  const jobs = new JobStore(join(dataDir, "jobs.db"));
  const missions = new MissionStore(join(dataDir, "missions.db"));
  const approvals = new ApprovalManager({
    ownerId: config.owner.id,
    dataDir: join(dataDir, "approvals"),
  });
  const usage = new UsageLedger(join(dataDir, "usage.db"));
  const clients = new ClientRequestStore(join(dataDir, "clients.db"));
  const events = new EventStore(join(dataDir, "events.db"));

  try {
    const existing = events.count();
    const report = events.rebuildFrom(
      { jobs, missions, approvals, usage, clients },
      { dryRun: !apply },
    );

    const out: Record<string, unknown> = {
      mode: apply ? "apply" : "dry-run",
      data_dir: dataDir,
      events_before: existing,
      events_after: events.count(),
      inserted: report.inserted,
      per_source: report.per_source,
    };

    if (missionEvidence) {
      out.mission_evidence_backfill = events.backfillMissionEvidence(missions, {
        dryRun: !apply,
      });
      out.events_after = events.count();
    }

    if (withWorld && !apply) {
      // Dry-run world preview: project existing + PLANNED events in memory
      // (planned events get their derived ids via a throwaway EventStore),
      // report counts only.
      const tmpEvents = new EventStore(join(dataDir, "events.dryrun.db"));
      const planned: NewEvent[] = [];
      for (const entry of events.planRebuild({ jobs, missions, approvals, usage, clients })) {
        planned.push(...entry.events);
      }
      for (const e of planned) tmpEvents.emit(e);
      const world = new WorldStore(join(dataDir, "world.dryrun.db"));
      const r = world.rebuildFromEvents(tmpEvents.allEvents());
      out.world = { dry_run: true, ...r };
      world.close();
      tmpEvents.close();
      // Remove the throwaway dry-run db files.
      for (const base of ["world.dryrun.db", "events.dryrun.db"]) {
        for (const suffix of ["", "-wal", "-shm"]) {
          try {
            unlinkSync(join(dataDir, `${base}${suffix}`));
          } catch {
            // ignore
          }
        }
      }
    } else if (withWorld) {
      const world = new WorldStore(join(dataDir, "world.db"));
      const r = world.rebuildFromEvents(events.allEvents());
      out.world = { dry_run: false, ...r };
      world.close();
    }

    console.log(JSON.stringify(out, null, 2));
  } finally {
    jobs.close();
    missions.close();
    usage.close();
    clients.close();
    events.close();
  }
}

main();
