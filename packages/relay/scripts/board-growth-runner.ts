/**
 * Read-only growth JSON for Ground board extensions.
 * Invoked with GROUND_CONTROL_WORK_ROOT (or cwd); env from workspace .env.local.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

async function main(): Promise<void> {
  const root = (
    process.env.GROUND_CONTROL_WORK_ROOT ||
    process.env.PARTHA_WORK_ROOT ||
    process.cwd()
  ).replace(/\/$/, "");
  const requestedWindow = process.argv.find((a) => a.startsWith("--w="))?.slice(4) ?? "7";
  const w = requestedWindow.replace(/d$/, "");
  const from = process.argv.find((a) => a.startsWith("--from="))?.slice(7);
  const to = process.argv.find((a) => a.startsWith("--to="))?.slice(5);

  const { parseDashRange } = await import(
    pathToFileURL(join(root, "lib/window-key.ts")).href
  );
  const { loadGrowthReport } = await import(
    pathToFileURL(join(root, "lib/growth-report.ts")).href
  );
  const { buildRealityInsights } = await import(
    pathToFileURL(join(root, "lib/reality-insights.ts")).href
  );

  const range = parseDashRange({ w, from, to });
  const report = await loadGrowthReport(range);
  const insights = buildRealityInsights({
    acquisition: {
      visits: report.acquisition.visits,
      taggedShare: report.acquisition.taggedShare,
    },
    conversion: {
      signups: report.conversion.signups,
      trials: report.conversion.trials,
      giftSignups: report.conversion.giftSignups,
      demandSignups: report.conversion.demandSignups,
      byPath: report.conversion.byPath,
    },
    journey: {
      signedUpAndLoggedIn: report.journey.signedUpAndLoggedIn,
      signedUpNeverLoggedIn: report.journey.signedUpNeverLoggedIn,
    },
    compare: report.compare
      ? { label: report.compare.label, demandSignups: report.compare.demandSignups }
      : null,
  });
  process.stdout.write(JSON.stringify({ report, insights }));
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(message);
  process.exit(1);
});
