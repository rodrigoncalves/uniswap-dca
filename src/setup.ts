// One-time migration of env-held settings into the database (F1). Each call
// only fills what is empty; invalid values stop the caller before buying.
// F1c: settings (DECISIONS.md #23); F1d adds the encrypted private key.
import type { DatabaseSync } from "node:sqlite";
import { createStrategy, listStrategies, getSettings, saveSettings, getSecret, putSecret, countInFlight } from "./db.js";
import { parsePrivateKey, parseStrategyInput, validateSettings, ValidationError, type Settings } from "./validation.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import { logger, registerSecret } from "./logger.js";

type Env = Record<string, string | undefined>;

export class SetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SetupError";
  }
}

export const LEGACY_SETTINGS_ENV = {
  MAX_SLIPPAGE_PCT: "maxSlippagePct",
  MAX_PRICE_IMPACT_PCT: "maxPriceImpactPct",
  MAX_ORACLE_DEVIATION_PCT: "maxOracleDeviationPct",
  APPROVAL_DAYS: "approvalDays",
  MIN_POL_BALANCE: "minPolBalance",
} as const;

/** All five legacy vars -> settings (run time 00:00, today's behaviour); some -> refuse; none -> null. */
export function settingsFromEnv(env: Env): Settings | null {
  const present = Object.keys(LEGACY_SETTINGS_ENV).filter((k) => env[k]?.trim());
  if (present.length === 0) return null;
  const missing = Object.keys(LEGACY_SETTINGS_ENV).filter((k) => !env[k]?.trim());
  if (missing.length > 0) throw new ValidationError([`legacy settings env is incomplete, missing: ${missing.join(", ")} -- set all five or none (then configure in the app)`]);
  const raw: Record<string, unknown> = { runTime: "00:00" };
  for (const [envKey, key] of Object.entries(LEGACY_SETTINGS_ENV)) raw[key] = env[envKey]!.trim();
  return validateSettings(raw);
}

function seedSettings(db: DatabaseSync, env: Env, nowIso: string): void {
  if (getSettings(db)) {
    const present = Object.keys(LEGACY_SETTINGS_ENV).filter((k) => env[k]?.trim());
    if (present.length > 0) logger.warn("legacy settings env vars are ignored -- settings live in the app now; remove them", { vars: present });
    return;
  }
  const settings = settingsFromEnv(env);
  if (settings === null) return;
  // ponytail: two processes seeding at once both write the same validated row -- last write wins, identical values.
  saveSettings(db, settings, nowIso);
  logger.info("settings created from env -- edit them in the app from now on");
}

export function seedFromEnv(db: DatabaseSync, env: Env, nowIso: string, masterKey: Buffer | null): void {
  seedSettingsAndStrategyFromEnv(db, env, nowIso);
  seedPrivateKeyFromEnv(db, env, masterKey);
}

export function seedSettingsAndStrategyFromEnv(db: DatabaseSync, env: Env, nowIso: string): void {
  if (env.OUTPUT_RECIPIENT?.trim()) {
    throw new ValidationError(["OUTPUT_RECIPIENT is no longer supported (DECISIONS.md #23): WBTC stays in the DCA wallet. Remove it from the environment."]);
  }
  seedSettings(db, env, nowIso);
  seedStrategy(db, env, nowIso);
}

export function storePrivateKey(db: DatabaseSync, masterKey: Buffer, key: `0x${string}`): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    writePrivateKey(db, masterKey, key);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function loadPrivateKey(db: DatabaseSync, masterKey: Buffer): `0x${string}` {
  const blob = getSecret(db, "private_key");
  if (blob === undefined) throw new SetupError("no private key stored -- set it in the app");
  const plaintext = decryptSecret(masterKey, "private_key", blob);
  registerSecret(plaintext);
  const { key } = parsePrivateKey(plaintext);
  registerSecret(key);
  return key;
}

/** Called inside a claim's write transaction, after RPC awaits and before reserving a purchase. */
export function assertPrivateKeyUnchanged(db: DatabaseSync, masterKey: Buffer, expectedKey: `0x${string}`): void {
  if (loadPrivateKey(db, masterKey) !== expectedKey) {
    throw new SetupError("private key changed before purchase claim -- retry with the current wallet");
  }
}

export function assertNoPurchaseInFlight(db: DatabaseSync): void {
  const n = countInFlight(db);
  if (n > 0) throw new SetupError(`${n} purchase(s) in progress (PENDING/BROADCAST) -- wait until they settle before replacing the key`);
}

export function seedPrivateKeyFromEnv(db: DatabaseSync, env: Env, masterKey: Buffer | null): void {
  const raw = env.PRIVATE_KEY?.trim();
  if (!raw) return;
  registerSecret(raw);
  let storedAddress: string | undefined;
  let seededAddress: string | undefined;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (getSecret(db, "private_key") !== undefined) {
      storedAddress = masterKey ? parsePrivateKey(loadPrivateKey(db, masterKey)).address : "(unknown)";
    } else {
      if (!masterKey) throw new SetupError("MASTER_KEY is required to store PRIVATE_KEY in the database");
      const { key, address } = parsePrivateKey(raw);
      writePrivateKey(db, masterKey, key, address);
      seededAddress = address;
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  if (storedAddress !== undefined) {
    logger.warn("PRIVATE_KEY env var is ignored: the key stored in the database is in use -- remove PRIVATE_KEY from the environment", { storedAddress });
  } else if (seededAddress !== undefined) {
    logger.warn("private key copied into the database (encrypted) -- remove PRIVATE_KEY from the environment", { address: seededAddress });
  }
}

function writePrivateKey(db: DatabaseSync, masterKey: Buffer, key: `0x${string}`, initialWallet?: string): void {
  if (initialWallet === undefined) assertNoPurchaseInFlight(db);
  else assertInFlightBelongsToWallet(db, initialWallet);
  registerSecret(key);
  putSecret(db, "private_key", encryptSecret(masterKey, "private_key", key));
}

function assertInFlightBelongsToWallet(db: DatabaseSync, wallet: string): void {
  const rows = db
    .prepare(
      `SELECT wallet FROM runs WHERE status IN ('PENDING', 'BROADCAST')
       UNION ALL
       SELECT wallet FROM manual_runs WHERE status IN ('PENDING', 'BROADCAST')`
    )
    .all() as { wallet: string }[];
  if (rows.some((row) => row.wallet.toLowerCase() !== wallet.toLowerCase())) {
    throw new SetupError("purchase(s) in progress for a different wallet -- refusing to seed PRIVATE_KEY");
  }
}

function seedStrategy(db: DatabaseSync, env: Env, nowIso: string): void {
  const dcaAmount = env.DCA_AMOUNT?.trim();
  if (!dcaAmount) return;

  let createdAmount: string | undefined;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (listStrategies(db).length === 0) {
      // id 1: pre-F1b history was migrated onto strategy #1 by db.ts v5.
      const { amount } = parseStrategyInput({ amount: dcaAmount }, nowIso.slice(0, 10), "create");
      createStrategy(db, { id: 1, label: null, amount: amount!, endDate: null, createdAt: nowIso });
      createdAmount = amount;
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  if (createdAmount) logger.info("strategy #1 created from DCA_AMOUNT -- manage strategies in the app from now on", { amount: createdAmount });
  else logger.warn("DCA_AMOUNT is set but ignored: strategies live in the app now -- remove it from the environment");
}

export function loadSettings(db: DatabaseSync): Settings {
  const s = getSettings(db);
  if (!s) throw new SetupError("settings not configured -- finish setup in the app");
  return validateSettings({ ...s }); // re-validated: defence against a hand-edited database
}

export function setupIssues(db: DatabaseSync): string[] {
  const issues: string[] = [];
  if (!getSettings(db)) issues.push("settings not configured");
  if (!listStrategies(db).some((s) => s.status === "active")) issues.push("no active strategy");
  if (getSecret(db, "totp_secret") === undefined) issues.push("authenticator not set up");
  if (getSecret(db, "private_key") === undefined) issues.push("no private key");
  return issues;
}
