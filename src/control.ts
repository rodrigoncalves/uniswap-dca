// npm run pause / npm run resume -- thin CLI over db.ts. Touches nothing
// on-chain (that's npm run revoke, which needs the stored key and lives in
// D1). Serves as a manual exit when the app isn't reachable, and runs
// from the Coolify terminal in Phase 6.
import { loadAppConfig } from "./config.js";
import { openDb, getControl, setPaused } from "./db.js";

function parseArgs(argv: string[]): { until: string | null; reason: string | null } {
  let until: string | null = null;
  const rest: string[] = [];
  for (const arg of argv) {
    if (arg === "--") continue; // npm run pause -- "reason" -- npm normally strips this already, but guards against calling node directly
    if (arg.startsWith("--until=")) {
      until = arg.slice("--until=".length);
    } else {
      rest.push(arg);
    }
  }
  return { until, reason: rest.length > 0 ? rest.join(" ") : null };
}

function printControl(label: string, control: ReturnType<typeof getControl>): void {
  console.log(label);
  if (!control || !control.paused) {
    console.log("  status: active");
    return;
  }
  console.log(`  status: paused since ${control.pausedAt ?? "?"}`);
  if (control.pausedUntil) console.log(`  auto-resumes at: ${control.pausedUntil}`);
  if (control.reason) console.log(`  reason: ${control.reason}`);
}

function main(): void {
  const action = process.argv[2];
  if (action !== "pause" && action !== "resume") {
    console.error("usage: npm run pause -- [\"reason\"] [--until=2026-10-01T00:00:00Z]");
    console.error("     npm run resume");
    process.exit(1);
  }

  const config = loadAppConfig();
  const db = openDb(config.dbFile);
  try {
    if (action === "pause") {
      const { until, reason } = parseArgs(process.argv.slice(3));
      setPaused(db, { paused: true, until, reason });
      printControl("DCA paused.", getControl(db));
    } else {
      setPaused(db, { paused: false });
      printControl("DCA resumed.", getControl(db));
    }
  } finally {
    db.close();
  }
}

main();
