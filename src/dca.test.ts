import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createStrategy, getSecret, listStrategies, openDb, saveSettings } from "./db.js";
import { storePrivateKey } from "./setup.js";

const script = fileURLToPath(new URL("./dca.ts", import.meta.url));

function runCli(dbFile: string, args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", script, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 5_000,
    env: {
      PRIVATE_KEY: `0x${"1".repeat(64)}`, // public throwaway test key
      MASTER_KEY: Buffer.alloc(32, 7).toString("base64"), // public throwaway test master key
      UNISWAP_API_KEY: "test-only",
      RPC_URL: "http://127.0.0.1:1", // no listener; a network call would fail
      RPC_URL_FALLBACK: "",
      APP_PASSWORD: "test-only-password",
      DCA_AMOUNT: "200",
      MAX_SLIPPAGE_PCT: "0.5",
      MAX_PRICE_IMPACT_PCT: "1.0",
      MAX_ORACLE_DEVIATION_PCT: "2.0",
      APPROVAL_DAYS: "30",
      MIN_POL_BALANCE: "0.5",
      TOKEN_IN: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
      TOKEN_IN_SYMBOL: "USDT0",
      TOKEN_OUT: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6",
      TOKEN_OUT_SYMBOL: "WBTC",
      DB_FILE: dbFile,
      APP_PORT: "8787",
    },
  });
}

test("manual buy: over-cap active total fails before creating a PENDING reservation", () => {
  const dir = mkdtempSync(join(tmpdir(), "dca-manual-preflight-"));
  const path = join(dir, "dca.db");
  try {
    const db = openDb(path);
    createStrategy(db, { label: "one", amount: "600", endDate: null, createdAt: new Date().toISOString() });
    createStrategy(db, { label: "two", amount: "500", endDate: null, createdAt: new Date().toISOString() });
    db.close();

    const result = runCli(path, ["--manual", "--strategy", "1"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /above the per-run cap/);
    const reopened = openDb(path);
    const count = reopened.prepare("SELECT COUNT(*) AS n FROM manual_runs").get() as { n: number };
    assert.equal(count.n, 0);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scheduled dry-run: DCA_AMOUNT does not seed a strategy", () => {
  const dir = mkdtempSync(join(tmpdir(), "dca-dry-run-"));
  const path = join(dir, "dca.db");
  try {
    const result = runCli(path, ["--dry-run"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /no active strategy -- the real run would buy nothing/);
    const db = openDb(path);
    assert.deepEqual(listStrategies(db), []);
    const count = db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number };
    assert.equal(count.n, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM secrets").get() as { n: number }).n, 0);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("not-due scheduled tick seeds settings and strategy without decrypting a stored key", (t) => {
  const now = new Date();
  const futureMinute = Math.ceil((now.getUTCHours() * 60 + now.getUTCMinutes() + 2) / 15) * 15;
  if (futureMinute >= 24 * 60) return t.skip("no future quarter-hour remains in UTC today");
  const runTime = `${String(Math.floor(futureMinute / 60)).padStart(2, "0")}:${String(futureMinute % 60).padStart(2, "0")}`;
  const dir = mkdtempSync(join(tmpdir(), "dca-not-due-key-"));
  const path = join(dir, "dca.db");
  try {
    const db = openDb(path);
    saveSettings(db, {
      runTime,
      maxSlippagePct: 0.5,
      maxPriceImpactPct: 1,
      maxOracleDeviationPct: 2,
      approvalDays: 30,
      minPolBalance: 0.5,
    }, now.toISOString());
    storePrivateKey(db, Buffer.alloc(32, 8), `0x${"2".repeat(64)}`); // different master key from runCli
    const stored = getSecret(db, "private_key")!;
    db.close();

    const result = runCli(path, []); // env also contains a legacy PRIVATE_KEY
    assert.equal(result.status, 0, result.stderr);
    const reopened = openDb(path);
    assert.equal(listStrategies(reopened).length, 1);
    assert.deepEqual(getSecret(reopened, "private_key"), stored);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manual buy: --amount is refused -- the strategy's own amount is the only one (F8)", () => {
  const dir = mkdtempSync(join(tmpdir(), "dca-manual-amount-"));
  const path = join(dir, "dca.db");
  try {
    const db = openDb(path);
    createStrategy(db, { label: "one", amount: "10", endDate: null, createdAt: new Date().toISOString() });
    db.close();
    const result = runCli(path, ["--manual", "--strategy", "1", "--amount", "20"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--amount is gone/);
    const reopened = openDb(path);
    assert.equal((reopened.prepare("SELECT COUNT(*) AS n FROM manual_runs").get() as { n: number }).n, 0);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
