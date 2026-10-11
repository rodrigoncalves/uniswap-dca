// Dumps the database as JSON to stdout. Only reads APP_PASSWORD/APP_PORT/
// DB_FILE via loadAppConfig -- no private key, UNISWAP_API_KEY or RPC_URL.
import { loadAppConfig } from "../src/config.js";
import { openDb, listAllRuns } from "../src/db.js";

const config = loadAppConfig();
const db = openDb(config.dbFile);
try {
  const runs = listAllRuns(db);
  process.stdout.write(JSON.stringify(runs, null, 2) + "\n");
} finally {
  db.close();
}
