// Persistence: SQLite via node:sqlite (stdlib, no dependency -- see
// DECISIONS.md #5). One file, WAL mode, migration via PRAGMA user_version.
//
// The scheduled lock lives in claimScheduledRun(): runs (wallet, date) and
// run_shares (strategy_id, date) are claimed in one transaction -- two
// concurrent calls for the same (wallet, date), even in different
// processes contending for the same file, never both claim it (tested
// with two real processes in db.test.ts, not just within one process).
// Manual purchases (buying a dip) live in manual_runs, with their own id and
// no per-day limit (DECISIONS.md #17). claimManualRun() reserves budget under
// a write lock before verification.

import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { toBaseUnits, limitReached, nextShareUnits, formatUnits, type Settings } from "./validation.js";

export type RunStatus = "PENDING" | "BROADCAST" | "CONFIRMED" | "FAILED" | "PAUSED";

export interface Run {
  wallet: string;
  date: string; // YYYY-MM-DD, UTC
  status: RunStatus;
  nonce: number | null;
  txHash: string | null;
  blockNumber: string | null;
  confirmedAt: string | null;
  amountIn: string | null;
  amountOut: string | null;
  recipient: string | null;
  effectivePrice: string | null;
  minimumAmount: string | null;
  priceImpactPct: string | null;
  oracleBtcUsd: string | null;
  oracleUsdtUsd: string | null;
  oraclePolUsd: string | null;
  oracleDeviationPct: string | null;
  gasUsed: string | null;
  gasCostPol: string | null;
  gasCostUsd: string | null;
  routing: string | null;
  routeString: string | null;
  requestId: string | null;
  quoteId: string | null;
  error: string | null;
  /** unix s -- after this the broadcast tx can no longer execute (see validation.ts decideRecovery) */
  deadline: number | null;
  /** Only on manual purchases (manual_runs): their row id and creation time. */
  manualId?: number;
  createdAt?: string;
}

const SCHEMA_VERSION = 10;

const COLUMNS: { camel: keyof Run; snake: string }[] = [
  { camel: "wallet", snake: "wallet" },
  { camel: "date", snake: "date" },
  { camel: "status", snake: "status" },
  { camel: "nonce", snake: "nonce" },
  { camel: "txHash", snake: "tx_hash" },
  { camel: "blockNumber", snake: "block_number" },
  { camel: "confirmedAt", snake: "confirmed_at" },
  { camel: "amountIn", snake: "amount_in" },
  { camel: "amountOut", snake: "amount_out" },
  { camel: "recipient", snake: "recipient" },
  { camel: "effectivePrice", snake: "effective_price" },
  { camel: "minimumAmount", snake: "minimum_amount" },
  { camel: "priceImpactPct", snake: "price_impact_pct" },
  { camel: "oracleBtcUsd", snake: "oracle_btc_usd" },
  { camel: "oracleUsdtUsd", snake: "oracle_usdt_usd" },
  { camel: "oraclePolUsd", snake: "oracle_pol_usd" },
  { camel: "oracleDeviationPct", snake: "oracle_deviation_pct" },
  { camel: "gasUsed", snake: "gas_used" },
  { camel: "gasCostPol", snake: "gas_cost_pol" },
  { camel: "gasCostUsd", snake: "gas_cost_usd" },
  { camel: "routing", snake: "routing" },
  { camel: "routeString", snake: "route_string" },
  { camel: "requestId", snake: "request_id" },
  { camel: "quoteId", snake: "quote_id" },
  { camel: "error", snake: "error" },
  { camel: "deadline", snake: "deadline" },
];

function rowToRun(row: Record<string, unknown>): Run {
  const run: Record<string, unknown> = {};
  for (const { camel, snake } of COLUMNS) {
    run[camel] = row[snake] ?? null;
  }
  if (row.id !== undefined) {
    run.manualId = row.id;
    run.createdAt = row.created_at;
  }
  return run as unknown as Run;
}

function migrate(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
  // Read the version under the write lock: a second process may have
  // completed the migration while this one waited for BEGIN IMMEDIATE.
  const { user_version: version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  if (version >= SCHEMA_VERSION) {
    db.exec("COMMIT");
    return;
  }
  if (version < 1) db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      wallet TEXT NOT NULL,
      date TEXT NOT NULL,
      status TEXT NOT NULL,
      nonce INTEGER,
      tx_hash TEXT,
      block_number TEXT,
      confirmed_at TEXT,
      amount_in TEXT,
      amount_out TEXT,
      recipient TEXT,
      effective_price TEXT,
      minimum_amount TEXT,
      price_impact_pct TEXT,
      oracle_btc_usd TEXT,
      oracle_usdt_usd TEXT,
      oracle_pol_usd TEXT,
      oracle_deviation_pct TEXT,
      gas_used TEXT,
      gas_cost_pol TEXT,
      gas_cost_usd TEXT,
      routing TEXT,
      route_string TEXT,
      request_id TEXT,
      quote_id TEXT,
      error TEXT,
      PRIMARY KEY (wallet, date)
    );

    CREATE TABLE IF NOT EXISTS control (
      wallet TEXT PRIMARY KEY,
      paused INTEGER NOT NULL DEFAULT 0,
      paused_at TEXT,
      paused_until TEXT,
      reason TEXT
    );
  `);
  if (version < 2) db.exec("ALTER TABLE runs ADD COLUMN deadline INTEGER");
  if (version < 3) {
    // Same columns as runs; id instead of the (wallet, date) lock.
    const columns = COLUMNS.filter((c) => c.snake !== "wallet" && c.snake !== "date" && c.snake !== "status")
      .map((c) => `${c.snake} ${c.snake === "nonce" || c.snake === "deadline" ? "INTEGER" : "TEXT"}`)
      .join(", ");
    db.exec(`CREATE TABLE IF NOT EXISTS manual_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL,
      wallet TEXT NOT NULL, date TEXT NOT NULL, status TEXT NOT NULL, ${columns})`);
  }
  if (version < 4) db.exec(`
    CREATE TABLE IF NOT EXISTS secrets (name TEXT PRIMARY KEY, blob TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_state (id INTEGER PRIMARY KEY CHECK (id = 1), totp_last_step INTEGER);
    INSERT OR IGNORE INTO auth_state (id, totp_last_step) VALUES (1, NULL);
  `);
  if (version < 5) db.exec(`
    CREATE TABLE IF NOT EXISTS strategies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT,
      amount TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active','paused','completed','stopped')),
      end_date TEXT,
      max_total TEXT,
      created_at TEXT NOT NULL,
      stopped_at TEXT
    );
    CREATE TABLE IF NOT EXISTS run_shares (
      strategy_id INTEGER NOT NULL,
      wallet TEXT NOT NULL,
      date TEXT NOT NULL,
      amount_in TEXT NOT NULL,
      amount_out TEXT,
      gas_cost_pol TEXT,
      gas_cost_usd TEXT,
      PRIMARY KEY (strategy_id, date)
    );
    ALTER TABLE manual_runs ADD COLUMN strategy_id INTEGER NOT NULL DEFAULT 1;
    INSERT OR IGNORE INTO run_shares (strategy_id, wallet, date, amount_in, amount_out, gas_cost_pol, gas_cost_usd)
      SELECT 1, wallet, date, COALESCE(amount_in, '0'), amount_out, gas_cost_pol, gas_cost_usd FROM runs;
    INSERT OR IGNORE INTO control (wallet, paused, paused_at, paused_until, reason)
      SELECT '*', paused, paused_at, paused_until, reason FROM control
      WHERE wallet <> '*' ORDER BY paused DESC, paused_at DESC LIMIT 1;
  `);
  if (version < 6) db.exec("CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)");
  if (version < 7) db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      run_time TEXT NOT NULL,
      max_slippage_pct REAL NOT NULL,
      max_price_impact_pct REAL NOT NULL,
      max_oracle_deviation_pct REAL NOT NULL,
      approval_days INTEGER NOT NULL,
      min_pol_balance REAL NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  // F9: email report mode. No row = "all", so existing installs keep their reports.
  if (version < 8) db.exec("CREATE TABLE IF NOT EXISTS report_pref (id INTEGER PRIMARY KEY CHECK (id = 1), mode TEXT NOT NULL CHECK (mode IN ('all','errors','off')))");
  // v9: "stopped" merged into "completed" (DECISIONS.md #27). The CHECK still lists 'stopped' (SQLite can't alter it); nothing writes it any more.
  if (version < 9) db.exec("UPDATE strategies SET status = 'completed' WHERE status = 'stopped'");
  // v10: low-funds alert threshold, in days (0 = only when a run can't be paid).
  if (version < 10 && !(db.prepare("PRAGMA table_info(report_pref)").all() as { name: string }[]).some((c) => c.name === "alert_days")) db.exec("ALTER TABLE report_pref ADD COLUMN alert_days INTEGER NOT NULL DEFAULT 2 CHECK (alert_days BETWEEN 0 AND 30)");
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * Opens (or creates) the database at `path`, with WAL and the schema
 * migrated. `:memory:` works for single-process tests; the real concurrency
 * guarantee (multiple processes) only exists with a real file -- WAL can't
 * be shared between processes pointing at distinct in-memory databases.
 */
export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  // busy_timeout FIRST: without it, the journal_mode pragma itself (which
  // needs a brief lock to switch modes) can collide with another process
  // opening the same file at the same time and throw "database is locked"
  // immediately -- found by running the real two-process test, not by
  // reading docs. With the timeout already active, SQLite waits and retries
  // instead of failing on the first collision.
  db.exec("PRAGMA busy_timeout = 5000");
  // Still not enough on its own: switching a fresh file to WAL can return
  // SQLITE_BUSY WITHOUT consulting busy_timeout while another process is
  // mid-transaction on it (fork battery `parallel`, ~1 run in 3; db.test.ts
  // "racing to create"). So retry, bounded like busy_timeout (~5 s).
  for (let attempt = 1; ; attempt++) {
    try {
      db.exec("PRAGMA journal_mode = WAL");
      break;
    } catch (err) {
      if (attempt >= 50 || !(err instanceof Error) || !err.message.includes("database is locked")) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); // synchronous sleep, openDb is sync
    }
  }
  migrate(db);
  return db;
}

/**
 * Claims the day for the wallet. `changes > 0` means THIS call claimed it;
 * `false` means the day was already claimed (by this process earlier, or by
 * another concurrent process -- indistinguishable on purpose, the caller
 * treats both cases the same way: don't buy again). BEGIN IMMEDIATE takes
 * the write lock before the INSERT, so two truly simultaneous calls in
 * different processes serialize here, never both see `changes > 0`.
 */
export function claimDay(db: DatabaseSync, wallet: string, date: string): boolean {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = db
      .prepare("INSERT INTO runs (wallet, date, status) VALUES (?, ?, 'PENDING') ON CONFLICT (wallet, date) DO NOTHING")
      .run(wallet, date);
    db.exec("COMMIT");
    return result.changes > 0;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function getRun(db: DatabaseSync, wallet: string, date: string): Run | undefined {
  const row = db.prepare("SELECT * FROM runs WHERE wallet = ? AND date = ?").get(wallet, date) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToRun(row) : undefined;
}

/**
 * Updates only the fields present in `patch`, preserving the rest -- not a
 * whole-row replace. Used for state transitions
 * (PENDING -> BROADCAST -> CONFIRMED/FAILED) and to attach result data
 * (effective price, gas, oracles) as each becomes available.
 */
export type RunPatch = Partial<Omit<Run, "wallet" | "date" | "manualId" | "createdAt">>;

export function updateRun(db: DatabaseSync, wallet: string, date: string, patch: RunPatch): void {
  update(db, "runs", "wallet = ? AND date = ?", [wallet, date], patch);
}

/** gas_cost_pol of the latest CONFIRMED scheduled runs, newest first (F7 gas runway). */
export function recentGasCostsPol(db: DatabaseSync, limit: number): string[] {
  const rows = db.prepare("SELECT gas_cost_pol FROM runs WHERE status = 'CONFIRMED' AND gas_cost_pol IS NOT NULL ORDER BY date DESC LIMIT ?").all(limit) as { gas_cost_pol: string }[];
  return rows.map((row) => row.gas_cost_pol);
}

function update(db: DatabaseSync, table: string, where: string, keys: (string | number)[], patch: RunPatch): void {
  const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return;

  const columnBySnake = new Map(COLUMNS.map((c) => [c.camel, c.snake]));
  const setClause = entries.map(([camel]) => `${columnBySnake.get(camel as keyof Run)} = ?`).join(", ");
  const values = entries.map(([, value]) => value) as (string | number | null)[];

  db.prepare(`UPDATE ${table} SET ${setClause} WHERE ${where}`).run(...values, ...keys);
}

/** A new manual purchase, PENDING. No per-day lock -- returns the row id. */
export function insertManualRun(db: DatabaseSync, wallet: string, date: string, createdAt: string, strategyId: number): number {
  const result = db
    .prepare("INSERT INTO manual_runs (created_at, wallet, date, status, strategy_id) VALUES (?, ?, ?, 'PENDING', ?)")
    .run(createdAt, wallet, date, strategyId);
  return Number(result.lastInsertRowid);
}

export function updateManualRun(db: DatabaseSync, id: number, patch: RunPatch): void {
  update(db, "manual_runs", "id = ?", [id], patch);
}

export function listManualRuns(db: DatabaseSync, opts: { wallet: string }): Run[] {
  const rows = db
    .prepare("SELECT * FROM manual_runs WHERE wallet = ? ORDER BY created_at DESC")
    .all(opts.wallet) as Record<string, unknown>[];
  return rows.map(rowToRun);
}

export function listRuns(db: DatabaseSync, opts: { wallet?: string; limit?: number } = {}): Run[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (opts.wallet !== undefined) {
    conditions.push("wallet = ?");
    params.push(opts.wallet);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limitClause = opts.limit !== undefined ? `LIMIT ${Number(opts.limit)}` : "";
  const rows = db.prepare(`SELECT * FROM runs ${where} ORDER BY date DESC ${limitClause}`).all(...params) as Record<
    string,
    unknown
  >[];
  return rows.map(rowToRun);
}

/**
 * Paused when there is a `control` row with paused=1 AND (paused_until is
 * null OR still in the future relative to `nowIso`). No control row:
 * active -- that's the normal state, not a failure. `nowIso` is injected by
 * the caller (never Date.now() here), same discipline as validation.ts.
 */
const CONTROL_KEY = "*";

export function isPaused(db: DatabaseSync, nowIso: string): boolean {
  const row = db.prepare("SELECT paused, paused_until FROM control WHERE wallet = ?").get(CONTROL_KEY) as
    | { paused: number; paused_until: string | null }
    | undefined;
  if (!row || row.paused === 0) return false;
  if (row.paused_until === null) return true;
  return row.paused_until > nowIso;
}

export interface Control {
  paused: boolean;
  pausedAt: string | null;
  pausedUntil: string | null;
  reason: string | null;
}

export function getControl(db: DatabaseSync): Control | undefined {
  const row = db.prepare("SELECT paused, paused_at, paused_until, reason FROM control WHERE wallet = ?").get(CONTROL_KEY) as
    | { paused: number; paused_at: string | null; paused_until: string | null; reason: string | null }
    | undefined;
  if (!row) return undefined;
  return { paused: row.paused !== 0, pausedAt: row.paused_at, pausedUntil: row.paused_until, reason: row.reason };
}

export function setPaused(
  db: DatabaseSync,
  opts: { paused: boolean; until?: string | null; reason?: string | null; pausedAt?: string }
): void {
  db.prepare(
    `INSERT INTO control (wallet, paused, paused_at, paused_until, reason)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (wallet) DO UPDATE SET paused = excluded.paused, paused_at = excluded.paused_at, paused_until = excluded.paused_until, reason = excluded.reason`
  ).run(CONTROL_KEY, opts.paused ? 1 : 0, opts.pausedAt ?? new Date().toISOString(), opts.until ?? null, opts.reason ?? null);
}

/**
 * Daily and manual runs of one wallet, for display: newest date first, then
 * newest within the day (manual rows by creation, daily by confirmation).
 */
export function listAllRuns(db: DatabaseSync): Run[] {
  const moment = (r: Run) => r.createdAt ?? r.confirmedAt ?? "";
  const manual = (db.prepare("SELECT * FROM manual_runs").all() as Record<string, unknown>[]).map(rowToRun);
  return [...listRuns(db), ...manual].sort(
    (a, b) => b.date.localeCompare(a.date) || moment(b).localeCompare(moment(a))
  );
}

// ============================================================
// secrets (encrypted blobs -- crypto.ts) and TOTP replay state (F1a)
// ============================================================

export type SecretName = "totp_secret" | "private_key";

export function getSecret(db: DatabaseSync, name: SecretName): string | undefined {
  const row = db.prepare("SELECT blob FROM secrets WHERE name = ?").get(name) as { blob: string } | undefined;
  return row?.blob;
}

export function putSecret(db: DatabaseSync, name: SecretName, blob: string): void {
  db.prepare("INSERT INTO secrets (name, blob) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET blob = excluded.blob").run(name, blob);
}

export function deleteSecret(db: DatabaseSync, name: SecretName): void {
  db.prepare("DELETE FROM secrets WHERE name = ?").run(name);
}

/**
 * A TOTP code is good once: records `step` as used only if it is newer than
 * the last one accepted. A single conditional UPDATE, so two requests with
 * the same code (even from two processes) can't both win.
 */
export function claimTotpStep(db: DatabaseSync, step: number): boolean {
  const result = db
    .prepare("UPDATE auth_state SET totp_last_step = ? WHERE id = 1 AND (totp_last_step IS NULL OR totp_last_step < ?)")
    .run(step, step);
  return result.changes > 0;
}

export function resetTotpStep(db: DatabaseSync): void {
  db.prepare("UPDATE auth_state SET totp_last_step = NULL WHERE id = 1").run();
}

/** Purchases not yet final -- recovery still owns them (README.md invariant #4). */
export function countInFlight(db: DatabaseSync): number {
  const row = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM runs WHERE status IN ('PENDING', 'BROADCAST'))
            + (SELECT COUNT(*) FROM manual_runs WHERE status IN ('PENDING', 'BROADCAST')) AS n`
    )
    .get() as { n: number };
  return Number(row.n);
}

// ============================================================
// login sessions (F6, DECISIONS.md #21): 30 days, fixed expiry, only the
// sha256 of the token stored -- a copy of the database can't be replayed
// as a cookie. In the database so a redeploy doesn't log anyone out.
// ============================================================

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const tokenHash = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

export function createSession(db: DatabaseSync, nowMs: number): { token: string; expiresAt: number } {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = nowMs + SESSION_TTL_MS;
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(nowMs);
  db.prepare("INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)").run(tokenHash(token), nowMs, expiresAt);
  return { token, expiresAt };
}

/** Expiry of a live session, or null (unknown, missing or expired -- an expired row is deleted). */
export function sessionExpiresAt(db: DatabaseSync, token: string | undefined, nowMs: number): number | null {
  if (!token) return null;
  const hash = tokenHash(token);
  const row = db.prepare("SELECT expires_at FROM sessions WHERE token_hash = ?").get(hash) as { expires_at: number } | undefined;
  if (row === undefined) return null;
  if (nowMs >= row.expires_at) {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hash);
    return null;
  }
  return row.expires_at;
}

export function deleteSession(db: DatabaseSync, token: string | undefined): void {
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash(token));
}

export function deleteAllSessions(db: DatabaseSync): void {
  db.prepare("DELETE FROM sessions").run();
}

// ============================================================
// strategies (F1b, DECISIONS.md #20)
// ============================================================

export type StrategyStatus = "active" | "paused" | "completed";

export interface Strategy {
  id: number;
  label: string | null;
  amount: string;
  status: StrategyStatus;
  endDate: string | null;
  maxTotal: string | null;
  createdAt: string;
  stoppedAt: string | null;
}

export interface RunShare {
  strategyId: number;
  wallet: string;
  date: string;
  amountIn: string;
  amountOut: string | null;
  gasCostPol: string | null;
  gasCostUsd: string | null;
}

function rowToStrategy(row: Record<string, unknown>): Strategy {
  return {
    id: Number(row.id),
    label: (row.label as string | null) ?? null,
    amount: row.amount as string,
    status: row.status as StrategyStatus,
    endDate: (row.end_date as string | null) ?? null,
    maxTotal: (row.max_total as string | null) ?? null,
    createdAt: row.created_at as string,
    stoppedAt: (row.stopped_at as string | null) ?? null,
  };
}

function rowToShare(row: Record<string, unknown>): RunShare {
  return {
    strategyId: Number(row.strategy_id),
    wallet: row.wallet as string,
    date: row.date as string,
    amountIn: row.amount_in as string,
    amountOut: (row.amount_out as string | null) ?? null,
    gasCostPol: (row.gas_cost_pol as string | null) ?? null,
    gasCostUsd: (row.gas_cost_usd as string | null) ?? null,
  };
}

export function createStrategy(
  db: DatabaseSync,
  s: { label: string | null; amount: string; endDate: string | null; maxTotal?: string | null; createdAt: string; id?: number }
): number {
  const result = db
    .prepare("INSERT INTO strategies (id, label, amount, status, end_date, max_total, created_at) VALUES (?, ?, ?, 'active', ?, ?, ?)")
    .run(s.id ?? null, s.label, s.amount, s.endDate, s.maxTotal ?? null, s.createdAt);
  return Number(result.lastInsertRowid);
}

export function getStrategy(db: DatabaseSync, id: number): Strategy | undefined {
  const row = db.prepare("SELECT * FROM strategies WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? rowToStrategy(row) : undefined;
}

export function listStrategies(db: DatabaseSync): Strategy[] {
  return (db.prepare("SELECT * FROM strategies ORDER BY id").all() as Record<string, unknown>[]).map(rowToStrategy);
}

const NOT_FINAL = "('PENDING', 'BROADCAST')";

/** Units put into a strategy: "invested" = CONFIRMED only; "committed" also counts purchases in flight. */
export function strategyUnits(db: DatabaseSync, id: number, which: "invested" | "committed"): bigint {
  const statuses = which === "invested" ? "('CONFIRMED')" : "('CONFIRMED', 'PENDING', 'BROADCAST')";
  const statement = db.prepare(
      `SELECT COALESCE((SELECT SUM(CAST(s.amount_in AS INTEGER)) FROM run_shares s JOIN runs r ON r.wallet = s.wallet AND r.date = s.date
                        WHERE s.strategy_id = ? AND r.status IN ${statuses}), 0)
            + COALESCE((SELECT SUM(CAST(amount_in AS INTEGER)) FROM manual_runs WHERE strategy_id = ? AND status IN ${statuses}), 0) AS n`
    );
  statement.setReadBigInts(true);
  const row = statement.get(id, id) as { n: bigint };
  return row.n;
}

function reached(db: DatabaseSync, s: Strategy, todayUtc: string, decimals: number) {
  return limitReached(
    { endDate: s.endDate, maxTotalUnits: s.maxTotal === null ? null : toBaseUnits(s.maxTotal, decimals) },
    strategyUnits(db, s.id, "invested"),
    todayUtc
  );
}

/** Active/paused strategies whose end date passed or budget is spent become `completed`. Returns their ids. */
export function completeReachedStrategies(db: DatabaseSync, todayUtc: string, nowIso: string, decimals: number): number[] {
  const done = listStrategies(db).filter((s) => (s.status === "active" || s.status === "paused") && reached(db, s, todayUtc, decimals) !== null);
  const stmt = db.prepare("UPDATE strategies SET status = 'completed', stopped_at = ? WHERE id = ?");
  for (const s of done) stmt.run(nowIso, s.id);
  return done.map((s) => s.id);
}

/** A manual buy's amount (F8): the strategy's own, capped by what's left of its max total (0 = nothing left). */
export function manualBuyUnits(db: DatabaseSync, strategy: Strategy, decimals: number): bigint {
  return nextShareUnits(toBaseUnits(strategy.amount, decimals), strategy.maxTotal ? toBaseUnits(strategy.maxTotal, decimals) : null, strategyUnits(db, strategy.id, "committed"));
}

export type ManualClaimResult = { kind: "claimed"; id: number; amount: string } | { kind: "refused"; reason: string };

/**
 * Reserve a manual buy's budget before verification, under the same write
 * lock as the limit check. The amount is the strategy's own (F8, DECISIONS.md
 * #24) -- the last buy before its max total takes only what's left, like the
 * final scheduled share (nextShareUnits).
 */
export function claimManualRun(
  db: DatabaseSync, wallet: string, date: string, createdAt: string, strategyId: number, decimals: number,
  assertCurrentSigner?: () => void
): ManualClaimResult {
  db.exec("BEGIN IMMEDIATE");
  try {
    assertCurrentSigner?.(); // same write lock as storePrivateKey; no reservation with a stale signer
    completeReachedStrategies(db, date, createdAt, decimals);
    const strategy = getStrategy(db, strategyId);
    const units = strategy ? manualBuyUnits(db, strategy, decimals) : 0n;
    const reason =
      !strategy ? `strategy #${strategyId} not found`
      : strategy.status === "completed" ? `strategy #${strategyId} is completed -- reactivate it, or raise its max total or end date, in the app`
      : units <= 0n ? `strategy #${strategyId} has nothing left of its max total`
      : isPaused(db, createdAt) ? "DCA is paused -- manual buy refused (npm run resume first)"
      : null;
    if (reason) {
      db.exec("COMMIT");
      return { kind: "refused", reason };
    }
    const id = insertManualRun(db, wallet, date, createdAt, strategyId);
    updateManualRun(db, id, { amountIn: units.toString() });
    db.exec("COMMIT");
    return { kind: "claimed", id, amount: formatUnits(units, decimals) };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * A `completed` strategy (limit reached, or completed by hand) becomes active
 * again when the patch moves a limit (later end date, higher/cleared max
 * total) so none applies any more -- editing only the label or amount leaves
 * it completed. Asking for `active` while a limit is still reached is refused.
 */
export function updateStrategy(
  db: DatabaseSync,
  id: number,
  patch: { label?: string | null; amount?: string; endDate?: string | null; maxTotal?: string | null; status?: StrategyStatus },
  nowIso: string,
  todayUtc: string,
  decimals: number
): void {
  const current = getStrategy(db, id);
  if (!current) throw new Error(`strategy #${id} not found`);
  const next: Strategy = { ...current, ...patch };
  const limit = reached(db, next, todayUtc, decimals);
  if (patch.status === "active" && limit !== null) throw new Error(`strategy #${id}: limit reached (${limit}) -- raise the max total or move the end date first`);
  if (current.status === "completed" && patch.status === undefined && (patch.endDate !== undefined || patch.maxTotal !== undefined)) next.status = limit === null ? "active" : "completed";
  const ended = next.status === "completed";
  db.prepare("UPDATE strategies SET label = ?, amount = ?, end_date = ?, max_total = ?, status = ?, stopped_at = ? WHERE id = ?").run(
    next.label,
    next.amount,
    next.endDate,
    next.maxTotal,
    next.status,
    ended ? (current.stoppedAt ?? nowIso) : null,
    id
  );
}

/** Only a completed strategy with nothing in flight. Removes its shares and manual rows; never a runs row (the tx record recovery reads). */
export function deleteStrategy(db: DatabaseSync, id: number): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    const s = getStrategy(db, id);
    if (!s) throw new Error(`strategy #${id} not found`);
    if (s.status !== "completed") throw new Error(`complete strategy #${id} before deleting it`);
    const inFlight = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM manual_runs WHERE strategy_id = ? AND status IN ${NOT_FINAL})
              + (SELECT COUNT(*) FROM run_shares s JOIN runs r ON r.wallet = s.wallet AND r.date = s.date
                 WHERE s.strategy_id = ? AND r.status IN ${NOT_FINAL}) AS n`
      )
      .get(id, id) as { n: number };
    if (inFlight.n > 0) throw new Error(`strategy #${id} has a purchase in progress (PENDING/BROADCAST) -- try again once it settles`);
    db.prepare("DELETE FROM run_shares WHERE strategy_id = ?").run(id);
    db.prepare("DELETE FROM manual_runs WHERE strategy_id = ?").run(id);
    db.prepare("DELETE FROM strategies WHERE id = ?").run(id);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Amounts of the strategies that would buy on `todayUtc` (active, end date not past) -- display and approve cap; the claim applies the budget. */
export function activeAmounts(db: DatabaseSync, todayUtc: string): string[] {
  const rows = db
    .prepare("SELECT amount FROM strategies WHERE status = 'active' AND (end_date IS NULL OR end_date >= ?) ORDER BY id")
    .all(todayUtc) as { amount: string }[];
  return rows.map((r) => r.amount);
}

export type ClaimResult = { kind: "claimed"; shares: RunShare[] } | { kind: "already-claimed" } | { kind: "nothing-to-buy" };

/**
 * The scheduled run's lock (README.md invariant #2), in ONE BEGIN IMMEDIATE:
 *   1. strategies whose end date passed or budget is spent become completed;
 *   2. an existing runs row for (wallet, date) -> already-claimed (recovery
 *      and "done for today" live in the caller, as before);
 *   3. active strategies WITHOUT a share on `date` (a key change mid-day
 *      can't buy the same strategy twice), each for min(amount, what's left
 *      of its budget) -- none -> nothing-to-buy, no row;
 *   4. insert the runs row (PENDING) and one share per strategy.
 * A strategy created after today's claim waits for tomorrow.
 */
export function claimScheduledRun(db: DatabaseSync, wallet: string, date: string, nowIso: string, decimalsIn: number, assertCurrentSigner?: () => void): ClaimResult {
  db.exec("BEGIN IMMEDIATE");
  try {
    assertCurrentSigner?.(); // same write lock as storePrivateKey; no PENDING row with a stale signer
    completeReachedStrategies(db, date, nowIso, decimalsIn);
    if (db.prepare("SELECT 1 FROM runs WHERE wallet = ? AND date = ?").get(wallet, date)) {
      db.exec("COMMIT");
      return { kind: "already-claimed" };
    }
    const picked = (
      db
        .prepare(
          `SELECT id, amount, max_total FROM strategies
           WHERE status = 'active' AND id NOT IN (SELECT strategy_id FROM run_shares WHERE date = ?)
           ORDER BY id`
        )
        .all(date) as { id: number; amount: string; max_total: string | null }[]
    )
      .map((p) => ({
        id: Number(p.id),
        units: nextShareUnits(
          toBaseUnits(p.amount, decimalsIn),
          p.max_total === null ? null : toBaseUnits(p.max_total, decimalsIn),
          strategyUnits(db, Number(p.id), "committed")
        ),
      }))
      .filter((p) => p.units > 0n);
    if (picked.length === 0) {
      db.exec("COMMIT");
      return { kind: "nothing-to-buy" };
    }
    db.prepare("INSERT INTO runs (wallet, date, status) VALUES (?, ?, 'PENDING')").run(wallet, date);
    const insert = db.prepare("INSERT INTO run_shares (strategy_id, wallet, date, amount_in) VALUES (?, ?, ?, ?)");
    const shares: RunShare[] = picked.map((p) => {
      const amountIn = p.units.toString();
      insert.run(p.id, wallet, date, amountIn);
      return { strategyId: p.id, wallet, date, amountIn, amountOut: null, gasCostPol: null, gasCostUsd: null };
    });
    db.exec("COMMIT");
    return { kind: "claimed", shares };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function listRunShares(db: DatabaseSync, wallet: string, date: string): RunShare[] {
  return (db.prepare("SELECT * FROM run_shares WHERE wallet = ? AND date = ? ORDER BY strategy_id").all(wallet, date) as Record<string, unknown>[]).map(rowToShare);
}

export function setShareResults(
  db: DatabaseSync,
  wallet: string,
  date: string,
  results: { strategyId: number; amountOut: string; gasCostPol: string | null; gasCostUsd: string | null }[]
): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    writeShareResults(db, wallet, date, results);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function writeShareResults(
  db: DatabaseSync, wallet: string, date: string,
  results: { strategyId: number; amountOut: string; gasCostPol: string | null; gasCostUsd: string | null }[]
): void {
  const count = db.prepare("SELECT COUNT(*) AS n FROM run_shares WHERE wallet = ? AND date = ?").get(wallet, date) as { n: number };
  if (count.n !== results.length) throw new Error("share result count does not match claimed shares");
  const stmt = db.prepare("UPDATE run_shares SET amount_out = ?, gas_cost_pol = ?, gas_cost_usd = ? WHERE strategy_id = ? AND wallet = ? AND date = ?");
  for (const r of results) {
    const changed = stmt.run(r.amountOut, r.gasCostPol, r.gasCostUsd, r.strategyId, wallet, date);
    if (changed.changes !== 1) throw new Error(`share result for strategy #${r.strategyId} has no claimed share`);
  }
}

/** A receipt's successful output and its strategy allocations become visible together. */
export function confirmScheduledRun(
  db: DatabaseSync, wallet: string, date: string, patch: RunPatch & { status: "CONFIRMED" },
  results: { strategyId: number; amountOut: string; gasCostPol: string | null; gasCostUsd: string | null }[]
): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (getRun(db, wallet, date)?.status !== "BROADCAST") throw new Error("scheduled run is not in BROADCAST");
    writeShareResults(db, wallet, date, results);
    updateRun(db, wallet, date, patch);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** One strategy's history: its share of each scheduled swap (runs fields + the share's amounts) and its manual buys. */
export function listStrategyHistory(db: DatabaseSync, strategyId: number): Run[] {
  const scheduled = (
    db
      .prepare(
        `SELECT r.*, s.amount_in AS share_in, s.amount_out AS share_out, s.gas_cost_pol AS share_pol, s.gas_cost_usd AS share_usd
         FROM run_shares s JOIN runs r ON r.wallet = s.wallet AND r.date = s.date
         WHERE s.strategy_id = ?`
      )
      .all(strategyId) as Record<string, unknown>[]
  ).map((row) => ({
    ...rowToRun(row),
    amountIn: row.share_in as string,
    amountOut: (row.share_out as string | null) ?? null,
    gasCostPol: (row.share_pol as string | null) ?? null,
    gasCostUsd: (row.share_usd as string | null) ?? null,
  }));
  const manual = (db.prepare("SELECT * FROM manual_runs WHERE strategy_id = ?").all(strategyId) as Record<string, unknown>[]).map(rowToRun);
  const moment = (r: Run) => r.createdAt ?? r.confirmedAt ?? "";
  return [...scheduled, ...manual].sort((a, b) => b.date.localeCompare(a.date) || moment(b).localeCompare(moment(a)));
}

// ============================================================
// settings (F1c) -- one row, validated by validation.ts validateSettings
// before it gets here (setup.ts seed, server.ts POST /api/settings).
// ============================================================

export function getSettings(db: DatabaseSync): Settings | undefined {
  const row = db.prepare("SELECT * FROM settings WHERE id = 1").get() as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    runTime: row.run_time as string,
    maxSlippagePct: Number(row.max_slippage_pct),
    maxPriceImpactPct: Number(row.max_price_impact_pct),
    maxOracleDeviationPct: Number(row.max_oracle_deviation_pct),
    approvalDays: Number(row.approval_days),
    minPolBalance: Number(row.min_pol_balance),
  };
}

export function saveSettings(db: DatabaseSync, s: Settings, nowIso: string): void {
  db.prepare(
    `INSERT INTO settings (id, run_time, max_slippage_pct, max_price_impact_pct, max_oracle_deviation_pct, approval_days, min_pol_balance, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET run_time = excluded.run_time, max_slippage_pct = excluded.max_slippage_pct,
       max_price_impact_pct = excluded.max_price_impact_pct, max_oracle_deviation_pct = excluded.max_oracle_deviation_pct,
       approval_days = excluded.approval_days, min_pol_balance = excluded.min_pol_balance, updated_at = excluded.updated_at`
  ).run(s.runTime, s.maxSlippagePct, s.maxPriceImpactPct, s.maxOracleDeviationPct, s.approvalDays, s.minPolBalance, nowIso);
}

// ============================================================
// email report mode (F9) -- scheduled-run reports only; no row = "all".
// ============================================================

export const REPORT_MODES = ["all", "errors", "off"] as const;
export type ReportMode = (typeof REPORT_MODES)[number];

export function getReportMode(db: DatabaseSync): ReportMode {
  const row = db.prepare("SELECT mode FROM report_pref WHERE id = 1").get() as { mode: ReportMode } | undefined;
  return row?.mode ?? "all";
}

export function setReportMode(db: DatabaseSync, mode: ReportMode): void {
  db.prepare("INSERT INTO report_pref (id, mode) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET mode = excluded.mode").run(mode);
}

/** Low-funds alert threshold in days; no row = 2. Running out (0 runs left) always alerts. */
export function getAlertDays(db: DatabaseSync): number {
  const row = db.prepare("SELECT alert_days FROM report_pref WHERE id = 1").get() as { alert_days: number } | undefined;
  return row?.alert_days ?? 2;
}

export function setAlertDays(db: DatabaseSync, days: number): void {
  if (!Number.isInteger(days)) throw new Error("alert days must be a whole number");
  db.prepare("INSERT INTO report_pref (id, mode, alert_days) VALUES (1, 'all', ?) ON CONFLICT (id) DO UPDATE SET alert_days = excluded.alert_days").run(days);
}
