// Imports purchases made outside the scheduled run (e.g. by hand, or on
// another machine) into manual_runs. Input: base64 of a JSON array of runs,
// the shape `npm run export` prints -- as the first argument, or in the
// IMPORT_ROWS env var (Coolify task commands are capped at ~255 chars). Only CONFIRMED rows; a
// txHash already in runs or manual_runs is skipped (safe to re-run).
// Rows come from this bot's own `npm run export`; the wallet field is kept as exported.
// Rows go to strategy #1 unless IMPORT_STRATEGY is set.
import { loadAppConfig } from "../src/config.js";
import { openDb, listAllRuns, insertManualRun, updateManualRun, type Run } from "../src/db.js";

const config = loadAppConfig();
const rows = JSON.parse(Buffer.from(process.argv[2] ?? process.env.IMPORT_ROWS ?? "", "base64").toString("utf8")) as Run[];
const db = openDb(config.dbFile);
try {
  const known = new Set(listAllRuns(db).map((r) => r.txHash));
  for (const r of rows) {
    if (r.status !== "CONFIRMED" || !r.txHash || known.has(r.txHash)) {
      console.log(`skipped ${r.date} ${r.txHash ?? "(no tx)"}`);
      continue;
    }
    const { wallet, date, manualId, createdAt, ...fields } = r;
    const id = insertManualRun(db, wallet, date, r.confirmedAt ?? `${date}T00:00:00.000Z`, Number(process.env.IMPORT_STRATEGY ?? 1));
    updateManualRun(db, id, fields);
    known.add(r.txHash);
    console.log(`imported ${date} ${r.txHash} as manual #${id}`);
  }
} finally {
  db.close();
}
