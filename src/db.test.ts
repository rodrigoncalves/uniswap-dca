import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { openDb, claimDay, getRun, updateRun, listRuns, isPaused, setPaused, getControl, insertManualRun, updateManualRun, listManualRuns, listAllRuns, getSecret, putSecret, deleteSecret, claimTotpStep, resetTotpStep, createStrategy, getStrategy, listStrategies, updateStrategy, claimScheduledRun, claimManualRun, confirmScheduledRun, listRunShares, strategyUnits, completeReachedStrategies, activeAmounts, setShareResults, listStrategyHistory, deleteStrategy, createSession, sessionExpiresAt, deleteSession, deleteAllSessions, SESSION_TTL_MS, recentGasCostsPol, getSettings, saveSettings, countInFlight, getReportMode, setReportMode, getAlertDays, setAlertDays } from "./db.js";
import { assertPrivateKeyUnchanged, loadPrivateKey, storePrivateKey } from "./setup.js";
import { parsePrivateKey } from "./validation.js";

const WALLET = "0x000000000000000000000000000000000000000A";

test("countInFlight: PENDING and BROADCAST across runs and manual_runs", () => {
  const db = openDb(":memory:");
  assert.equal(countInFlight(db), 0);
  claimDay(db, WALLET, "2026-09-24");
  const m = insertManualRun(db, WALLET, "2026-09-24", "2026-09-24T01:00:00Z", 1);
  updateManualRun(db, m, { status: "BROADCAST" });
  assert.equal(countInFlight(db), 2);
  updateRun(db, WALLET, "2026-09-24", { status: "CONFIRMED" });
  updateManualRun(db, m, { status: "FAILED" });
  assert.equal(countInFlight(db), 0);
  db.close();
});

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "dca-db-test-"));
  return join(dir, "test.db");
}

test("migrate: creates the tables on first open, and opening again doesn't fail (idempotent)", () => {
  const db1 = openDb(":memory:");
  assert.doesNotThrow(() => db1.exec("SELECT * FROM runs LIMIT 0"));
  assert.doesNotThrow(() => db1.exec("SELECT * FROM control LIMIT 0"));
  db1.close();
});

test("migrate: concurrent first opens of one file serialize the version check", async () => {
  const path = tempDbPath();
  const workerPath = join(import.meta.dirname, "db-claim-worker.ts");
  try {
    await Promise.all(Array.from({ length: 8 }, () => new Promise<void>((resolve, reject) => {
      const child = fork(workerPath, [path, "--open-only"], { execArgv: ["--import", "tsx"], silent: true });
      let stderr = "";
      child.stderr?.on("data", (chunk) => (stderr += chunk));
      child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`concurrent open exited ${code}: ${stderr}`)));
      child.on("error", reject);
    })));
    const db = openDb(path);
    assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 10);
    db.close();
  } finally {
    rmSync(path, { force: true });
  }
});

test("openDb: processes racing to create and write a fresh file never crash with 'database is locked'", async () => {
  // Reproduces the fork battery's `parallel` flake: the WAL pragma can return
  // SQLITE_BUSY without consulting busy_timeout while another process is
  // mid-transaction on a file that was just created.
  const workerPath = join(import.meta.dirname, "db-claim-worker.ts");
  for (let round = 0; round < 15; round++) {
    const path = tempDbPath();
    try {
      await Promise.all(Array.from({ length: 4 }, () => new Promise<void>((resolve, reject) => {
        const child = fork(workerPath, [path, "--seed-only"], { execArgv: ["--import", "tsx"], silent: true });
        let stderr = "";
        child.stderr?.on("data", (chunk) => (stderr += chunk));
        child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`round ${round}: worker exited ${code}: ${stderr}`)));
        child.on("error", reject);
      })));
    } finally {
      rmSync(path, { force: true });
    }
  }
});

test("claimDay: first call claims the day, second call (same wallet+date) doesn't claim again", () => {
  const db = openDb(":memory:");
  const first = claimDay(db, WALLET, "2026-09-22");
  const second = claimDay(db, WALLET, "2026-09-22");
  assert.equal(first, true);
  assert.equal(second, false);
  db.close();
});

test("claimDay: different dates are independent claims", () => {
  const db = openDb(":memory:");
  assert.equal(claimDay(db, WALLET, "2026-09-22"), true);
  assert.equal(claimDay(db, WALLET, "2026-09-23"), true);
  db.close();
});

test("claimDay: different wallets on the same date are independent claims", () => {
  const db = openDb(":memory:");
  const other = "0x000000000000000000000000000000000000dEaD";
  assert.equal(claimDay(db, WALLET, "2026-09-22"), true);
  assert.equal(claimDay(db, other, "2026-09-22"), true);
  db.close();
});

test("claimDay: the claimed day starts as PENDING", () => {
  const db = openDb(":memory:");
  claimDay(db, WALLET, "2026-09-22");
  const run = getRun(db, WALLET, "2026-09-22");
  assert.equal(run?.status, "PENDING");
  db.close();
});

test("getRun: undefined for a day never claimed", () => {
  const db = openDb(":memory:");
  assert.equal(getRun(db, WALLET, "2026-01-01"), undefined);
  db.close();
});

test("updateRun: transitions PENDING -> BROADCAST -> CONFIRMED preserving the other fields", () => {
  const db = openDb(":memory:");
  claimDay(db, WALLET, "2026-09-22");
  updateRun(db, WALLET, "2026-09-22", { status: "BROADCAST", nonce: 42, txHash: "0xabc" });
  let run = getRun(db, WALLET, "2026-09-22");
  assert.equal(run?.status, "BROADCAST");
  assert.equal(run?.nonce, 42);
  assert.equal(run?.txHash, "0xabc");

  updateRun(db, WALLET, "2026-09-22", { status: "CONFIRMED", confirmedAt: "2026-09-22T12:00:00Z", amountOut: "232405" });
  run = getRun(db, WALLET, "2026-09-22");
  assert.equal(run?.status, "CONFIRMED");
  assert.equal(run?.nonce, 42, "a field from a previous update must not be lost");
  assert.equal(run?.txHash, "0xabc");
  assert.equal(run?.amountOut, "232405");
  db.close();
});

test("listRuns: orders by date descending and respects the wallet filter", () => {
  const db = openDb(":memory:");
  const other = "0x000000000000000000000000000000000000dEaD";
  claimDay(db, WALLET, "2026-09-20");
  claimDay(db, WALLET, "2026-09-22");
  claimDay(db, WALLET, "2026-09-21");
  claimDay(db, other, "2026-09-23");

  const mine = listRuns(db, { wallet: WALLET });
  assert.deepEqual(
    mine.map((r) => r.date),
    ["2026-09-22", "2026-09-21", "2026-09-20"]
  );
  db.close();
});

test("listRuns: limit truncates the result", () => {
  const db = openDb(":memory:");
  claimDay(db, WALLET, "2026-09-20");
  claimDay(db, WALLET, "2026-09-21");
  claimDay(db, WALLET, "2026-09-22");
  assert.equal(listRuns(db, { wallet: WALLET, limit: 2 }).length, 2);
  db.close();
});

// ============================================================
// control: pause / resume
// ============================================================

test("isPaused: false when there is no control row (normal state, active)", () => {
  const db = openDb(":memory:");
  assert.equal(isPaused(db, "2026-09-22T12:00:00Z"), false);
  db.close();
});

test("setPaused + isPaused: pausing without a resume date stays paused indefinitely", () => {
  const db = openDb(":memory:");
  setPaused(db, { paused: true, reason: "traveling" });
  assert.equal(isPaused(db, "2026-09-22T12:00:00Z"), true);
  assert.equal(isPaused(db, "2027-01-01T12:00:00Z"), true);
  db.close();
});

test("setPaused with pausedUntil in the future: stays paused before that date", () => {
  const db = openDb(":memory:");
  setPaused(db, { paused: true, until: "2026-10-01T00:00:00Z" });
  assert.equal(isPaused(db, "2026-09-22T12:00:00Z"), true);
  db.close();
});

test("setPaused with pausedUntil in the past: resumes on its own (isPaused becomes false)", () => {
  const db = openDb(":memory:");
  setPaused(db, { paused: true, until: "2026-01-01T00:00:00Z" });
  assert.equal(isPaused(db, "2026-09-22T12:00:00Z"), false);
  db.close();
});

test("setPaused(false): resumes explicitly", () => {
  const db = openDb(":memory:");
  setPaused(db, { paused: true });
  setPaused(db, { paused: false });
  assert.equal(isPaused(db, "2026-09-22T12:00:00Z"), false);
  db.close();
});

// ============================================================
// real concurrency: two PROCESSES contending for the same day in the same
// file -- this is the whole system's idempotency guarantee (README.md invariant #2).
// ============================================================

test("claimScheduledRun: two concurrent processes on the same file -- only one claims", async () => {
  const dbPath = tempDbPath();
  try {
    // open once in this process just to create the schema before the race
    const setup = openDb(dbPath);
    createStrategy(setup, { label: null, amount: "10", endDate: null, createdAt: T0 });
    setup.close();

    const workerPath = join(import.meta.dirname, "db-claim-worker.ts");
    const runInChild = () =>
      new Promise<{ claimed: boolean }>((resolve, reject) => {
        const child = fork(workerPath, [dbPath, WALLET, "2026-09-22"], {
          execArgv: ["--import", "tsx"],
          // without this, fork() inherits the parent's stdout instead of piping --
          // child.stdout is null and the read fails silently
          // (found by actually running the test, not by reading docs).
          silent: true,
        });
        let output = "";
        let stderrOutput = "";
        child.stdout?.on("data", (chunk) => (output += chunk));
        child.stderr?.on("data", (chunk) => (stderrOutput += chunk));
        // "close" waits for the stdio streams to fully drain before firing --
        // "exit" can fire first, with the child's stdout still in transit to
        // the parent (found by actually running the test: it gave
        // "Unexpected end of JSON input" for exactly this reason).
        child.on("close", (code) => {
          if (code !== 0) reject(new Error(`worker exited with code ${code}. stdout=${JSON.stringify(output)} stderr=${JSON.stringify(stderrOutput)}`));
          else resolve(JSON.parse(output.trim()));
        });
        child.on("error", reject);
      });

    const [a, b] = await Promise.all([runInChild(), runInChild()]);
    const claims = [a.claimed, b.claimed].filter(Boolean);
    assert.equal(claims.length, 1, `expected exactly 1 process claiming the day, got ${claims.length}`);
  } finally {
    rmSync(dbPath, { force: true });
    rmSync(dbPath + "-wal", { force: true });
    rmSync(dbPath + "-shm", { force: true });
  }
});

test("getControl: undefined when there is no control row", () => {
  const db = openDb(":memory:");
  assert.equal(getControl(db), undefined);
  db.close();
});

test("getControl: returns the raw fields for the app to display (reason, pausedAt, pausedUntil)", () => {
  const db = openDb(":memory:");
  setPaused(db, { paused: true, until: "2026-10-01T00:00:00Z", reason: "traveling", pausedAt: "2026-09-22T10:00:00Z" });
  const control = getControl(db);
  assert.equal(control?.paused, true);
  assert.equal(control?.reason, "traveling");
  assert.equal(control?.pausedUntil, "2026-10-01T00:00:00Z");
  assert.equal(control?.pausedAt, "2026-09-22T10:00:00Z");
  db.close();
});

test("migrate v2: deadline column exists and updateRun writes/reads it", () => {
  const db = openDb(":memory:");
  claimDay(db, WALLET, "2026-09-23");
  updateRun(db, WALLET, "2026-09-23", { deadline: 1790000000 });
  assert.equal(getRun(db, WALLET, "2026-09-23")?.deadline, 1790000000);
  db.close();
});

test("migrate v1 -> v2: existing database gains the column without losing rows", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const path = tempDbPath();
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE runs (wallet TEXT NOT NULL, date TEXT NOT NULL, status TEXT NOT NULL, nonce INTEGER, tx_hash TEXT,
    block_number TEXT, confirmed_at TEXT, amount_in TEXT, amount_out TEXT, recipient TEXT, effective_price TEXT,
    minimum_amount TEXT, price_impact_pct TEXT, oracle_btc_usd TEXT, oracle_usdt_usd TEXT, oracle_pol_usd TEXT,
    oracle_deviation_pct TEXT, gas_used TEXT, gas_cost_pol TEXT, gas_cost_usd TEXT, routing TEXT, route_string TEXT,
    request_id TEXT, quote_id TEXT, error TEXT, PRIMARY KEY (wallet, date));
    CREATE TABLE control (wallet TEXT PRIMARY KEY, paused INTEGER NOT NULL DEFAULT 0, paused_at TEXT, paused_until TEXT, reason TEXT);
    INSERT INTO runs (wallet, date, status) VALUES ('${WALLET}', '2026-09-01', 'CONFIRMED');
    PRAGMA user_version = 1;`);
  old.close();

  const db = openDb(path);
  assert.equal(getRun(db, WALLET, "2026-09-01")?.status, "CONFIRMED");
  assert.equal(getRun(db, WALLET, "2026-09-01")?.deadline, null);
  db.close();
  rmSync(join(path, ".."), { recursive: true, force: true });
});

// ============================================================
// manual_runs -- extra purchases on top of the daily one (DECISIONS.md #17).
// No per-day lock: as many as the user wants on the same date, each with
// its own id. The daily lock in `runs` stays untouched.
// ============================================================

test("insertManualRun: several on the same date, each with its own id, starting PENDING", () => {
  const db = openDb(":memory:");
  const a = insertManualRun(db, WALLET, "2026-09-23", "2026-09-23T10:00:00.000Z", 1);
  const b = insertManualRun(db, WALLET, "2026-09-23", "2026-09-23T11:00:00.000Z", 1);
  assert.notEqual(a, b);
  const runs = listManualRuns(db, { wallet: WALLET });
  assert.equal(runs.length, 2);
  assert.ok(runs.every((r) => r.status === "PENDING" && r.date === "2026-09-23"));
  db.close();
});

test("manual runs and the daily claim coexist on the same date", () => {
  const db = openDb(":memory:");
  insertManualRun(db, WALLET, "2026-09-23", "2026-09-23T10:00:00.000Z", 1);
  assert.equal(claimDay(db, WALLET, "2026-09-23"), true);
  assert.equal(listRuns(db, { wallet: WALLET }).length, 1);
  assert.equal(listManualRuns(db, { wallet: WALLET }).length, 1);
  db.close();
});

test("updateManualRun: changes only the given row, preserving its other fields", () => {
  const db = openDb(":memory:");
  const a = insertManualRun(db, WALLET, "2026-09-23", "2026-09-23T10:00:00.000Z", 1);
  const b = insertManualRun(db, WALLET, "2026-09-23", "2026-09-23T11:00:00.000Z", 1);
  updateManualRun(db, a, { status: "BROADCAST", nonce: 7, txHash: "0xabc" });
  updateManualRun(db, a, { status: "CONFIRMED" });
  const byId = new Map(listManualRuns(db, { wallet: WALLET }).map((r) => [r.manualId, r]));
  assert.equal(byId.get(a)?.status, "CONFIRMED");
  assert.equal(byId.get(a)?.nonce, 7);
  assert.equal(byId.get(a)?.txHash, "0xabc");
  assert.equal(byId.get(b)?.status, "PENDING");
  db.close();
});

test("listManualRuns: newest first, wallet filter, createdAt exposed; daily runs have no manualId", () => {
  const db = openDb(":memory:");
  insertManualRun(db, WALLET, "2026-09-22", "2026-09-22T10:00:00.000Z", 1);
  insertManualRun(db, WALLET, "2026-09-23", "2026-09-23T09:00:00.000Z", 1);
  insertManualRun(db, "0x000000000000000000000000000000000000000B", "2026-09-23", "2026-09-23T12:00:00.000Z", 1);
  const runs = listManualRuns(db, { wallet: WALLET });
  assert.deepEqual(runs.map((r) => r.createdAt), ["2026-09-23T09:00:00.000Z", "2026-09-22T10:00:00.000Z"]);
  claimDay(db, WALLET, "2026-09-23");
  assert.equal(getRun(db, WALLET, "2026-09-23")?.manualId, undefined);
  db.close();
});

test("migrate v2 -> v3: existing database gains manual_runs without losing daily rows", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const path = tempDbPath();
  const v2 = openDb(path);
  claimDay(v2, WALLET, "2026-09-01");
  v2.exec("DROP TABLE manual_runs; PRAGMA user_version = 2;");
  v2.close();
  assert.ok(new DatabaseSync(path)); // file still opens raw

  const db = openDb(path);
  assert.equal(getRun(db, WALLET, "2026-09-01")?.status, "PENDING");
  insertManualRun(db, WALLET, "2026-09-01", "2026-09-01T10:00:00.000Z", 1);
  assert.equal(listManualRuns(db, { wallet: WALLET }).length, 1);
  db.close();
  rmSync(join(path, ".."), { recursive: true, force: true });
});

test("listAllRuns: daily and manual together, newest date first, then newest time within the day", () => {
  const db = openDb(":memory:");
  claimDay(db, WALLET, "2026-09-22");
  claimDay(db, WALLET, "2026-09-23");
  updateRun(db, WALLET, "2026-09-23", { status: "CONFIRMED", confirmedAt: "2026-09-23T00:00:05.000Z" });
  const m = insertManualRun(db, WALLET, "2026-09-23", "2026-09-23T20:31:00.000Z", 1);
  const all = listAllRuns(db);
  assert.deepEqual(
    all.map((r) => [r.date, r.manualId ?? "daily"]),
    [["2026-09-23", m], ["2026-09-23", "daily"], ["2026-09-22", "daily"]]
  );
  db.close();
});

test("secrets: put, get, overwrite, delete", () => {
  const db = openDb(":memory:");
  assert.equal(getSecret(db, "totp_secret"), undefined);
  putSecret(db, "totp_secret", "blob-1");
  assert.equal(getSecret(db, "totp_secret"), "blob-1");
  putSecret(db, "totp_secret", "blob-2");
  assert.equal(getSecret(db, "totp_secret"), "blob-2");
  assert.equal(getSecret(db, "private_key"), undefined, "names are independent");
  deleteSecret(db, "totp_secret");
  assert.equal(getSecret(db, "totp_secret"), undefined);
  db.close();
});

test("claimTotpStep: each step accepted once, older steps never, survives reopening the file", () => {
  const path = tempDbPath();
  const db = openDb(path);
  assert.equal(claimTotpStep(db, 100), true);
  assert.equal(claimTotpStep(db, 100), false, "same step = replay");
  assert.equal(claimTotpStep(db, 99), false, "older step");
  assert.equal(claimTotpStep(db, 101), true);
  db.close();
  const reopened = openDb(path);
  assert.equal(claimTotpStep(reopened, 101), false, "replay after restart");
  resetTotpStep(reopened);
  assert.equal(claimTotpStep(reopened, 50), true, "reset clears the counter");
  reopened.close();
  rmSync(path, { force: true });
});

test("migrate v4: a v3 database gains secrets and auth_state without losing runs", () => {
  const path = tempDbPath();
  const v3 = new DatabaseSync(path);
  v3.exec(`CREATE TABLE runs (wallet TEXT NOT NULL, date TEXT NOT NULL, status TEXT NOT NULL, nonce INTEGER, tx_hash TEXT, block_number TEXT, confirmed_at TEXT, amount_in TEXT, amount_out TEXT, recipient TEXT, effective_price TEXT, minimum_amount TEXT, price_impact_pct TEXT, oracle_btc_usd TEXT, oracle_usdt_usd TEXT, oracle_pol_usd TEXT, oracle_deviation_pct TEXT, gas_used TEXT, gas_cost_pol TEXT, gas_cost_usd TEXT, routing TEXT, route_string TEXT, request_id TEXT, quote_id TEXT, error TEXT, deadline INTEGER, PRIMARY KEY (wallet, date));
    CREATE TABLE control (wallet TEXT PRIMARY KEY, paused INTEGER NOT NULL DEFAULT 0, paused_at TEXT, paused_until TEXT, reason TEXT);
    CREATE TABLE manual_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, wallet TEXT NOT NULL, date TEXT NOT NULL, status TEXT NOT NULL);
    INSERT INTO runs (wallet, date, status) VALUES ('${WALLET}', '2026-09-20', 'CONFIRMED');
    PRAGMA user_version = 3;`);
  v3.close();
  const db = openDb(path);
  assert.equal(getRun(db, WALLET, "2026-09-20")?.status, "CONFIRMED");
  putSecret(db, "totp_secret", "b");
  assert.equal(claimTotpStep(db, 1), true);
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 10);
  db.close();
  rmSync(path, { force: true });
});


const T0 = "2026-09-24T00:00:05.000Z";

const TODAY = "2026-09-24";

test("key rotated after signer load: scheduled and manual claims reserve nothing", () => {
  const db = openDb(":memory:");
  const masterKey = Buffer.alloc(32, 11);
  const originalKey = parsePrivateKey(`0x${"1".repeat(64)}`).key;
  const replacementKey = parsePrivateKey(`0x${"2".repeat(64)}`).key;
  const wallet = parsePrivateKey(originalKey).address;
  createStrategy(db, { label: null, amount: "10", endDate: null, createdAt: T0 });
  storePrivateKey(db, masterKey, originalKey);
  const loadedSignerKey = loadPrivateKey(db, masterKey); // the DCA loads this before awaiting RPC
  storePrivateKey(db, masterKey, replacementKey); // app replacement wins the write lock before claim
  const assertCurrentSigner = () => assertPrivateKeyUnchanged(db, masterKey, loadedSignerKey);

  assert.throws(() => claimScheduledRun(db, wallet, TODAY, T0, 6, assertCurrentSigner), /private key changed before purchase claim/);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM run_shares").get() as { n: number }).n, 0);
  assert.throws(() => claimManualRun(db, wallet, TODAY, T0, 1, 6, assertCurrentSigner), /private key changed before purchase claim/);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM manual_runs").get() as { n: number }).n, 0);
  assert.equal(loadPrivateKey(db, masterKey), replacementKey);
  db.close();
});

function withStrategies(db: DatabaseSync, ...amounts: string[]): number[] {
  return amounts.map((amount) => createStrategy(db, { label: null, amount, endDate: null, createdAt: T0 }));
}

test("strategies: create, get, list, update, complete by hand and reactivate", () => {
  const db = openDb(":memory:");
  const [a] = withStrategies(db, "10");
  assert.deepEqual(getStrategy(db, a!), { id: a, label: null, amount: "10", status: "active", endDate: null, maxTotal: null, createdAt: T0, stoppedAt: null });
  updateStrategy(db, a!, { label: "Aug/26", amount: "12.5", endDate: "2026-12-31" }, T0, TODAY, 6);
  updateStrategy(db, a!, { status: "paused" }, T0, TODAY, 6);
  assert.equal(getStrategy(db, a!)!.status, "paused");
  updateStrategy(db, a!, { status: "completed" }, "2026-09-25T10:00:00.000Z", TODAY, 6);
  assert.equal(getStrategy(db, a!)!.status, "completed");
  assert.equal(getStrategy(db, a!)!.stoppedAt, "2026-09-25T10:00:00.000Z");
  updateStrategy(db, a!, { label: "Renamed" }, T0, TODAY, 6);
  assert.equal(getStrategy(db, a!)!.status, "completed", "editing a label doesn't reactivate a completed strategy");
  updateStrategy(db, a!, { amount: "11" }, T0, TODAY, 6);
  assert.equal(getStrategy(db, a!)!.status, "completed", "nor does the amount");
  updateStrategy(db, a!, { endDate: "2027-01-31" }, T0, TODAY, 6);
  assert.equal(getStrategy(db, a!)!.status, "active", "moving a limit revives it");
  updateStrategy(db, a!, { status: "completed" }, T0, TODAY, 6);
  updateStrategy(db, a!, { status: "active" }, T0, TODAY, 6);
  assert.equal(getStrategy(db, a!)!.status, "active", "asking for active works when no limit is reached");
  assert.equal(getStrategy(db, a!)!.stoppedAt, null);
  assert.equal(listStrategies(db).length, 1);
  db.close();
});

test("claimScheduledRun: one runs row + one share per active strategy, amounts in token units", () => {
  const db = openDb(":memory:");
  const [a, b, c] = withStrategies(db, "10", "20", "5");
  updateStrategy(db, c!, { status: "paused" }, T0, TODAY, 6);
  const result = claimScheduledRun(db, WALLET, "2026-09-24", T0, 6);
  assert.equal(result.kind, "claimed");
  assert.deepEqual(result.kind === "claimed" && result.shares.map((s) => [s.strategyId, s.amountIn]), [[a, "10000000"], [b, "20000000"]]);
  assert.equal(getRun(db, WALLET, "2026-09-24")!.status, "PENDING");
  db.close();
});

test("claimScheduledRun: second call same wallet+date -> already-claimed, even if a strategy was added in between", () => {
  const db = openDb(":memory:");
  withStrategies(db, "10");
  claimScheduledRun(db, WALLET, "2026-09-24", T0, 6);
  withStrategies(db, "20");
  assert.deepEqual(claimScheduledRun(db, WALLET, "2026-09-24", T0, 6), { kind: "already-claimed" });
  assert.equal(listRunShares(db, WALLET, "2026-09-24").length, 1);
  db.close();
});

test("claimScheduledRun: another wallet same date only takes strategies without a share today", () => {
  const db = openDb(":memory:");
  const [, b] = withStrategies(db, "10");
  claimScheduledRun(db, WALLET, "2026-09-24", T0, 6);
  const other = "0x000000000000000000000000000000000000000B";
  assert.deepEqual(claimScheduledRun(db, other, "2026-09-24", T0, 6), { kind: "nothing-to-buy" });
  assert.equal(getRun(db, other, "2026-09-24"), undefined, "no runs row when there is nothing to buy");
  const [late] = withStrategies(db, "7");
  const r = claimScheduledRun(db, other, "2026-09-24", T0, 6);
  assert.deepEqual(r.kind === "claimed" && r.shares.map((s) => s.strategyId), [late]);
  void b;
  db.close();
});

test("claimScheduledRun: no active strategy -> nothing-to-buy, no runs row", () => {
  const db = openDb(":memory:");
  assert.deepEqual(claimScheduledRun(db, WALLET, "2026-09-24", T0, 6), { kind: "nothing-to-buy" });
  assert.equal(getRun(db, WALLET, "2026-09-24"), undefined);
  db.close();
});

test("claimScheduledRun: buys on the end date, completes the strategy the day after", () => {
  const db = openDb(":memory:");
  const [a] = withStrategies(db, "10");
  updateStrategy(db, a!, { endDate: "2026-09-24" }, T0, TODAY, 6);
  assert.equal(claimScheduledRun(db, WALLET, "2026-09-24", T0, 6).kind, "claimed");
  assert.deepEqual(claimScheduledRun(db, WALLET, "2026-09-25", "2026-09-25T00:00:05.000Z", 6), { kind: "nothing-to-buy" });
  assert.equal(getStrategy(db, a!)!.status, "completed");
  assert.equal(getStrategy(db, a!)!.stoppedAt, "2026-09-25T00:00:05.000Z");
  updateStrategy(db, a!, { endDate: "2026-12-31" }, "2026-09-25T09:00:00.000Z", "2026-09-25", 6);
  assert.equal(getStrategy(db, a!)!.status, "active", "a later end date revives it");
  assert.equal(getStrategy(db, a!)!.stoppedAt, null);
  db.close();
});

test("claimScheduledRun: max total -- the share is what's left of the budget, then completed", () => {
  const db = openDb(":memory:");
  const a = createStrategy(db, { label: null, amount: "10", endDate: null, maxTotal: "15", createdAt: T0 });
  const m = insertManualRun(db, WALLET, "2026-09-23", T0, a);
  updateManualRun(db, m, { status: "CONFIRMED", amountIn: "8000000" });
  const r = claimScheduledRun(db, WALLET, "2026-09-24", T0, 6);
  assert.deepEqual(r.kind === "claimed" && r.shares.map((s) => s.amountIn), ["7000000"]);
  assert.equal(strategyUnits(db, a, "committed"), 15_000_000n);
  assert.equal(strategyUnits(db, a, "invested"), 8_000_000n, "today's share isn't confirmed yet");
  updateRun(db, WALLET, "2026-09-24", { status: "CONFIRMED" });
  assert.deepEqual(completeReachedStrategies(db, "2026-09-24", T0, 6), [a]);
  assert.equal(getStrategy(db, a)!.status, "completed");
  assert.throws(() => updateStrategy(db, a, { status: "active" }, T0, TODAY, 6), /limit/);
  updateStrategy(db, a, { maxTotal: "30" }, T0, TODAY, 6);
  assert.equal(getStrategy(db, a)!.status, "active", "a higher max revives it");
  db.close();
});

test("strategyUnits: preserves totals above Number.MAX_SAFE_INTEGER", () => {
  const db = openDb(":memory:");
  const id = createStrategy(db, { label: null, amount: "1", endDate: null, maxTotal: "9007199254.740995", createdAt: T0 });
  const manual = insertManualRun(db, WALLET, TODAY, T0, id);
  updateManualRun(db, manual, { status: "CONFIRMED", amountIn: "9007199254740993" });
  assert.equal(strategyUnits(db, id, "invested"), 9_007_199_254_740_993n);
  assert.equal(strategyUnits(db, id, "committed"), 9_007_199_254_740_993n);
  db.close();
});

test("claimScheduledRun: a failed purchase doesn't count toward the budget", () => {
  const db = openDb(":memory:");
  const a = createStrategy(db, { label: null, amount: "10", endDate: null, maxTotal: "10", createdAt: T0 });
  claimScheduledRun(db, WALLET, "2026-09-23", T0, 6);
  updateRun(db, WALLET, "2026-09-23", { status: "FAILED" });
  assert.equal(completeReachedStrategies(db, "2026-09-24", T0, 6).length, 0);
  const r = claimScheduledRun(db, WALLET, "2026-09-24", T0, 6);
  assert.deepEqual(r.kind === "claimed" && r.shares.map((s) => s.amountIn), ["10000000"]);
  void a;
  db.close();
});

test("claimManualRun: buys the strategy's own amount, the last one only what's left of the max total, then refuses", () => {
  const path = tempDbPath();
  const db1 = openDb(path);
  const db2 = openDb(path);
  try {
    const id = createStrategy(db1, { label: null, amount: "10", endDate: null, maxTotal: "15", createdAt: T0 });
    const first = claimManualRun(db1, WALLET, TODAY, T0, id, 6);
    assert.deepEqual(first, { kind: "claimed", id: 1, amount: "10.000000" });
    assert.equal(strategyUnits(db2, id, "committed"), 10_000_000n, "reserved in PENDING, visible to another connection");
    assert.deepEqual(claimManualRun(db2, WALLET, TODAY, T0, id, 6), { kind: "claimed", id: 2, amount: "5.000000" });
    assert.equal(claimManualRun(db2, WALLET, TODAY, T0, id, 6).kind, "refused");
    assert.deepEqual(listManualRuns(db2, { wallet: WALLET }).map((r) => r.amountIn).sort(), ["10000000", "5000000"]);
  } finally {
    db1.close();
    db2.close();
    rmSync(join(path, ".."), { recursive: true, force: true });
  }
});
test("confirmScheduledRun: status and share output commit together or roll back together", () => {
  const db = openDb(":memory:");
  const id = createStrategy(db, { label: null, amount: "10", endDate: null, createdAt: T0 });
  claimScheduledRun(db, WALLET, TODAY, T0, 6);
  updateRun(db, WALLET, TODAY, { status: "BROADCAST", amountIn: "10000000" });
  const patch = { status: "CONFIRMED" as const, amountOut: "11837" };
  const result = { strategyId: id, amountOut: "11837", gasCostPol: "0.01", gasCostUsd: "0.001" };
  assert.throws(() => confirmScheduledRun(db, WALLET, TODAY, patch, [{ ...result, strategyId: id + 1 }]), /share/);
  assert.equal(getRun(db, WALLET, TODAY)?.status, "BROADCAST");
  assert.equal(listRunShares(db, WALLET, TODAY)[0]?.amountOut, null);
  confirmScheduledRun(db, WALLET, TODAY, patch, [result]);
  assert.equal(getRun(db, WALLET, TODAY)?.status, "CONFIRMED");
  assert.equal(listRunShares(db, WALLET, TODAY)[0]?.amountOut, "11837");
  db.close();
});

test("activeAmounts: active and not past their end date", () => {
  const db = openDb(":memory:");
  const [, b, c] = withStrategies(db, "10", "20", "5");
  updateStrategy(db, b!, { status: "paused" }, T0, TODAY, 6);
  updateStrategy(db, c!, { endDate: "2026-09-23" }, T0, TODAY, 6);
  assert.deepEqual(activeAmounts(db, "2026-09-24"), ["10"]);
  db.close();
});

test("setShareResults + listStrategyHistory: each strategy sees its own amounts; runs fields shared", () => {
  const db = openDb(":memory:");
  const [a, b] = withStrategies(db, "10", "20");
  claimScheduledRun(db, WALLET, "2026-09-24", T0, 6);
  updateRun(db, WALLET, "2026-09-24", { status: "CONFIRMED", amountIn: "30000000", amountOut: "35513", effectivePrice: "84473.73", gasCostPol: "0.070001", gasCostUsd: "0.0071", txHash: "0xabc" });
  setShareResults(db, WALLET, "2026-09-24", [
    { strategyId: a!, amountOut: "11837", gasCostPol: "0.023333", gasCostUsd: "0.0023" },
    { strategyId: b!, amountOut: "23676", gasCostPol: "0.046668", gasCostUsd: "0.0048" },
  ]);
  const ha = listStrategyHistory(db, a!);
  assert.equal(ha.length, 1);
  assert.deepEqual([ha[0]!.amountIn, ha[0]!.amountOut, ha[0]!.gasCostUsd, ha[0]!.txHash, ha[0]!.status], ["10000000", "11837", "0.0023", "0xabc", "CONFIRMED"]);
  assert.equal(listStrategyHistory(db, b!)[0]!.amountOut, "23676");
  db.close();
});

test("listStrategyHistory: includes that strategy's manual buys, newest first, not other strategies'", () => {
  const db = openDb(":memory:");
  const [a, b] = withStrategies(db, "10", "20");
  claimScheduledRun(db, WALLET, "2026-09-24", T0, 6);
  const m1 = insertManualRun(db, WALLET, "2026-09-24", "2026-09-24T12:00:00.000Z", a!);
  insertManualRun(db, WALLET, "2026-09-24", "2026-09-24T13:00:00.000Z", b!);
  const h = listStrategyHistory(db, a!);
  assert.deepEqual(h.map((r) => r.manualId ?? "daily"), [m1, "daily"]);
  db.close();
});

test("deleteStrategy: only when completed; removes its shares and manual rows; keeps runs", () => {
  const db = openDb(":memory:");
  const [a, b] = withStrategies(db, "10", "20");
  claimScheduledRun(db, WALLET, "2026-09-24", T0, 6);
  updateRun(db, WALLET, "2026-09-24", { status: "CONFIRMED" });
  const m = insertManualRun(db, WALLET, "2026-09-24", T0, a!);
  updateManualRun(db, m, { status: "CONFIRMED" });
  assert.throws(() => deleteStrategy(db, a!), /complete/);
  updateStrategy(db, a!, { status: "completed" }, T0, TODAY, 6);
  deleteStrategy(db, a!);
  assert.equal(getStrategy(db, a!), undefined);
  assert.deepEqual(listRunShares(db, WALLET, "2026-09-24").map((s) => s.strategyId), [b]);
  assert.equal(listManualRuns(db, { wallet: WALLET }).length, 0);
  assert.ok(getRun(db, WALLET, "2026-09-24"), "runs row kept (the tx record)");
  db.close();
});

test("deleteStrategy: refused while one of its rows is PENDING or BROADCAST", () => {
  const db = openDb(":memory:");
  const [a] = withStrategies(db, "10");
  const m = insertManualRun(db, WALLET, "2026-09-24", T0, a!);
  updateManualRun(db, m, { status: "BROADCAST" });
  updateStrategy(db, a!, { status: "completed" }, T0, TODAY, 6);
  assert.throws(() => deleteStrategy(db, a!), /BROADCAST|in progress/);
  assert.ok(getStrategy(db, a!));
  db.close();
});

test("pause is global: not tied to a wallet", () => {
  const db = openDb(":memory:");
  setPaused(db, { paused: true, reason: "x" });
  assert.equal(isPaused(db, "2026-09-24T00:00:00Z"), true);
  assert.equal(getControl(db)!.reason, "x");
  db.close();
});

test("migrate v5: v4 history becomes strategy #1's (shares at 100%, manual rows), pause kept as global", () => {
  const path = tempDbPath();
  const db4 = openDb(path);
  db4.exec("PRAGMA user_version = 4");
  db4.close();
  // Rebuild a genuine v4 file: the v5 tables must not exist yet.
  const raw = new DatabaseSync(path);
  raw.exec("DROP TABLE IF EXISTS strategies; DROP TABLE IF EXISTS run_shares;");
  raw.exec(`CREATE TABLE manual_runs_v4 AS SELECT * FROM manual_runs WHERE 0; DROP TABLE manual_runs;`);
  raw.exec(`CREATE TABLE manual_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, wallet TEXT NOT NULL, date TEXT NOT NULL, status TEXT NOT NULL, amount_in TEXT, amount_out TEXT, gas_cost_pol TEXT, gas_cost_usd TEXT, tx_hash TEXT)`);
  raw.exec(`DROP TABLE manual_runs_v4;`);
  raw.exec(`DELETE FROM control; INSERT INTO control (wallet, paused, paused_at, reason) VALUES ('${WALLET}', 1, '2026-09-20T00:00:00Z', 'old pause');`);
  raw.exec(`INSERT INTO runs (wallet, date, status, amount_in, amount_out, gas_cost_usd) VALUES ('${WALLET}', '2026-09-23', 'CONFIRMED', '10000000', '11838', '0.0070');`);
  raw.exec(`INSERT INTO manual_runs (created_at, wallet, date, status, amount_in) VALUES ('2026-09-23T10:00:00Z', '${WALLET}', '2026-09-23', 'CONFIRMED', '5000000');`);
  raw.exec("PRAGMA user_version = 4");
  raw.close();

  const db = openDb(path);
  const shares = listRunShares(db, WALLET, "2026-09-23");
  assert.deepEqual(shares.map((s) => [s.strategyId, s.amountIn, s.amountOut, s.gasCostUsd]), [[1, "10000000", "11838", "0.0070"]]);
  assert.equal((db.prepare("SELECT strategy_id FROM manual_runs").get() as { strategy_id: number }).strategy_id, 1);
  assert.equal(isPaused(db, "2026-09-24T00:00:00Z"), true, "pause survives the re-key");
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 10);
  db.close();
  rmSync(path, { force: true });
});

test("migrate v5: keeps legacy control rows and chooses a paused row for global control", () => {
  const path = tempDbPath();
  const db4 = openDb(path);
  db4.exec(`DELETE FROM control;
    INSERT INTO control (wallet, paused, paused_at, reason) VALUES ('wallet-a', 0, '2026-09-20T00:00:00Z', 'running');
    INSERT INTO control (wallet, paused, paused_at, reason) VALUES ('wallet-b', 1, '2026-09-19T00:00:00Z', 'paused');
    PRAGMA user_version = 4;
    DROP TABLE run_shares;
    DROP TABLE strategies;`);
  // Recreate the v4 manual_runs shape before reopening.
  db4.exec(`CREATE TABLE manual_runs_v4 AS SELECT id, created_at, wallet, date, status, nonce, tx_hash,
      block_number, confirmed_at, amount_in, amount_out, recipient, effective_price, minimum_amount,
      price_impact_pct, oracle_btc_usd, oracle_usdt_usd, oracle_pol_usd, oracle_deviation_pct,
      gas_used, gas_cost_pol, gas_cost_usd, routing, route_string, request_id, quote_id, error, deadline
      FROM manual_runs;
    DROP TABLE manual_runs;
    ALTER TABLE manual_runs_v4 RENAME TO manual_runs;`);
  db4.close();
  const db = openDb(path);
  assert.equal(getControl(db)?.reason, "paused");
  assert.equal(isPaused(db, "2026-09-24T00:00:00Z"), true);
  assert.deepEqual(
    (db.prepare("SELECT wallet FROM control WHERE wallet <> '*' ORDER BY wallet").all() as { wallet: string }[]).map((r) => r.wallet),
    ["wallet-a", "wallet-b"]
  );
  db.close();
  rmSync(path, { force: true });
});

test("migrate v5: failure rolls back schema changes and leaves v4 restartable", () => {
  const path = tempDbPath();
  const db5 = openDb(path);
  db5.exec(`DROP TABLE run_shares;
    DROP TABLE strategies;
    CREATE TABLE manual_runs_v4 AS SELECT id, created_at, wallet, date, status, nonce, tx_hash,
      block_number, confirmed_at, amount_in, amount_out, recipient, effective_price, minimum_amount,
      price_impact_pct, oracle_btc_usd, oracle_usdt_usd, oracle_pol_usd, oracle_deviation_pct,
      gas_used, gas_cost_pol, gas_cost_usd, routing, route_string, request_id, quote_id, error, deadline
      FROM manual_runs;
    DROP TABLE manual_runs;
    ALTER TABLE manual_runs_v4 RENAME TO manual_runs;
    INSERT INTO control (wallet, paused) VALUES ('old-wallet', 1);
    CREATE TRIGGER fail_global_control BEFORE INSERT ON control
      WHEN NEW.wallet = '*' BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END;
    PRAGMA user_version = 4;`);
  db5.close();

  assert.throws(() => openDb(path), /injected migration failure/);
  const raw = new DatabaseSync(path);
  assert.equal((raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 4);
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'strategies'").get() as { n: number }).n, 0);
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('manual_runs') WHERE name = 'strategy_id'").get() as { n: number }).n, 0);
  raw.exec("DROP TRIGGER fail_global_control");
  raw.close();

  const recovered = openDb(path);
  assert.equal((recovered.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 10);
  assert.equal(getControl(recovered)?.paused, true);
  recovered.close();
  rmSync(path, { force: true });
});

test("sessions: a new token is valid for exactly SESSION_TTL_MS, fixed expiry, then gone", () => {
  const db = openDb(":memory:");
  const { token, expiresAt } = createSession(db, 1_000);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(expiresAt, 1_000 + SESSION_TTL_MS);
  assert.equal(SESSION_TTL_MS, 30 * 24 * 60 * 60 * 1000);
  assert.equal(sessionExpiresAt(db, token, 1_000 + SESSION_TTL_MS - 1), expiresAt, "checking does not extend it");
  assert.equal(sessionExpiresAt(db, token, 1_000 + SESSION_TTL_MS), null);
  assert.equal(sessionExpiresAt(db, token, 1_000), null, "expired row is deleted, not revived");
  db.close();
});

test("sessions: only a hash of the token is stored; unknown/missing tokens are rejected", () => {
  const db = openDb(":memory:");
  const { token } = createSession(db, 0);
  const rows = db.prepare("SELECT * FROM sessions").all() as Record<string, unknown>[];
  assert.equal(rows.length, 1);
  assert.ok(!JSON.stringify(rows).includes(token), "raw token never lands in the database");
  assert.equal(sessionExpiresAt(db, undefined, 0), null);
  assert.equal(sessionExpiresAt(db, "", 0), null);
  assert.equal(sessionExpiresAt(db, token + "x", 0), null);
  db.close();
});

test("sessions: logout revokes one device, logout everywhere revokes all; creating prunes expired rows", () => {
  const db = openDb(":memory:");
  const a = createSession(db, 0).token;
  const b = createSession(db, 0).token;
  deleteSession(db, a);
  assert.equal(sessionExpiresAt(db, a, 1), null);
  assert.notEqual(sessionExpiresAt(db, b, 1), null);
  deleteAllSessions(db);
  assert.equal(sessionExpiresAt(db, b, 1), null);
  createSession(db, 0);
  createSession(db, SESSION_TTL_MS + 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n, 1);
  db.close();
});

test("sessions survive reopening the file (a redeploy doesn't log out)", () => {
  const path = tempDbPath();
  try {
    const db = openDb(path);
    const { token, expiresAt } = createSession(db, 0);
    db.close();
    const again = openDb(path);
    assert.equal(sessionExpiresAt(again, token, 1), expiresAt);
    again.close();
  } finally {
    rmSync(path, { force: true });
  }
});

test("recentGasCostsPol: newest confirmed scheduled runs first, only those with a recorded cost, capped", () => {
  const db = openDb(":memory:");
  for (const [date, status, gas] of [["2026-09-20", "CONFIRMED", "0.1"], ["2026-09-21", "FAILED", "0.2"], ["2026-09-22", "CONFIRMED", null], ["2026-09-23", "CONFIRMED", "0.3"], ["2026-09-24", "CONFIRMED", "0.4"]] as const) {
    claimDay(db, WALLET, date);
    updateRun(db, WALLET, date, { status, gasCostPol: gas });
  }
  assert.deepEqual(recentGasCostsPol(db, 2), ["0.4", "0.3"]);
  assert.deepEqual(recentGasCostsPol(db, 10), ["0.4", "0.3", "0.1"]);
  db.close();
});

test("settings: absent on a fresh db; save then read back; save again overwrites the single row", () => {
  const db = openDb(":memory:");
  assert.equal(getSettings(db), undefined);
  const s = { runTime: "00:00", maxSlippagePct: 0.5, maxPriceImpactPct: 1, maxOracleDeviationPct: 2, approvalDays: 30, minPolBalance: 0.5 };
  saveSettings(db, s, "2026-09-24T00:00:00Z");
  assert.deepEqual(getSettings(db), s);
  saveSettings(db, { ...s, runTime: "09:15" }, "2026-09-24T01:00:00Z");
  assert.equal(getSettings(db)!.runTime, "09:15");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM settings").get() as { n: number }).n, 1);
  db.close();
});

test("report mode (F9): \"all\" by default, survives reopen, switches between all / errors / off", () => {
  const dir = mkdtempSync(join(tmpdir(), "dca-report-"));
  const file = join(dir, "t.db");
  const db = openDb(file);
  assert.equal(getReportMode(db), "all", "no row = all (existing installs keep reports)");
  setReportMode(db, "errors");
  db.close();
  const again = openDb(file);
  assert.equal(getReportMode(again), "errors", "choice survives a restart");
  setReportMode(again, "off");
  assert.equal(getReportMode(again), "off");
  assert.throws(() => setReportMode(again, "sometimes" as never), "the table refuses unknown modes");
  again.close();
  rmSync(dir, { recursive: true });
});

test("migrate v7 -> v8 (F9): existing database starts with every report", () => {
  const dir = mkdtempSync(join(tmpdir(), "dca-report-mig-"));
  const file = join(dir, "t.db");
  openDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec("DROP TABLE report_pref; PRAGMA user_version = 7;");
  raw.close();
  const db = openDb(file);
  assert.equal(getReportMode(db), "all");
  db.close();
  rmSync(dir, { recursive: true });
});

test("low-funds alert days: 2 by default, survives reopen, 0..30 only, independent of report mode", () => {
  const dir = mkdtempSync(join(tmpdir(), "dca-alert-"));
  const file = join(dir, "t.db");
  const db = openDb(file);
  assert.equal(getAlertDays(db), 2, "no row = 2 days");
  setAlertDays(db, 5);
  assert.equal(getReportMode(db), "all", "setting days first keeps the default mode");
  setReportMode(db, "off");
  assert.equal(getAlertDays(db), 5, "changing the mode keeps the days");
  db.close();
  const again = openDb(file);
  assert.equal(getAlertDays(again), 5, "survives a restart");
  setAlertDays(again, 0);
  assert.equal(getAlertDays(again), 0);
  assert.throws(() => setAlertDays(again, 31));
  assert.throws(() => setAlertDays(again, -1));
  assert.throws(() => setAlertDays(again, 1.5));
  again.close();
  rmSync(dir, { recursive: true });
});

test("migrate v9 -> v10: an existing report_pref row gets 2 alert days", () => {
  const dir = mkdtempSync(join(tmpdir(), "dca-alert-mig-"));
  const file = join(dir, "t.db");
  openDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec("DROP TABLE report_pref; CREATE TABLE report_pref (id INTEGER PRIMARY KEY CHECK (id = 1), mode TEXT NOT NULL CHECK (mode IN ('all','errors','off'))); INSERT INTO report_pref VALUES (1, 'errors'); PRAGMA user_version = 9;");
  raw.close();
  const db = openDb(file);
  assert.equal(getReportMode(db), "errors");
  assert.equal(getAlertDays(db), 2);
  db.close();
  rmSync(dir, { recursive: true });
});

test("migrate v8 -> v9: stopped strategies become completed", () => {
  const dir = mkdtempSync(join(tmpdir(), "dca-stopped-mig-"));
  const file = join(dir, "t.db");
  const first = openDb(file);
  const [a, b] = withStrategies(first, "10", "5");
  first.close();
  const raw = new DatabaseSync(file);
  raw.exec(`UPDATE strategies SET status = 'stopped', stopped_at = '2026-09-25T10:00:00.000Z' WHERE id = ${a};
            UPDATE strategies SET status = 'paused' WHERE id = ${b}; PRAGMA user_version = 8;`);
  raw.close();
  const db = openDb(file);
  assert.equal(getStrategy(db, a!)!.status, "completed");
  assert.equal(getStrategy(db, a!)!.stoppedAt, "2026-09-25T10:00:00.000Z", "end time kept");
  assert.equal(getStrategy(db, b!)!.status, "paused", "other statuses untouched");
  db.close();
  rmSync(dir, { recursive: true });
});
