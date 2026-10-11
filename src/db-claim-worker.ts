// Child process used only by db.test.ts's real concurrency test (two
// processes contending for the scheduled claim on the same file). Runs the
// real production code -- import from ./db.js -- not a reimplementation.
import { openDb, claimScheduledRun } from "./db.js";
import { seedFromEnv } from "./setup.js";

const [, , dbPath, wallet, date] = process.argv;
if (!dbPath || (wallet !== "--open-only" && wallet !== "--seed-only" && (!wallet || !date))) {
  console.error("usage: db-claim-worker.ts <dbPath> <wallet> <date>");
  process.exit(1);
}

const db = openDb(dbPath);
if (wallet === "--open-only") {
  db.close();
  process.stdout.write(JSON.stringify({ opened: true }));
  process.exit(0);
}
if (wallet === "--seed-only") {
  seedFromEnv(db, { DCA_AMOUNT: "10" }, new Date().toISOString(), null);
  db.close();
  process.exit(0);
}
const claimed = claimScheduledRun(db, wallet!, date!, new Date().toISOString(), 6).kind === "claimed";
db.close();
process.stdout.write(JSON.stringify({ claimed }));
