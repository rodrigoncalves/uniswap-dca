import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import { openDb, listStrategies, createStrategy, getSettings, putSecret, getSecret, claimDay, insertManualRun, countInFlight } from "./db.js";
import { seedFromEnv, loadSettings, setupIssues, SetupError, loadPrivateKey, storePrivateKey, assertNoPurchaseInFlight } from "./setup.js";
import { ValidationError, parsePrivateKey } from "./validation.js";
import { randomBytes } from "node:crypto";
import { encryptSecret } from "./crypto.js";

const NOW = "2026-09-24T00:00:05.000Z";
const MK = randomBytes(32);
const KEY1 = "0x" + "11".repeat(32);
const KEY2 = "0x" + "22".repeat(32);

test("seedFromEnv: empty db + DCA_AMOUNT -> strategy #1, no label, active", () => {
  const db = openDb(":memory:");
  seedFromEnv(db, { DCA_AMOUNT: "10" }, NOW, null);
  assert.deepEqual(listStrategies(db), [{ id: 1, label: null, amount: "10", status: "active", endDate: null, maxTotal: null, createdAt: NOW, stoppedAt: null }]);
  db.close();
});

test("seedFromEnv: runs once -- existing strategies are never touched", () => {
  const db = openDb(":memory:");
  createStrategy(db, { label: "mine", amount: "3", endDate: null, createdAt: NOW });
  seedFromEnv(db, { DCA_AMOUNT: "10" }, NOW, null);
  assert.deepEqual(listStrategies(db).map((s) => s.amount), ["3"]);
  db.close();
});

test("seedFromEnv: concurrent processes seed strategy #1 once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dca-seed-test-"));
  const path = join(dir, "test.db");
  const worker = join(import.meta.dirname, "db-claim-worker.ts");
  try {
    await Promise.all(Array.from({ length: 8 }, () => new Promise<void>((resolve, reject) => {
      const child = fork(worker, [path, "--seed-only"], { execArgv: ["--import", "tsx"], silent: true });
      let stderr = "";
      child.stderr?.on("data", (chunk) => (stderr += chunk));
      child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`seed worker exited ${code}: ${stderr}`)));
      child.on("error", reject);
    })));
    const db = openDb(path);
    assert.deepEqual(listStrategies(db).map((s) => [s.id, s.amount]), [[1, "10"]]);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("seedFromEnv: no DCA_AMOUNT -> nothing (fresh deploy, set up in the app)", () => {
  const db = openDb(":memory:");
  seedFromEnv(db, {}, NOW, null);
  assert.equal(listStrategies(db).length, 0);
  db.close();
});

test("seedFromEnv: invalid DCA_AMOUNT refuses (no buy), creates nothing", () => {
  const db = openDb(":memory:");
  assert.throws(() => seedFromEnv(db, { DCA_AMOUNT: "2e2" }, NOW, null), ValidationError);
  assert.throws(() => seedFromEnv(db, { DCA_AMOUNT: "5000" }, NOW, null), ValidationError);
  assert.equal(listStrategies(db).length, 0);
  db.close();
});


const LEGACY = { MAX_SLIPPAGE_PCT: "0.5", MAX_PRICE_IMPACT_PCT: "1.0", MAX_ORACLE_DEVIATION_PCT: "2.0", APPROVAL_DAYS: "30", MIN_POL_BALANCE: "0.5" };

test("seedFromEnv: all five legacy vars -> settings row, run time 00:00", () => {
  const db = openDb(":memory:");
  seedFromEnv(db, LEGACY, NOW, null);
  assert.deepEqual(getSettings(db), { runTime: "00:00", maxSlippagePct: 0.5, maxPriceImpactPct: 1, maxOracleDeviationPct: 2, approvalDays: 30, minPolBalance: 0.5 });
  db.close();
});

test("seedFromEnv: settings are never overwritten by env once they exist", () => {
  const db = openDb(":memory:");
  seedFromEnv(db, LEGACY, NOW, null);
  seedFromEnv(db, { ...LEGACY, MAX_SLIPPAGE_PCT: "1.5" }, NOW, null);
  assert.equal(getSettings(db)!.maxSlippagePct, 0.5);
  db.close();
});

test("seedFromEnv: partial legacy env refuses, naming what's missing", () => {
  const db = openDb(":memory:");
  assert.throws(() => seedFromEnv(db, { MAX_SLIPPAGE_PCT: "0.5" }, NOW, null), /APPROVAL_DAYS/);
  assert.equal(getSettings(db), undefined);
  db.close();
});

test("seedFromEnv: legacy value above the new cap refuses (no buy)", () => {
  const db = openDb(":memory:");
  assert.throws(() => seedFromEnv(db, { ...LEGACY, MAX_SLIPPAGE_PCT: "10" }, NOW, null), /maxSlippagePct/);
  assert.equal(getSettings(db), undefined);
  db.close();
});

test("seedFromEnv: a non-empty OUTPUT_RECIPIENT refuses; empty is fine", () => {
  const db = openDb(":memory:");
  assert.throws(() => seedFromEnv(db, { ...LEGACY, OUTPUT_RECIPIENT: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6" }, NOW, null), /OUTPUT_RECIPIENT/);
  assert.doesNotThrow(() => seedFromEnv(db, { ...LEGACY, OUTPUT_RECIPIENT: "" }, NOW, null));
  db.close();
});

test("loadSettings: SetupError when absent; the stored row is re-validated", () => {
  const db = openDb(":memory:");
  assert.throws(() => loadSettings(db), SetupError);
  seedFromEnv(db, LEGACY, NOW, null);
  assert.equal(loadSettings(db).approvalDays, 30);
  db.exec("UPDATE settings SET max_slippage_pct = 40");
  assert.throws(() => loadSettings(db), /maxSlippagePct/);
  db.close();
});

test("seedFromEnv: PRIVATE_KEY is stored encrypted once; loadPrivateKey returns it", () => {
  const db = openDb(":memory:");
  seedFromEnv(db, { PRIVATE_KEY: KEY1 }, NOW, MK);
  const blob = getSecret(db, "private_key")!;
  assert.ok(!blob.includes("1111"), "stored encrypted");
  assert.equal(loadPrivateKey(db, MK), KEY1);
  db.close();
});

test("seedFromEnv: a stored key wins over a different PRIVATE_KEY in env", () => {
  const db = openDb(":memory:");
  storePrivateKey(db, MK, KEY2 as `0x${string}`);
  seedFromEnv(db, { PRIVATE_KEY: KEY1 }, NOW, MK);
  assert.equal(loadPrivateKey(db, MK), KEY2);
  db.close();
});

test("seedFromEnv: a concurrent seed waits, then preserves the key stored by the winner", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dca-seed-key-test-"));
  const dbPath = join(dir, "test.db");
  const worker = join(dir, "seed-key-worker.ts");
  writeFileSync(worker, `
    import { openDb } from ${JSON.stringify(join(import.meta.dirname, "db.js"))};
    import { seedFromEnv } from ${JSON.stringify(join(import.meta.dirname, "setup.js"))};
    process.stdout.write("ready\\n");
    const db = openDb(process.argv[2]);
    seedFromEnv(db, { PRIVATE_KEY: process.argv[3] }, "${NOW}", Buffer.from(process.argv[4], "hex"));
    db.close();
  `);
  const db = openDb(dbPath);
  db.exec("BEGIN IMMEDIATE");
  try {
    const child = fork(worker, [dbPath, KEY2, MK.toString("hex")], { execArgv: ["--import", "tsx"], silent: true });
    let output = "";
    const ready = new Promise<void>((resolve, reject) => {
      child.stdout?.on("data", (chunk) => {
        output += chunk;
        if (output.includes("ready")) resolve();
      });
      child.on("error", reject);
      child.stderr?.on("data", (chunk) => (output += chunk));
      setTimeout(() => reject(new Error(`seed worker did not start: ${output}`)), 5000).unref();
    });
    const exited = new Promise<number>((resolve, reject) => {
      child.on("close", (code) => code === 0 ? resolve(code) : reject(new Error(`seed worker exited ${code}: ${output}`)));
      child.on("error", reject);
    });
    await ready;
    putSecret(db, "private_key", encryptSecret(MK, "private_key", KEY1));
    db.exec("COMMIT");
    await exited;
    assert.equal(loadPrivateKey(db, MK), KEY1);
  } finally {
    if (db.isTransaction) db.exec("ROLLBACK");
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("seedFromEnv: PRIVATE_KEY without a master key refuses; invalid PRIVATE_KEY refuses", () => {
  const db = openDb(":memory:");
  assert.throws(() => seedFromEnv(db, { PRIVATE_KEY: KEY1 }, NOW, null), /MASTER_KEY/);
  assert.throws(() => seedFromEnv(db, { PRIVATE_KEY: "0x123" }, NOW, MK), /privateKey/);
  assert.equal(getSecret(db, "private_key"), undefined);
  db.close();
});

test("seedFromEnv: initial key accepts matching scheduled and manual in-flight rows and preserves them", () => {
  const wallet = parsePrivateKey(KEY1).address;
  for (const kind of ["scheduled", "manual"] as const) {
    const db = openDb(":memory:");
    if (kind === "scheduled") claimDay(db, wallet, "2026-09-24");
    else insertManualRun(db, wallet, "2026-09-24", "2026-09-24T01:00:00Z", 1);
    assert.equal(countInFlight(db), 1);
    seedFromEnv(db, { PRIVATE_KEY: KEY1 }, NOW, MK);
    assert.equal(loadPrivateKey(db, MK), KEY1);
    assert.equal(countInFlight(db), 1);
    const table = kind === "scheduled" ? "runs" : "manual_runs";
    assert.equal((db.prepare(`SELECT status FROM ${table}`).get() as { status: string }).status, "PENDING");
    db.close();
  }
});

test("seedFromEnv: initial key refuses in-flight rows for a different wallet and leaves them intact", () => {
  const db = openDb(":memory:");
  claimDay(db, "0x000000000000000000000000000000000000000A", "2026-09-24");
  assert.throws(() => seedFromEnv(db, { PRIVATE_KEY: KEY1 }, NOW, MK), /different wallet/);
  assert.equal(getSecret(db, "private_key"), undefined);
  assert.equal(countInFlight(db), 1);
  assert.equal((db.prepare("SELECT status FROM runs").get() as { status: string }).status, "PENDING");
  db.close();
});

test("loadPrivateKey: none stored -> SetupError; wrong master key -> refuses", () => {
  const db = openDb(":memory:");
  assert.throws(() => loadPrivateKey(db, MK), SetupError);
  storePrivateKey(db, MK, KEY1 as `0x${string}`);
  assert.throws(() => loadPrivateKey(db, randomBytes(32)), /MASTER_KEY/);
  db.close();
});

test("assertNoPurchaseInFlight: refuses while a run is PENDING/BROADCAST", () => {
  const db = openDb(":memory:");
  assert.doesNotThrow(() => assertNoPurchaseInFlight(db));
  claimDay(db, "0x000000000000000000000000000000000000000A", "2026-09-24");
  assert.throws(() => assertNoPurchaseInFlight(db), /in progress/);
  db.close();
});

test("storePrivateKey: refuses replacement while a purchase is in flight and preserves the stored key", () => {
  const db = openDb(":memory:");
  storePrivateKey(db, MK, KEY1 as `0x${string}`);
  claimDay(db, parsePrivateKey(KEY1).address, "2026-09-24");
  assert.throws(() => storePrivateKey(db, MK, KEY2 as `0x${string}`), /in progress/);
  assert.equal(loadPrivateKey(db, MK), KEY1);
  db.close();
});

test("setupIssues: 'no private key' until one is stored", () => {
  const db = openDb(":memory:");
  assert.ok(setupIssues(db).includes("no private key"));
  storePrivateKey(db, MK, KEY1 as `0x${string}`);
  assert.ok(!setupIssues(db).includes("no private key"));
  db.close();
});

test("setupIssues: lists what's missing, empty when ready", () => {
  const db = openDb(":memory:");
  assert.deepEqual(setupIssues(db), ["settings not configured", "no active strategy", "authenticator not set up", "no private key"]);
  seedFromEnv(db, { ...LEGACY, DCA_AMOUNT: "10" }, NOW, null);
  putSecret(db, "totp_secret", "x");
  storePrivateKey(db, MK, KEY1 as `0x${string}`);
  assert.deepEqual(setupIssues(db), []);
  db.close();
});
