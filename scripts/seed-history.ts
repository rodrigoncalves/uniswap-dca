// Generates ~60 days of synthetic history to develop and check the app
// before any real purchase exists. Only needs APP_PASSWORD/APP_PORT/
// DB_FILE (loadAppConfig). Uses a synthetic wallet address; runs the
// same code path the real bot would use (claimScheduledRun + updateRun from db.ts),
// not raw inserts.
import { loadAppConfig } from "../src/config.js";
import { openDb, claimScheduledRun, createStrategy, listStrategies, setShareResults, updateRun } from "../src/db.js";
import { splitShares } from "../src/validation.js";

const DAYS = 60;
const BASE_BTC_PRICE = 86_000;
const SEED_WALLET = "0x000000000000000000000000000000000000dEaD"; // synthetic history, dev only

function toUtcDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function randomHex(bytes: number): string {
  let s = "0x";
  for (let i = 0; i < bytes * 2; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

function main(): void {
  const config = loadAppConfig();
  const db = openDb(config.dbFile);
  if (listStrategies(db).length === 0) createStrategy(db, {
    label: "seed", amount: "200", endDate: null, createdAt: new Date().toISOString(),
  });

  // price random walk, bounded enough not to produce absurd numbers, but
  // varying day to day -- doesn't need to be byte-for-byte reproducible,
  // it's a dev script, not a test.
  let price = BASE_BTC_PRICE;
  let blockNumber = 64_000_000;

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  // Deliberately picks a failed day, a skipped one and a paused one in the
  // middle of the window (not the first or last day, so the app shows the
  // three cases surrounded by normal days).
  const failedDayIndex = 45;
  const skippedDayIndex = 30;
  const pausedDayIndex = 15;

  let confirmedCount = 0;

  for (let i = DAYS - 1; i >= 0; i--) {
    const date = new Date(today);
    date.setUTCDate(date.getUTCDate() - i);
    const dateStr = toUtcDateString(date);

    if (i === skippedDayIndex) {
      continue; // real gap: no row for this day
    }

    const claim = claimScheduledRun(db, SEED_WALLET, dateStr, `${dateStr}T00:00:00.000Z`, 6);
    if (claim.kind !== "claimed") continue;
    const amountIn = claim.shares.reduce((sum, share) => sum + BigInt(share.amountIn), 0n);
    const amountInHuman = Number(amountIn) / 1e6;

    if (i === failedDayIndex) {
      updateRun(db, SEED_WALLET, dateStr, {
        status: "FAILED",
        error: "slippage above the cap (0.62% > 0.50%) -- quote discarded before signing",
      });
      continue;
    }

    if (i === pausedDayIndex) {
      updateRun(db, SEED_WALLET, dateStr, {
        status: "PAUSED",
        error: "paused by the user (traveling)",
      });
      continue;
    }

    // random walk: +-1.5% per day
    price = price * (1 + (Math.random() - 0.5) * 0.03);
    const oracleBtcUsd = price * (1 + (Math.random() - 0.5) * 0.001);
    const oracleUsdtUsd = 1 + (Math.random() - 0.5) * 0.0006;
    const oraclePolUsd = 0.11 * (1 + (Math.random() - 0.5) * 0.05);

    const amountOutHuman = amountInHuman / price;
    const amountOutBaseUnits = BigInt(Math.round(amountOutHuman * 1e8));
    const minimumAmount = BigInt(Math.round(Number(amountOutBaseUnits) * 0.995));

    const impliedPrice = amountInHuman / (Number(amountOutBaseUnits) / 1e8);
    const oraclePrice = oracleBtcUsd / oracleUsdtUsd;
    const deviationPct = (Math.abs(impliedPrice - oraclePrice) / oraclePrice) * 100;

    const gasUsed = 280_000 + Math.floor(Math.random() * 40_000);
    const gasPriceGwei = 30 + Math.random() * 50;
    const gasCostPol = (gasUsed * gasPriceGwei) / 1e9;
    const gasCostUsd = gasCostPol * oraclePolUsd;

    blockNumber += 40_000 + Math.floor(Math.random() * 5_000);

    updateRun(db, SEED_WALLET, dateStr, {
      status: "CONFIRMED",
      txHash: randomHex(32),
      blockNumber: String(blockNumber),
      confirmedAt: `${dateStr}T12:00:${String(Math.floor(Math.random() * 60)).padStart(2, "0")}Z`,
      amountIn: amountIn.toString(),
      amountOut: amountOutBaseUnits.toString(),
      recipient: SEED_WALLET,
      effectivePrice: impliedPrice.toFixed(2),
      minimumAmount: minimumAmount.toString(),
      priceImpactPct: (0.01 + Math.random() * 0.04).toFixed(3),
      oracleBtcUsd: oracleBtcUsd.toFixed(2),
      oracleUsdtUsd: oracleUsdtUsd.toFixed(6),
      oraclePolUsd: oraclePolUsd.toFixed(6),
      oracleDeviationPct: deviationPct.toFixed(3),
      gasUsed: String(gasUsed),
      gasCostPol: gasCostPol.toFixed(6),
      gasCostUsd: gasCostUsd.toFixed(4),
      routing: "CLASSIC",
      routeString: "[V4] 100.00% USDT0 -- 0.05% --> WBTC",
      requestId: randomHex(8),
      quoteId: randomHex(8),
    });
    setShareResults(db, SEED_WALLET, dateStr, splitShares(
      amountOutBaseUnits, gasCostPol.toFixed(6), gasCostUsd.toFixed(4),
      claim.shares.map((share) => ({ strategyId: share.strategyId, amountIn: BigInt(share.amountIn) }))
    ));
    confirmedCount++;
  }

  db.close();
  console.log(
    `Seed done in ${config.dbFile}: ${confirmedCount} confirmed, 1 failed (day ${failedDayIndex}), 1 paused (day ${pausedDayIndex}), 1 skipped -- no row (day ${skippedDayIndex}).`
  );
}

main();
