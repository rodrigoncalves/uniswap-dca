// Lost phone: removes the enrolled authenticator so the app offers "Set up
// authenticator" again. Run from the server (Coolify terminal:
// node dist/scripts/totp-reset.js) -- server access already means full
// trust. Uses only app config; doesn't need the private key or MASTER_KEY:
// it deletes, never decrypts. Open elevation
// windows in a running app expire on their own within 15 minutes.
import { loadAppConfig } from "../src/config.js";
import { openDb, getSecret, deleteSecret, resetTotpStep } from "../src/db.js";

const config = loadAppConfig();
const db = openDb(config.dbFile);
try {
  const had = getSecret(db, "totp_secret") !== undefined;
  deleteSecret(db, "totp_secret");
  resetTotpStep(db);
  console.log(had ? "Authenticator removed. Open the app to set up a new one." : "No authenticator was set up; nothing to do.");
} finally {
  db.close();
}
