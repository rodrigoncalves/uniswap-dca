// Orchestrates the daily flow. Two fundamentally different executions:
//
// --dry-run: read-only, end to end. Does NOT claim the day or
// updateRun() -- if it consumed the day, a test dry-run would block the
// real purchase for that same day. Runs quote -> validate -> signs the
// permit for real (costs nothing, commits to nothing) -> /swap -> validates
// the tx -> simulates (approve + swap) and checks the WBTC at the
// destination, then stops.
//
// without --dry-run: real execution.
//   1. recovery of previous days (pending BROADCAST, orphan PENDING)
//   2. claimScheduledRun() -- the idempotency lock and strategy shares
//   3. paused -> PAUSED, exit
//   4. verified flow, approve if needed, sign the swap, record
//      BROADCAST with nonce and hash, ONLY THEN broadcast (README.md invariant #4)
//   5. recovery of our own broadcast: wait for receipt, check the WBTC
//      Transfer in the receipt, CONFIRMED/FAILED
//
// Scheduled runs sum active strategies into one swap and split the result.
// Coolify's cron ticks every 15 min; a scheduled run exits silently before
// settings.runTime (UTC) and once today's run is final (DECISIONS.md #23).
// --manual --strategy <id>: an extra purchase of the strategy's own amount on
// top of the daily one (buying a dip; F8, DECISIONS.md #24). Same flow, same validation, same BROADCAST-before-send; recorded in
// manual_runs with its own id instead of claiming the day. Refused while
// paused. DECISIONS.md #17.

import type { DatabaseSync } from "node:sqlite";
import { formatUnits as toHuman } from "viem"; // trims trailing zeros, for messages only
import { loadConfig, loadMasterKey, type Config } from "./config.js";
import {
  openDb, getRun, updateRun, isPaused, listRuns, setPaused, updateManualRun, listManualRuns, listAllRuns,
  claimScheduledRun, claimManualRun, confirmScheduledRun, listRunShares, getStrategy, activeAmounts, completeReachedStrategies, manualBuyUnits,
  getSettings, getSecret, getReportMode, getAlertDays, recentGasCostsPol, type Run, type RunPatch,
} from "./db.js";
import { seedSettingsAndStrategyFromEnv, seedPrivateKeyFromEnv, loadSettings, loadPrivateKey, assertPrivateKeyUnchanged, settingsFromEnv, SetupError } from "./setup.js";
import {
  createRpcClient,
  getAccount,
  getChainId,
  getNativeBalance,
  getErc20Balance,
  getErc20Allowance,
  getTokenMeta,
  getChainlinkPrice,
  buildApproveTx,
  simulate,
  getNonce,
  signTx,
  sendRaw,
  getReceipt,
  waitReceipt,
  type CallTx,
} from "./wallet.js";
import { getQuote, buildSwap, type QuoteResponse, type CreateSwapResponse } from "./uniswap.js";
import {
  assertQuote,
  assertPermit,
  assertSwapTx,
  assertApprovalTx,
  assertOutputTransfer,
  toBaseUnits,
  derivePrimaryType,
  assertOraclePriceWithinDeviation,
  computeImpliedPricePerBtc,
  needsApproval,
  approvalCapFor,
  splitShares,
  assertRunTotal,
  formatUnits,
  AMOUNT_DECIMALS,
  isDue,
  type Settings,
  decideRecovery,
  MAX_PERMIT_TTL_SECONDS,
  MAX_ALLOWANCE_EXPIRATION_SECONDS,
  MAX_ORACLE_AGE_SECONDS,
  MAX_GAS_LIMIT,
  MAX_SWAP_DEADLINE_SECONDS,
  RECOVERY_GRACE_SECONDS,
  type ReceiptLog,
  parsePrivateKey,
} from "./validation.js";
import { UNIVERSAL_ROUTERS, CHAINLINK_FEEDS, PERMIT2_ADDRESS } from "./tokens.js";
import { logger, registerSecret } from "./logger.js";
import { buildReport, buildFundsAlert, sendReport } from "./report.js";
import { balanceHealth, averageGasWei, fundsAlert, GAS_SAMPLE_RUNS } from "./health.js";

type Client = ReturnType<typeof createRpcClient>;
type Account = ReturnType<typeof getAccount>;

const DRY_RUN = process.argv.includes("--dry-run");
const MANUAL = process.argv.includes("--manual");
// A manual PENDING older than this was interrupted before broadcasting
// (a live buy reaches BROADCAST in seconds, at most a few minutes with an approve).
const MANUAL_PENDING_STALE_MS = 60 * 60 * 1000;
const POL_DECIMALS = 18;
const APPROVE_RECEIPT_TIMEOUT_MS = 3 * 60 * 1000;
const NONCE_CONSUMED_RECHECK_MS = 30 * 1000;

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** `--name value` or `--name=value`. */
function argValue(name: string): string | undefined {
  const args = process.argv;
  const eq = args.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Today's total of strategies that would buy, for the approve cap. */
function dailyAmountFor(db: DatabaseSync, today: string, amount: string): string {
  const amounts = activeAmounts(db, today);
  return amounts.length === 0 ? amount : formatUnits(assertRunTotal(amounts), AMOUNT_DECIMALS);
}

/**
 * Steps shared by dry-run and real execution: config vs on-chain checks,
 * balances, allowance, quote, oracle, permit, /swap, simulation, and every
 * assertion in validation.ts. Does NOT touch db.runs -- the caller decides
 * what to persist. Throws on any failure (fail closed).
 */
async function runVerifiedFlow(config: Config, settings: Settings, client: Client, account: Account, amount: string, dailyAmount: string) {
  const chainId = await getChainId(client);
  if (chainId !== 137) throw new Error(`unexpected chainId: ${chainId} (expected 137)`);

  const [tokenInMeta, tokenOutMeta] = await Promise.all([
    getTokenMeta(client, config.tokenIn),
    getTokenMeta(client, config.tokenOut),
  ]);
  if (tokenInMeta.symbol !== config.tokenInSymbol) {
    throw new Error(`TOKEN_IN symbol mismatch: expected ${config.tokenInSymbol}, got ${tokenInMeta.symbol}`);
  }
  if (tokenOutMeta.symbol !== config.tokenOutSymbol) {
    throw new Error(`TOKEN_OUT symbol mismatch: expected ${config.tokenOutSymbol}, got ${tokenOutMeta.symbol}`);
  }

  const [polBalance, tokenInBalance, allowance] = await Promise.all([
    getNativeBalance(client, account.address),
    getErc20Balance(client, config.tokenIn, account.address),
    getErc20Allowance(client, config.tokenIn, account.address, PERMIT2_ADDRESS),
  ]);
  const minPolBaseUnits = BigInt(Math.round(settings.minPolBalance * 10 ** POL_DECIMALS));
  if (polBalance < minPolBaseUnits) {
    throw new Error(`insufficient POL balance for gas: ${toHuman(polBalance, POL_DECIMALS)} POL < ${toHuman(minPolBaseUnits, POL_DECIMALS)} POL minimum`);
  }

  const dcaAmountBaseUnits = toBaseUnits(amount, tokenInMeta.decimals);
  if (tokenInBalance < dcaAmountBaseUnits) {
    throw new Error(`insufficient ${config.tokenInSymbol} balance: ${toHuman(tokenInBalance, tokenInMeta.decimals)} < ${toHuman(dcaAmountBaseUnits, tokenInMeta.decimals)} ${config.tokenInSymbol}`);
  }

  // Approve Permit2 with a cap (day's total × APPROVAL_DAYS, or a larger
  // manual amount) when the allowance doesn't cover this purchase or exceeds
  // the cap (shrinks unlimited allowance).
  const approvalCap = approvalCapFor(toBaseUnits(dailyAmount, tokenInMeta.decimals), settings.approvalDays, dcaAmountBaseUnits);
  let approval: CallTx | null = null;
  if (needsApproval(allowance, dcaAmountBaseUnits, approvalCap)) {
    approval = buildApproveTx(config.tokenIn, account.address, PERMIT2_ADDRESS, approvalCap);
    assertApprovalTx(approval, {
      chainId: 137,
      fromAddress: account.address,
      tokenAddress: config.tokenIn,
      expectedSpender: PERMIT2_ADDRESS,
      maxAmount: approvalCap,
    });
  }

  // WBTC always stays in the DCA wallet (OUTPUT_RECIPIENT removed, DECISIONS.md #23).
  const recipient = account.address;

  const quoteResponse: QuoteResponse = await getQuote(config.uniswapApiKey, {
    type: "EXACT_INPUT",
    amount: dcaAmountBaseUnits.toString(),
    tokenInChainId: 137,
    tokenOutChainId: 137,
    tokenIn: config.tokenIn,
    tokenOut: config.tokenOut,
    swapper: account.address,
    slippageTolerance: settings.maxSlippagePct,
    routingPreference: "BEST_PRICE",
    permitAmount: "EXACT",
  });

  assertQuote(
    { ...quoteResponse.quote, routing: quoteResponse.routing },
    {
      chainId: 137,
      swapperAddress: account.address,
      tokenIn: config.tokenIn,
      tokenOut: config.tokenOut,
      expectedRecipient: recipient,
      expectedInputAmount: dcaAmountBaseUnits,
      maxSlippagePct: settings.maxSlippagePct,
      maxPriceImpactPct: settings.maxPriceImpactPct,
    }
  );

  const [btcUsd, usdtUsd, polUsd] = await Promise.all([
    getChainlinkPrice(client, CHAINLINK_FEEDS.btcUsd),
    getChainlinkPrice(client, CHAINLINK_FEEDS.usdtUsd),
    getChainlinkPrice(client, CHAINLINK_FEEDS.polUsd),
  ]);
  const now = nowSeconds();
  // minimumAmount (worst case) for the comparison -- if even the worst case
  // matches the oracle, the expected case matches with room to spare.
  const minimumAmount = BigInt(quoteResponse.quote.output.minimumAmount ?? quoteResponse.quote.output.amount);

  const impliedPrice = computeImpliedPricePerBtc({
    amountInBaseUnits: dcaAmountBaseUnits,
    amountOutBaseUnits: minimumAmount,
    decimalsIn: tokenInMeta.decimals,
    decimalsOut: tokenOutMeta.decimals,
  });
  const oraclePrice = btcUsd.price / usdtUsd.price;
  const deviationPct = (Math.abs(impliedPrice - oraclePrice) / oraclePrice) * 100;

  assertOraclePriceWithinDeviation({
    amountInBaseUnits: dcaAmountBaseUnits,
    amountOutBaseUnits: minimumAmount,
    decimalsIn: tokenInMeta.decimals,
    decimalsOut: tokenOutMeta.decimals,
    btcUsd: btcUsd.price,
    usdtUsd: usdtUsd.price,
    maxDeviationPct: settings.maxOracleDeviationPct,
    btcUsdUpdatedAt: btcUsd.updatedAt,
    usdtUsdUpdatedAt: usdtUsd.updatedAt,
    maxOracleAgeSeconds: MAX_ORACLE_AGE_SECONDS,
    nowSeconds: now,
  });

  let signature: `0x${string}` | undefined;
  if (quoteResponse.permitData) {
    assertPermit(quoteResponse.permitData, {
      chainId: 137,
      tokenIn: config.tokenIn,
      expectedAmount: dcaAmountBaseUnits,
      allowedSpenders: UNIVERSAL_ROUTERS,
      maxSignatureTtlSeconds: MAX_PERMIT_TTL_SECONDS,
      maxAllowanceExpirationSeconds: MAX_ALLOWANCE_EXPIRATION_SECONDS,
      nowSeconds: now,
    });

    // The SAME shape priority (details first) used in
    // validation.ts::assertPermit must hold here -- viem's signTypedData
    // uses the `primaryType` we derive, so the real consistency lives in
    // derivePrimaryType, not in a separate choice here.
    const primaryType = derivePrimaryType(quoteResponse.permitData.types);
    signature = await account.signTypedData({
      domain: quoteResponse.permitData.domain as Record<string, unknown>,
      types: quoteResponse.permitData.types,
      primaryType,
      message: quoteResponse.permitData.values,
    });
  }

  const swapResponse: CreateSwapResponse = await buildSwap(config.uniswapApiKey, {
    quote: quoteResponse.quote,
    ...(signature ? { signature, permitData: quoteResponse.permitData! } : {}),
    safetyMode: "SAFE",
  });

  // The API ignores `deadline` on /swap -- the bound comes from the calldata, read here.
  const deadline = assertSwapTx(swapResponse.swap, {
    chainId: 137,
    fromAddress: account.address,
    allowedTo: UNIVERSAL_ROUTERS,
    maxGasLimit: MAX_GAS_LIMIT,
    maxDeadline: nowSeconds() + MAX_SWAP_DEADLINE_SECONDS,
  });

  // Last, after every assertion: simulate approve (if any) + swap in the
  // same block and check the WBTC reaching the recipient in the simulated
  // logs -- before any tx signature exists.
  let simulatedOut: bigint;
  try {
    const logs = await simulate(client, account.address, approval ? [approval, swapResponse.swap] : [swapResponse.swap]);
    simulatedOut = assertOutputTransfer(logs as ReceiptLog[], { tokenOut: config.tokenOut, recipient, minimumAmount }, UNIVERSAL_ROUTERS);
  } catch (err) {
    throw new Error(`pre-broadcast simulation failed: ${errorMessage(err)}`);
  }

  return {
    quoteResponse,
    swapResponse,
    approval,
    approvalCap,
    allowance,
    dcaAmountBaseUnits,
    minimumAmount,
    simulatedOut,
    recipient,
    deadline,
    impliedPrice,
    oraclePrice,
    deviationPct,
    btcUsd,
    usdtUsd,
    polUsd,
    tokenInMeta,
    tokenOutMeta,
  };
}

// ============================================================
// recovery + finalization -- never re-broadcast (README.md invariant #4)
// ============================================================

/** Writes to whichever table the run lives in: runs (daily) or manual_runs. */
function saver(db: DatabaseSync, run: Pick<Run, "wallet" | "date" | "manualId">): (patch: RunPatch) => void {
  return (patch) =>
    run.manualId !== undefined ? updateManualRun(db, run.manualId, patch) : updateRun(db, run.wallet, run.date, patch);
}

function reload(db: DatabaseSync, run: Pick<Run, "wallet" | "date" | "manualId">): Run {
  return run.manualId !== undefined
    ? listManualRuns(db, { wallet: run.wallet }).find((r) => r.manualId === run.manualId)!
    : getRun(db, run.wallet, run.date)!;
}

async function finalize(
  db: DatabaseSync,
  config: Config,
  client: Client,
  run: Run,
  receipt: NonNullable<Awaited<ReturnType<typeof getReceipt>>>
): Promise<void> {
  const gasUsed = receipt.gasUsed;
  const gasCostPol = Number(gasUsed * receipt.effectiveGasPrice) / 10 ** POL_DECIMALS;
  const polUsd = run.oraclePolUsd ? Number(run.oraclePolUsd) : 0;
  const gasFields = {
    blockNumber: receipt.blockNumber.toString(),
    gasUsed: gasUsed.toString(),
    gasCostPol: gasCostPol.toFixed(6),
    gasCostUsd: (gasCostPol * polUsd).toFixed(4),
  };

  if (receipt.status !== "success") {
    saver(db, run)({ status: "FAILED", error: "tx reverted on-chain", ...gasFields });
    logger.error("swap reverted on-chain", { date: run.date, txHash: run.txHash });
    process.exitCode = 1;
    return;
  }

  let amountOut: bigint;
  try {
    amountOut = assertOutputTransfer(
      receipt.logs as ReceiptLog[],
      { tokenOut: config.tokenOut, recipient: run.recipient!, minimumAmount: BigInt(run.minimumAmount!) },
      UNIVERSAL_ROUTERS
    );
  } catch (err) {
    // Tx confirmed but the WBTC didn't arrive as expected -- doesn't count as
    // a purchase, and pauses: repeating tomorrow without understanding why is the worst case.
    const message = `tx confirmed, but output doesn't match: ${errorMessage(err)}`;
    saver(db, run)({ status: "FAILED", error: message, ...gasFields });
    setPaused(db, { paused: true, reason: `auto-paused: ${run.date} ${message}` });
    logger.error("swap output doesn't match -- DCA paused", { date: run.date, txHash: run.txHash, error: message });
    process.exitCode = 1;
    return;
  }

  const [tokenInMeta, tokenOutMeta] = await Promise.all([
    getTokenMeta(client, config.tokenIn),
    getTokenMeta(client, config.tokenOut),
  ]);
  const effectivePrice = computeImpliedPricePerBtc({
    amountInBaseUnits: BigInt(run.amountIn!),
    amountOutBaseUnits: amountOut,
    decimalsIn: tokenInMeta.decimals,
    decimalsOut: tokenOutMeta.decimals,
  });

  const confirmation: RunPatch & { status: "CONFIRMED" } = {
    status: "CONFIRMED",
    confirmedAt: new Date().toISOString(),
    amountOut: amountOut.toString(),
    effectivePrice: effectivePrice.toFixed(2),
    ...gasFields,
  };
  if (run.manualId === undefined) {
    const shares = listRunShares(db, run.wallet, run.date);
    confirmScheduledRun(
      db, run.wallet, run.date, confirmation,
      splitShares(amountOut, gasFields.gasCostPol, gasFields.gasCostUsd, shares.map((s) => ({ strategyId: s.strategyId, amountIn: BigInt(s.amountIn) })))
    );
  } else saver(db, run)(confirmation);
  const completed = completeReachedStrategies(db, todayUtc(), new Date().toISOString(), AMOUNT_DECIMALS);
  if (completed.length > 0) logger.info("strategy limit reached -- completed", { strategies: completed });
  logger.info("purchase confirmed", { date: run.date, txHash: run.txHash, amountOut: amountOut.toString() });
}

/**
 * Resolves a BROADCAST: receipt, nonce and deadline decide (decideRecovery).
 * Waits at most until deadline + slack -- after that the tx would only revert.
 */
async function recoverBroadcast(db: DatabaseSync, config: Config, client: Client, account: Account, run: Run): Promise<void> {
  if (run.nonce === null || run.txHash === null || run.deadline === null) {
    // Shouldn't exist (BROADCAST is recorded together with nonce and hash,
    // and the deadline before). Without that data there's no way to decide --
    // leave it as is for manual inspection instead of guessing.
    throw new Error(`run ${run.date} in BROADCAST without nonce/txHash/deadline -- inspect by hand`);
  }
  const hash = run.txHash as `0x${string}`;
  let rechecked = false;

  for (;;) {
    // Nonce BEFORE receipt: in the reverse order, the tx can be mined between
    // the two reads (receipt null, nonce already consumed) and become a false
    // "nonce consumed by another tx" -- really happened on the fork.
    const latestNonce = await getNonce(client, account.address, "latest");
    const receipt = await getReceipt(client, hash);
    const now = nowSeconds();
    const action = decideRecovery({ hasReceipt: receipt !== null, latestNonce, recordedNonce: run.nonce, nowSeconds: now, deadline: run.deadline });

    if (action === "FINALIZE") return finalize(db, config, client, run, receipt!);
    if (action === "FAILED_NONCE_CONSUMED" && !rechecked) {
      // Node behind on its receipt index (or fallback to another node) -- a
      // short second chance before declaring our tx didn't land.
      rechecked = true;
      await waitReceipt(client, hash, NONCE_CONSUMED_RECHECK_MS);
      continue;
    }
    if (action === "FAILED_NONCE_CONSUMED" || action === "FAILED_EXPIRED") {
      const error =
        action === "FAILED_NONCE_CONSUMED"
          ? `nonce ${run.nonce} consumed by another tx; ${hash} never mined`
          : `${hash} not mined by the deadline -- can no longer execute`;
      saver(db, run)({ status: "FAILED", error });
      logger.error("broadcast not confirmed", { date: run.date, error });
      process.exitCode = 1;
      return;
    }
    // WAIT
    const remainingMs = (run.deadline + RECOVERY_GRACE_SECONDS - now + 1) * 1000;
    logger.info("waiting for receipt", { txHash: hash, maxWaitSeconds: Math.round(remainingMs / 1000) });
    await waitReceipt(client, hash, Math.max(remainingMs, 5000));
  }
}

async function recoverPreviousDays(db: DatabaseSync, config: Config, client: Client, account: Account, today: string): Promise<void> {
  for (const run of listRuns(db, { wallet: account.address })) {
    if (run.status === "BROADCAST") {
      logger.info("recovering pending BROADCAST", { date: run.date, txHash: run.txHash });
      await recoverBroadcast(db, config, client, account, run);
    } else if (run.status === "PENDING" && run.date < today) {
      // PENDING never broadcast (BROADCAST is recorded before sending).
      saver(db, run)({ status: "FAILED", error: "process interrupted before broadcast" });
    }
  }
  const staleBefore = new Date(Date.now() - MANUAL_PENDING_STALE_MS).toISOString();
  for (const run of listManualRuns(db, { wallet: account.address })) {
    if (run.status === "BROADCAST") {
      logger.info("recovering pending manual BROADCAST", { id: run.manualId, txHash: run.txHash });
      await recoverBroadcast(db, config, client, account, run);
    } else if (run.status === "PENDING" && run.createdAt! < staleBefore) {
      saver(db, run)({ status: "FAILED", error: "process interrupted before broadcast" });
    }
  }
}

// ============================================================
// execution
// ============================================================

async function dryRun(config: Config, settings: Settings, db: DatabaseSync, client: Client, account: Account, date: string, amount: string): Promise<void> {
  // Read-only on purpose -- see the comment at the top of the file.
  const existing = getRun(db, account.address, date);
  if (existing) console.log(`(info) a record already exists for today: status=${existing.status}`);
  if (isPaused(db, new Date().toISOString())) {
    console.log("(info) DCA is paused -- the real run would exit without buying");
  }

  const r = await runVerifiedFlow(config, settings, client, account, amount, dailyAmountFor(db, date, amount));
  console.log(`=== DRY RUN${MANUAL ? " (manual buy)" : ""} -- nothing was broadcast ===`);
  console.log(`run time: ${settings.runTime} UTC`);
  console.log(`amount: ${amount} ${config.tokenInSymbol}`);
  console.log("routing:", r.quoteResponse.routing);
  console.log("route:", r.quoteResponse.quote.routeString);
  console.log("to (Universal Router):", r.swapResponse.swap.to);
  console.log("WBTC destination:", r.recipient);
  console.log(`price (worst case): ${r.impliedPrice.toFixed(2)} ${config.tokenInSymbol}/BTC`);
  console.log(`oracle price:       ${r.oraclePrice.toFixed(2)} ${config.tokenInSymbol}/BTC`);
  console.log(`deviation: ${r.deviationPct.toFixed(3)}%`);
  console.log(
    r.approval
      ? `approve: YES -- current allowance ${r.allowance}, would be set to ${r.approvalCap} (day's total × APPROVAL_DAYS)`
      : `approve: not needed (allowance ${r.allowance})`
  );
  console.log(`simulation: WBTC received ${r.simulatedOut} (minimum ${r.minimumAmount})`);
  console.log("tx that would be sent:", JSON.stringify(r.swapResponse.swap, null, 2));
}

async function realRun(config: Config, db: DatabaseSync, client: Client, account: Account, date: string, assertCurrentSigner: () => void): Promise<void> {
  await recoverPreviousDays(db, config, client, account, date);
  const { decimals } = await getTokenMeta(client, config.tokenIn);
  if (decimals !== AMOUNT_DECIMALS) throw new Error(`input token has ${decimals} decimals; strategies assume ${AMOUNT_DECIMALS}`);
  const claim = claimScheduledRun(db, account.address, date, new Date().toISOString(), decimals, assertCurrentSigner);
  if (claim.kind === "already-claimed") {
    logger.info("day already processed, exiting without doing anything", { date, wallet: account.address });
    return;
  }
  if (claim.kind === "nothing-to-buy") {
    logger.info("no strategy to buy today", { date });
    return;
  }
  const total = claim.shares.reduce((sum, s) => sum + BigInt(s.amountIn), 0n);
  const totalHuman = formatUnits(total, decimals);
  if (isPaused(db, new Date().toISOString())) {
    updateRun(db, account.address, date, { status: "PAUSED" });
    logger.info("DCA paused, day recorded without buying", { date });
  } else {
    try {
      assertRunTotal([totalHuman]);
    } catch (err) {
      updateRun(db, account.address, date, { status: "FAILED", error: errorMessage(err) });
      logger.error("run total above the cap -- nothing bought", { date, total: totalHuman });
      process.exitCode = 1;
      await emailReport(config, db, account.address, date);
      return;
    }
    logger.info("scheduled buy", { date, total: totalHuman, strategies: claim.shares.map((s) => s.strategyId) });
    await execute(config, db, client, account, totalHuman, totalHuman, { wallet: account.address, date });
  }
  await emailReport(config, db, account.address, date);
  await emailFundsAlert(config, db, client, account);
}

/**
 * Low-funds alert, once a day after the scheduled run's report: USDT0 or POL
 * lasting <= the app's alert days, and always when the next run can't be paid.
 * Independent of the report mode. Same runway math as the app (health.ts);
 * a failure here never changes the run.
 */
async function emailFundsAlert(config: Config, db: DatabaseSync, client: Client, account: Account): Promise<void> {
  if (!config.report) return;
  try {
    const [tokenInUnits, polWei] = await Promise.all([
      getErc20Balance(client, config.tokenIn, account.address),
      getNativeBalance(client, account.address),
    ]);
    const settings = getSettings(db);
    const nowIso = new Date().toISOString();
    const health = balanceHealth({
      tokenInUnits,
      dailyNeedUnits: activeAmounts(db, nowIso.slice(0, 10)).reduce((sum, a) => sum + toBaseUnits(a, AMOUNT_DECIMALS), 0n),
      polWei,
      minPolWei: BigInt(Math.round((settings?.minPolBalance ?? 0) * 10 ** POL_DECIMALS)),
      avgGasWei: averageGasWei(recentGasCostsPol(db, GAS_SAMPLE_RUNS)),
      allowanceUnits: 0n, // allowance runway isn't a funds problem; fundsAlert ignores it
      nowIso,
      runTime: settings?.runTime ?? "00:00",
    });
    const alertDays = getAlertDays(db);
    const items = fundsAlert(health, alertDays);
    if (items.length === 0) return;
    await sendReport(config.report, buildFundsAlert(items, alertDays));
    logger.warn("low-funds alert sent", { items });
  } catch (err) {
    logger.error("low-funds alert failed (the run itself is unaffected)", { error: err });
  }
}

/** Scheduled runs only (F3). After the run is final; a failure here never changes its outcome. */
async function emailReport(config: Config, db: DatabaseSync, wallet: string, date: string): Promise<void> {
  if (!config.report) return;
  try {
    const run = getRun(db, wallet, date)!;
    const mode = getReportMode(db);
    if (mode === "off" || (mode === "errors" && run.status !== "FAILED")) {
      logger.info("email report skipped: app mode is not sending this outcome", { date, mode, status: run.status });
      return;
    }
    const shares = listRunShares(db, wallet, date).map((s) => {
      const st = getStrategy(db, s.strategyId);
      return { label: st?.label ?? `#${s.strategyId}`, amountIn: s.amountIn, amountOut: s.amountOut };
    });
    await sendReport(config.report, buildReport(run, shares, listAllRuns(db)));
    logger.info("email report sent", { date, status: run.status });
  } catch (err) {
    logger.error("email report failed (the run itself is unaffected)", { error: err, date });
  }
}

async function manualRun(config: Config, db: DatabaseSync, client: Client, account: Account, date: string, strategyId: number, assertCurrentSigner: () => void): Promise<void> {
  // Recovery first: a pending tx of ours must be resolved before signing another.
  await recoverPreviousDays(db, config, client, account, date);

  // Do every calculation that may reject the buy before reserving budget.
  // (Approve cap only: the strategy's full amount, even when the claim below
  // then takes just the remainder of its max total.)
  const dailyAmount = dailyAmountFor(db, date, getStrategy(db, strategyId)?.amount ?? "0");

  const { decimals } = await getTokenMeta(client, config.tokenIn);
  if (decimals !== AMOUNT_DECIMALS) throw new Error(`input token has ${decimals} decimals; strategies assume ${AMOUNT_DECIMALS}`);

  const claim = claimManualRun(db, account.address, date, new Date().toISOString(), strategyId, AMOUNT_DECIMALS, assertCurrentSigner);
  if (claim.kind === "refused") {
    logger.error(`manual buy refused: ${claim.reason}`, { date });
    process.exitCode = 1;
    return;
  }
  const { id: manualId, amount } = claim;
  logger.info("manual buy", { id: manualId, strategy: strategyId, amount });
  await execute(config, db, client, account, amount, dailyAmount, { wallet: account.address, date, manualId });
}

/** The buy itself, shared by the daily and the manual run: the row already exists as PENDING. */
async function execute(
  config: Config,
  db: DatabaseSync,
  client: Client,
  account: Account,
  amount: string,
  dailyAmount: string,
  key: Pick<Run, "wallet" | "date" | "manualId">
): Promise<void> {
  const save = saver(db, key);
  let signed: Awaited<ReturnType<typeof signTx>>;
  try {
    const r = await runVerifiedFlow(config, loadSettings(db), client, account, amount, dailyAmount);
    save({
      amountIn: r.dcaAmountBaseUnits.toString(),
      recipient: r.recipient,
      minimumAmount: r.minimumAmount.toString(),
      priceImpactPct: r.quoteResponse.quote.priceImpact?.toString() ?? null,
      oracleBtcUsd: r.btcUsd.price.toString(),
      oracleUsdtUsd: r.usdtUsd.price.toString(),
      oraclePolUsd: r.polUsd.price.toString(),
      oracleDeviationPct: r.deviationPct.toFixed(3),
      routing: r.quoteResponse.routing,
      routeString: r.quoteResponse.quote.routeString ?? null,
      requestId: r.quoteResponse.requestId,
      quoteId: r.quoteResponse.quote.quoteId ?? null,
      deadline: r.deadline,
    });

    if (r.approval) {
      const nonce = await getNonce(client, account.address, "pending");
      const approveSigned = await signTx(client, account, { ...r.approval, nonce });
      logger.info("sending approve", { cap: r.approvalCap.toString(), previousAllowance: r.allowance.toString(), txHash: approveSigned.hash });
      await sendRaw(client, approveSigned.raw);
      const receipt = await waitReceipt(client, approveSigned.hash, APPROVE_RECEIPT_TIMEOUT_MS);
      if (!receipt || receipt.status !== "success") {
        throw new Error(`approve ${approveSigned.hash} ${receipt ? "reverted" : "no receipt in time"}`);
      }
    }

    const nonce = await getNonce(client, account.address, "pending");
    signed = await signTx(client, account, { ...r.swapResponse.swap, nonce });
    if (signed.gas > MAX_GAS_LIMIT) throw new Error(`estimated gas ${signed.gas} above MAX_GAS_LIMIT`);

    // BROADCAST with nonce and hash BEFORE sending: if the process dies between
    // this line and sendRaw, recovery knows exactly what to look for.
    save({ status: "BROADCAST", nonce, txHash: signed.hash });
  } catch (err) {
    save({ status: "FAILED", error: errorMessage(err) });
    logger.error("DCA failed before broadcast", { error: err, date: key.date, manualId: key.manualId });
    process.exitCode = 1;
    return;
  }

  try {
    await sendRaw(client, signed.raw);
    logger.info("swap broadcast", { date: key.date, manualId: key.manualId, txHash: signed.hash });
  } catch (err) {
    // May have reached the mempool despite the error (network timeout) --
    // recovery decides by receipt/nonce, never resending.
    logger.error("sendRawTransaction failed; recovery decides", { error: err, txHash: signed.hash });
  }

  await recoverBroadcast(db, config, client, account, reload(db, key));
}

async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDb(config.dbFile);
  try {
    const nowIso = new Date().toISOString();
    // Dry-run writes nothing (see the top of the file): settings from the
    // database, else from the legacy env without saving them.
    if (!DRY_RUN) seedSettingsAndStrategyFromEnv(db, process.env, nowIso);
    const settings = DRY_RUN
      ? getSettings(db) ?? settingsFromEnv(process.env) ?? (() => { throw new SetupError("settings not configured -- finish setup in the app"); })()
      : loadSettings(db); // SetupError ("finish setup in the app") -> exit 1, nothing bought
    if (!MANUAL && !DRY_RUN && !isDue(nowIso, settings.runTime)) return;
    const masterKey = loadMasterKey();
    if (!DRY_RUN) seedPrivateKeyFromEnv(db, process.env, masterKey);
    // Dry-run never seeds the database. A legacy env key can preview a fresh
    // setup, while a stored key always takes precedence.
    let key: `0x${string}`;
    if (DRY_RUN && getSecret(db, "private_key") === undefined) {
      const raw = process.env.PRIVATE_KEY?.trim();
      if (!raw) throw new SetupError("no private key stored -- set it in the app");
      registerSecret(raw);
      key = parsePrivateKey(raw).key;
      registerSecret(key);
    } else {
      key = loadPrivateKey(db, masterKey);
    }
    const account = getAccount(key);
    const assertCurrentSigner = () => assertPrivateKeyUnchanged(db, masterKey, key);
    const today = todayUtc();
    if (!MANUAL && !DRY_RUN) {
      // Every 15-min tick lands here: nothing to do (no network, no log)
      // before today's run time, or once today's run is final. PENDING or
      // BROADCAST still go through realRun, whose recovery resolves them.
      const status = getRun(db, account.address, today)?.status;
      if (status === "CONFIRMED" || status === "FAILED" || status === "PAUSED") return;
    }
    const client = createRpcClient(config.rpcUrl, config.rpcUrlFallback);
    if (MANUAL) {
      if (process.argv.includes("--amount")) throw new Error("--amount is gone: a manual buy spends the strategy's own amount (edit it in the app)");
      const strategyId = Number(argValue("--strategy"));
      if (!Number.isInteger(strategyId) || strategyId <= 0) throw new Error("--strategy <id> is required for a manual buy (see the app, or npm run export)");
      if (DRY_RUN) {
        // Read-only preview of what claimManualRun would reserve.
        const strategy = getStrategy(db, strategyId);
        if (!strategy) throw new Error(`strategy #${strategyId} not found`);
        const units = manualBuyUnits(db, strategy, AMOUNT_DECIMALS);
        if (units <= 0n) throw new Error(`strategy #${strategyId} has nothing left of its max total`);
        await dryRun(config, settings, db, client, account, today, formatUnits(units, AMOUNT_DECIMALS));
      } else await manualRun(config, db, client, account, today, strategyId, assertCurrentSigner);
    } else {
      const amounts = activeAmounts(db, today);
      if (DRY_RUN) {
        if (amounts.length === 0) console.log("(info) no active strategy -- the real run would buy nothing");
        else await dryRun(config, settings, db, client, account, today, formatUnits(assertRunTotal(amounts), AMOUNT_DECIMALS));
      } else await realRun(config, db, client, account, today, assertCurrentSigner);
    }
  } finally {
    db.close();
  }
}

main().catch((err) => {
  logger.error("dca.ts failed with an unhandled error", { error: err });
  process.exitCode = 1;
});
