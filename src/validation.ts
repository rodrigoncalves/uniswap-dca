// The heart of the bot: nothing is signed without passing through here (README.md invariant #1).
// Pure functions, zero I/O, zero network -- every "now" and every on-chain
// datum comes in as a parameter, never read internally (Date.now(), fetch, etc.).
// That is what makes each one testable without mocks.
//
// Address convention: every comparison goes through getAddress() before
// comparing, so "0xabc..." and "0xABC..." (same value) always match.
//
// The three security-policy constants below are hardcoded, not read from
// env -- README.md invariant #5 ("limits... live in code"). See the comment on each
// one for the reasoning behind its value.

import { getAddress, decodeFunctionData, parseEventLogs } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { PERMIT2_ADDRESS } from "./tokens.js";

export class ValidationError extends Error {
  constructor(problems: string[]) {
    super(`${problems.length} validation problem(s):\n` + problems.map((p) => `  - ${p}`).join("\n"));
    this.name = "ValidationError";
  }
}

function fail(problems: string[]): never {
  throw new ValidationError(problems);
}

/** getAddress() that reports a problem instead of throwing raw -- fail closed with a readable message. */
function tryAddress(value: string, label: string, problems: string[]): `0x${string}` | undefined {
  try {
    return getAddress(value);
  } catch {
    problems.push(`${label}: "${value}" is not a valid address`);
    return undefined;
  }
}

function addressEquals(a: string, b: string): boolean {
  try {
    return getAddress(a) === getAddress(b);
  } catch {
    return false;
  }
}

// ============================================================
// assertQuote
// ============================================================

export interface QuoteToValidate {
  routing: string;
  chainId: number;
  swapper: string;
  input: { token: string; amount: string };
  output: { token: string; amount: string; recipient?: string; minimumAmount?: string };
  slippage: number;
  priceImpact?: number;
  txFailureReasons?: unknown[];
}

export interface QuoteExpectation {
  chainId: number;
  swapperAddress: string;
  tokenIn: string;
  tokenOut: string;
  expectedRecipient: string;
  expectedInputAmount: bigint;
  maxSlippagePct: number;
  maxPriceImpactPct: number;
}

/**
 * Does not validate the route shape (single-hop vs multi-hop) -- the route
 * is the router's decision, not something the bot should restrict. What
 * matters is that input, output and destination are exactly as expected.
 */
export function assertQuote(quote: QuoteToValidate, expect: QuoteExpectation): void {
  const problems: string[] = [];

  if (quote.routing !== "CLASSIC") {
    problems.push(`routing: expected "CLASSIC" (Polygon has no UniswapX), got "${quote.routing}"`);
  }
  if (quote.chainId !== expect.chainId) {
    problems.push(`chainId: expected ${expect.chainId}, got ${quote.chainId}`);
  }
  if (!addressEquals(quote.swapper, expect.swapperAddress)) {
    problems.push(`swapper: expected ${expect.swapperAddress}, got ${quote.swapper}`);
  }
  if (!addressEquals(quote.input.token, expect.tokenIn)) {
    problems.push(`input.token: expected ${expect.tokenIn}, got ${quote.input.token}`);
  }
  if (!addressEquals(quote.output.token, expect.tokenOut)) {
    problems.push(`output.token: expected ${expect.tokenOut}, got ${quote.output.token}`);
  }
  // The expected recipient comes from CONFIG (recipientOrSelf), never from
  // what the API echoes back -- see DECISIONS.md #4. If the API returns no
  // recipient at all (undefined), that is rejected too: the contract is
  // "the API confirms the destination I asked for", silence is not confirmation.
  if (!quote.output.recipient || !addressEquals(quote.output.recipient, expect.expectedRecipient)) {
    problems.push(`output.recipient: expected ${expect.expectedRecipient}, got ${quote.output.recipient ?? "(missing)"}`);
  }
  let inputAmount: bigint | undefined;
  try {
    inputAmount = BigInt(quote.input.amount);
  } catch {
    problems.push(`input.amount: "${quote.input.amount}" is not a valid integer`);
  }
  if (inputAmount !== undefined && inputAmount !== expect.expectedInputAmount) {
    problems.push(`input.amount: expected ${expect.expectedInputAmount}, got ${inputAmount}`);
  }
  if (quote.slippage > expect.maxSlippagePct) {
    problems.push(`slippage: ${quote.slippage}% above the cap (${expect.maxSlippagePct}%)`);
  }
  if (quote.priceImpact !== undefined && quote.priceImpact > expect.maxPriceImpactPct) {
    problems.push(`priceImpact: ${quote.priceImpact}% above the cap (${expect.maxPriceImpactPct}%)`);
  }
  if (quote.txFailureReasons && quote.txFailureReasons.length > 0) {
    problems.push(`txFailureReasons: the API's own simulation already failed (${JSON.stringify(quote.txFailureReasons)})`);
  }
  const minimumAmount = quote.output.minimumAmount !== undefined ? BigInt(quote.output.minimumAmount) : undefined;
  if (minimumAmount === undefined || minimumAmount <= 0n) {
    problems.push(`output.minimumAmount: must be > 0, got ${quote.output.minimumAmount ?? "(missing)"}`);
  }

  if (problems.length > 0) fail(problems);
}

// ============================================================
// assertPermit
// ============================================================

export interface PermitToValidate {
  domain: { chainId?: number | string; verifyingContract?: string; [key: string]: unknown };
  types: Record<string, { name: string; type: string }[]>;
  values: Record<string, unknown>;
}

export interface PermitExpectation {
  chainId: number;
  tokenIn: string;
  expectedAmount: bigint;
  allowedSpenders: readonly string[];
  /** Cap for sigDeadline (AllowanceTransfer) and deadline (SignatureTransfer) -- validity of the SIGNATURE. */
  maxSignatureTtlSeconds: number;
  /** Cap for details.expiration (AllowanceTransfer) -- validity of the on-chain ALLOWANCE, if the permit is executed. */
  maxAllowanceExpirationSeconds: number;
  nowSeconds: number;
}

/**
 * Cap for sigDeadline/deadline -- validity of the SIGNATURE itself. The bot
 * signs and broadcasts within seconds; a signature valid for days is just
 * extra attack surface (if leaked via logs/network, it stays usable until
 * that date). 1h is generous slack for any real network delay.
 *
 * NOT the same cap as details.expiration -- see
 * MAX_ALLOWANCE_EXPIRATION_SECONDS right below. Applying this value (1h) to
 * both fields was a real bug in the first version: a real production API
 * call returned expiration ~30 days out (the normal Permit2
 * AllowanceTransfer default), and that version rejected every real quote
 * because of it.
 */
export const MAX_PERMIT_TTL_SECONDS = 3600;

/**
 * Cap for details.expiration -- validity of the on-chain ALLOWANCE that
 * Permit2 would grant the Universal Router IF this permit were executed.
 * Calibrated with real data: a real /quote call on 2026-09-22 returned
 * expiration exactly ~30 days (2591977s) out -- it is the AllowanceTransfer
 * default, not an anomaly. 35 days gives slack over that observation
 * without giving up the cap (something like years would be
 * indistinguishable from "no cap").
 *
 * The risk this mitigates is narrow even without the cap: permitAmount=EXACT
 * already limits the authorized amount to the day's purchase, so even a
 * 30-day window only exposes that specific amount, not a high limit -- but
 * documenting and checking the cap is still cheap defense in depth.
 */
export const MAX_ALLOWANCE_EXPIRATION_SECONDS = 35 * 86_400;

/**
 * The API returns `value` in hex ("0x00"), not decimal -- comparing the
 * string to "0" rejected every real tx. BigInt("") is 0n, hence the empty guard.
 */
function isZeroValue(value: string): boolean {
  if (value.trim() === "") return false;
  try {
    return BigInt(value) === 0n;
  } catch {
    return false;
  }
}

function asInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return Number(value);
  return undefined;
}

function checkDeadline(label: string, raw: unknown, nowSeconds: number, maxTtlSeconds: number, problems: string[]): void {
  const value = asInt(raw);
  if (value === undefined) {
    problems.push(`${label}: "${raw}" is not a valid timestamp`);
    return;
  }
  if (value <= nowSeconds) {
    problems.push(`${label}: already expired (${value} <= now ${nowSeconds})`);
    return;
  }
  if (value > nowSeconds + maxTtlSeconds) {
    problems.push(`${label}: ${value} is beyond the maximum allowed TTL (${maxTtlSeconds}s from now)`);
  }
}

/**
 * Two Permit2 message shapes -- see DECISIONS.md #4/#9. Polygon always uses
 * AllowanceTransfer (PermitSingle: details.{token,amount,expiration} +
 * spender + sigDeadline) in practice, but SignatureTransfer (PermitTransferFrom:
 * permitted.{token,amount} + spender + deadline) is handled defensively in
 * case the API ever returns that shape for some route.
 *
 * The amount is compared by EXACT EQUALITY, not "<= cap": we request
 * `permitAmount: "EXACT"` on /quote, so the signed amount must be exactly
 * the day's purchase. The multi-day cap (dcaAmount * approvalDays) is
 * assertApprovalTx's job, on the ERC-20 approval -- not this assert's, on
 * the Permit2 message. Mixing the two up was a real mistake in the first
 * version of this comment.
 */
export function assertPermit(permit: PermitToValidate, expect: PermitExpectation): void {
  // Coupling to keep in mind in wallet.ts (D1): the shape detection below
  // (details first, permitted second) must be the SAME priority used to
  // build the EIP-712 message that actually gets signed. If the signing
  // code picks a different field than the one validated here, one thing is
  // validated and another is signed.
  const problems: string[] = [];

  const domainChainId = asInt(permit.domain.chainId);
  if (domainChainId !== expect.chainId) {
    problems.push(`domain.chainId: expected ${expect.chainId}, got ${permit.domain.chainId}`);
  }
  if (!permit.domain.verifyingContract || !addressEquals(permit.domain.verifyingContract, PERMIT2_ADDRESS)) {
    problems.push(`domain.verifyingContract: expected Permit2 (${PERMIT2_ADDRESS}), got ${permit.domain.verifyingContract}`);
  }

  const values = permit.values as Record<string, unknown>;
  const isAllowanceTransfer = typeof values.details === "object" && values.details !== null;
  const isSignatureTransfer = typeof values.permitted === "object" && values.permitted !== null;

  if (!isAllowanceTransfer && !isSignatureTransfer) {
    fail([`unknown permit format: neither "details" (AllowanceTransfer) nor "permitted" (SignatureTransfer) present in values`]);
  }

  let token: unknown;
  let amount: unknown;

  if (isAllowanceTransfer) {
    const details = values.details as Record<string, unknown>;
    token = details.token;
    amount = details.amount;
    checkDeadline("details.expiration", details.expiration, expect.nowSeconds, expect.maxAllowanceExpirationSeconds, problems);
    checkDeadline("sigDeadline", values.sigDeadline, expect.nowSeconds, expect.maxSignatureTtlSeconds, problems);
  } else {
    const permitted = values.permitted as Record<string, unknown>;
    token = permitted.token;
    amount = permitted.amount;
    checkDeadline("deadline", values.deadline, expect.nowSeconds, expect.maxSignatureTtlSeconds, problems);
  }

  if (typeof token !== "string" || !addressEquals(token, expect.tokenIn)) {
    problems.push(`token: expected ${expect.tokenIn}, got ${token}`);
  }

  let amountBigInt: bigint | undefined;
  try {
    amountBigInt = BigInt(String(amount));
  } catch {
    problems.push(`amount: "${amount}" is not a valid integer`);
  }
  if (amountBigInt !== undefined && amountBigInt !== expect.expectedAmount) {
    problems.push(`amount: expected exactly ${expect.expectedAmount} (permitAmount=EXACT), got ${amountBigInt}`);
  }

  const spender = values.spender;
  if (typeof spender !== "string" || !expect.allowedSpenders.some((allowed) => addressEquals(allowed, spender))) {
    problems.push(`spender: "${spender}" not in the Universal Router allowlist`);
  }

  if (problems.length > 0) fail(problems);
}

// ============================================================
// assertSwapTx
// ============================================================

export interface SwapTxToValidate {
  to: string;
  from: string;
  data: string;
  value: string;
  chainId: number;
  gasLimit?: string;
  maxFeePerGas?: string;
  gasPrice?: string;
}

export interface SwapTxExpectation {
  chainId: number;
  fromAddress: string;
  allowedTo: readonly string[];
  maxGasLimit: bigint;
  /** Cap (unix s) for the calldata deadline -- recovery depends on it. */
  maxDeadline: number;
}

/**
 * Cap for the execute() deadline relative to now. The API IGNORES the
 * `deadline` requested on /swap (tested: requests for 300s and 3000s both
 * became the same ~1800s) -- the calldata uses the permit's sigDeadline,
 * ~30 min. So the bot doesn't choose the deadline, it only bounds it and
 * reads it from the calldata. 1h gives slack over the observed value; same
 * value as MAX_PERMIT_TTL_SECONDS.
 */
export const MAX_SWAP_DEADLINE_SECONDS = 3600;

const UR_EXECUTE_ABI = [
  {
    type: "function",
    name: "execute",
    inputs: [
      { name: "commands", type: "bytes" },
      { name: "inputs", type: "bytes[]" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "payable",
  },
] as const;

/**
 * MAX_GAS_LIMIT: sanity cap on the gasLimit the API returns. A typical
 * CLASSIC swap via the Universal Router on Polygon uses a few hundred
 * thousand gas; 2M is generous slack without letting an absurd value
 * through unquestioned. If gasLimit is missing, this assert does not
 * block -- wallet.ts is responsible for estimating and applying the same
 * cap before broadcasting (D1).
 */
export const MAX_GAS_LIMIT = 2_000_000n;

/** Returns the deadline (unix s) decoded from the calldata -- the bound recovery uses. */
export function assertSwapTx(tx: SwapTxToValidate, expect: SwapTxExpectation): number {
  const problems: string[] = [];
  let deadline = 0;

  if (tx.chainId !== expect.chainId) {
    problems.push(`chainId: expected ${expect.chainId}, got ${tx.chainId}`);
  }
  if (!addressEquals(tx.from, expect.fromAddress)) {
    problems.push(`from: expected ${expect.fromAddress}, got ${tx.from}`);
  }
  if (!expect.allowedTo.some((allowed) => addressEquals(allowed, tx.to))) {
    problems.push(`to: "${tx.to}" not in the Universal Router allowlist`);
  }
  if (!tx.data || tx.data === "0x") {
    problems.push(`data: empty -- a transaction without calldata cannot be a swap`);
  } else {
    try {
      const { args } = decodeFunctionData({ abi: UR_EXECUTE_ABI, data: tx.data as `0x${string}` });
      deadline = Number(args[2]);
      if (deadline > expect.maxDeadline) {
        problems.push(`deadline: ${deadline} beyond the cap (${expect.maxDeadline})`);
      }
    } catch {
      problems.push(`data: calldata does not decode as Universal Router execute(bytes,bytes[],uint256)`);
    }
  }
  if (!isZeroValue(tx.value)) {
    problems.push(`value: expected "0" (input is ERC-20, no reason to send POL), got "${tx.value}"`);
  }
  if (tx.maxFeePerGas && tx.gasPrice) {
    problems.push(`gasPrice and maxFeePerGas cannot both be present`);
  }
  if (tx.gasLimit !== undefined) {
    let gasLimit: bigint | undefined;
    try {
      gasLimit = BigInt(tx.gasLimit);
    } catch {
      problems.push(`gasLimit: "${tx.gasLimit}" is not a valid integer`);
    }
    if (gasLimit !== undefined && (gasLimit <= 0n || gasLimit > expect.maxGasLimit)) {
      problems.push(`gasLimit: ${gasLimit} outside the acceptable range (0, ${expect.maxGasLimit}]`);
    }
  }

  if (problems.length > 0) fail(problems);
  return deadline;
}

// ============================================================
// assertApprovalTx
// ============================================================

const ERC20_APPROVE_ABI = [
  {
    type: "function",
    name: "approve",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
    stateMutability: "nonpayable",
  },
] as const;

export interface ApprovalTxToValidate {
  to: string;
  from: string;
  data: string;
  value: string;
  chainId: number;
}

export interface ApprovalTxExpectation {
  chainId: number;
  fromAddress: string;
  /** The TOKEN (e.g. USDT0) -- approve() is called ON it, not on Permit2. */
  tokenAddress: string;
  expectedSpender: string;
  maxAmount: bigint;
}

/**
 * `to` is the TOKEN address (approve() is a function of the ERC-20
 * itself), not Permit2 -- Permit2 only appears as `spender` inside the
 * calldata. That inversion ("shouldn't `to` be Permit2?") is the easiest
 * mistake to make here; documented explicitly for whoever writes wallet.ts (D1).
 */
export function assertApprovalTx(tx: ApprovalTxToValidate, expect: ApprovalTxExpectation): void {
  const problems: string[] = [];

  if (tx.chainId !== expect.chainId) {
    problems.push(`chainId: expected ${expect.chainId}, got ${tx.chainId}`);
  }
  if (!addressEquals(tx.from, expect.fromAddress)) {
    problems.push(`from: expected ${expect.fromAddress}, got ${tx.from}`);
  }
  if (!addressEquals(tx.to, expect.tokenAddress)) {
    problems.push(`to: expected the token address (${expect.tokenAddress}), got ${tx.to} -- approve() is called ON the token, not on Permit2`);
  }
  if (!isZeroValue(tx.value)) {
    problems.push(`value: expected "0", got "${tx.value}"`);
  }

  let decoded: { functionName: string; args: readonly unknown[] } | undefined;
  try {
    decoded = decodeFunctionData({ abi: ERC20_APPROVE_ABI, data: tx.data as `0x${string}` }) as {
      functionName: string;
      args: readonly unknown[];
    };
  } catch {
    problems.push(`data: calldata does not decode as approve(address,uint256)`);
  }

  if (decoded) {
    if (decoded.functionName !== "approve") {
      problems.push(`data: expected the approve function, decoded "${decoded.functionName}"`);
    }
    const [spender, amount] = decoded.args as [string, bigint];
    if (!addressEquals(spender, expect.expectedSpender)) {
      problems.push(`spender: expected Permit2 (${expect.expectedSpender}), got ${spender}`);
    }
    if (amount > expect.maxAmount) {
      problems.push(`amount: ${amount} above the approval cap (${expect.maxAmount})`);
    }
  }

  if (problems.length > 0) fail(problems);
}

// ============================================================
// toBaseUnits
// ============================================================

/**
 * Converts a human decimal ("200", "0.5") to base units (bigint), given the
 * token's real `decimals` (confirmed on-chain, not hardcoded). String-based
 * on purpose -- Number(human) * 10**decimals risks floating-point
 * imprecision for larger values. Rejects more decimal places than the
 * token supports instead of silently truncating: silent precision loss in
 * a monetary value is exactly the kind of bug that doesn't show up in
 * manual testing and does show up in production.
 */
export function toBaseUnits(humanAmount: string, decimals: number): bigint {
  const match = /^([0-9]+)(?:\.([0-9]+))?$/.exec(humanAmount);
  if (!match) {
    throw new ValidationError([`toBaseUnits: "${humanAmount}" is not a valid decimal`]);
  }
  const [, integerPart, fractionalPart = ""] = match;
  if (fractionalPart.length > decimals) {
    throw new ValidationError([
      `toBaseUnits: "${humanAmount}" has ${fractionalPart.length} decimal places, but the token only supports ${decimals} -- precision loss`,
    ]);
  }
  const paddedFraction = fractionalPart.padEnd(decimals, "0");
  return BigInt(integerPart + paddedFraction);
}

// ============================================================
// derivePrimaryType
// ============================================================

/**
 * The API does not return `primaryType` in permitData (see DECISIONS.md),
 * so we derive it: it is the struct no other struct references as a field
 * type. EIP712Domain is explicitly excluded from the candidate set -- it is
 * never referenced by anything, so without that exclusion it would show up
 * as a second "candidate" and the algorithm would fail on ambiguity even
 * for a perfectly valid types map.
 */
export function derivePrimaryType(types: Record<string, { name: string; type: string }[]>): string {
  const structNames = new Set(Object.keys(types).filter((name) => name !== "EIP712Domain"));
  const referenced = new Set<string>();
  for (const name of structNames) {
    for (const field of types[name]!) {
      if (structNames.has(field.type)) referenced.add(field.type);
    }
  }
  const candidates = [...structNames].filter((name) => !referenced.has(name));
  if (candidates.length !== 1) {
    throw new ValidationError([
      `derivePrimaryType: expected exactly 1 unreferenced struct, found ${candidates.length} (${candidates.join(", ") || "none"})`,
    ]);
  }
  return candidates[0]!;
}

// ============================================================
// oracle: computeImpliedPricePerBtc + assertOraclePriceWithinDeviation
// ============================================================

/**
 * MAX_ORACLE_AGE_SECONDS: 24h -- matches the typical heartbeat of the
 * Chainlink feeds used here (BTC/USD, USDT/USD, POL/USD on Polygon). A feed
 * older than that signals a problem with the feed or the RPC, not a calm
 * market.
 */
export const MAX_ORACLE_AGE_SECONDS = 86_400;

export interface ImpliedPriceInput {
  amountInBaseUnits: bigint;
  amountOutBaseUnits: bigint;
  decimalsIn: number;
  decimalsOut: number;
}

/**
 * Pure price, no assertion -- so the caller can log the number even when
 * the assert below isn't called or passes uneventfully.
 *
 * Converting to Number() here is safe: the values involved (one day of DCA
 * in USDT0/WBTC) are far below Number.MAX_SAFE_INTEGER. That would NOT be
 * safe for the exact amounts used in assertQuote/assertPermit (which is why
 * those use bigint) -- here it is a percentage-deviation comparison against
 * an oracle that is already an estimate, not exact equality, so floating
 * point is appropriate and simpler.
 */
export function computeImpliedPricePerBtc(input: ImpliedPriceInput): number {
  const amountInHuman = Number(input.amountInBaseUnits) / 10 ** input.decimalsIn;
  const amountOutHuman = Number(input.amountOutBaseUnits) / 10 ** input.decimalsOut;
  return amountInHuman / amountOutHuman;
}

export interface OracleCheckInput extends ImpliedPriceInput {
  btcUsd: number;
  usdtUsd: number;
  maxDeviationPct: number;
  btcUsdUpdatedAt: number;
  usdtUsdUpdatedAt: number;
  maxOracleAgeSeconds: number;
  nowSeconds: number;
}

export function assertOraclePriceWithinDeviation(input: OracleCheckInput): void {
  const problems: string[] = [];

  // Anomalous feed print (has really happened in known Chainlink
  // incidents) -- without this, a price <= 0 becomes Infinity/NaN in the
  // deviation math below instead of being rejected with a clear message.
  if (input.btcUsd <= 0) problems.push(`btcUsd: invalid feed value (${input.btcUsd})`);
  if (input.usdtUsd <= 0) problems.push(`usdtUsd: invalid feed value (${input.usdtUsd})`);
  if (problems.length > 0) fail(problems);

  const btcAge = input.nowSeconds - input.btcUsdUpdatedAt;
  if (btcAge > input.maxOracleAgeSeconds) {
    problems.push(`BTC/USD feed stale: ${btcAge}s since last update (max ${input.maxOracleAgeSeconds}s)`);
  }
  const usdtAge = input.nowSeconds - input.usdtUsdUpdatedAt;
  if (usdtAge > input.maxOracleAgeSeconds) {
    problems.push(`USDT/USD feed stale: ${usdtAge}s since last update (max ${input.maxOracleAgeSeconds}s)`);
  }

  if (problems.length > 0) fail(problems);

  const impliedPrice = computeImpliedPricePerBtc(input);
  // BTC/USD divided by USDT/USD gives USDT per BTC -- using the USDT feed
  // instead of assuming USDT0 = $1 absorbs a depeg without loosening the tolerance.
  const oraclePrice = input.btcUsd / input.usdtUsd;
  const deviationPct = (Math.abs(impliedPrice - oraclePrice) / oraclePrice) * 100;

  if (deviationPct > input.maxDeviationPct) {
    fail([
      `price deviation above the cap: implied=${impliedPrice.toFixed(2)} USDT/BTC, oracle=${oraclePrice.toFixed(2)} USDT/BTC, deviation=${deviationPct.toFixed(3)}% (max ${input.maxDeviationPct}%)`,
    ]);
  }
}

// ============================================================
// needsApproval
// ============================================================

/**
 * Approve when the token's allowance to Permit2 doesn't cover the day, OR
 * when it exceeds the cap (scheduled total × APPROVAL_DAYS) -- the second case
 * shrinks an inherited unlimited allowance instead of living with it.
 */
export function needsApproval(allowance: bigint, dayAmount: bigint, cap: bigint): boolean {
  return allowance < dayAmount || allowance > cap;
}

/**
 * Gas limit to sign with: the larger of the API's gasLimit and our own
 * estimate + 20%. The API's value is only trustworthy when it could simulate
 * the swap on mainnet; when it can't (allowance to Permit2 not there yet at
 * quote time -- every APPROVAL_DAYS, since the quote comes before our
 * approve), it returns a short fallback (126100 vs 212433 really needed, OOG
 * revert on the fork). Our estimate runs after the approve is mined, so it
 * sees the real state. DECISIONS.md #15.
 */
export function chooseGasLimit(apiGasLimit: bigint | null, estimated: bigint): bigint {
  const ours = (estimated * 120n) / 100n;
  return apiGasLimit !== null && apiGasLimit > ours ? apiGasLimit : ours;
}

/**
 * Permit2 approval cap: scheduled total × APPROVAL_DAYS, or the purchase amount
 * itself when a manual buy is larger than that -- otherwise the approve
 * would land below what the swap needs. DECISIONS.md #17.
 */
export function approvalCapFor(dailyAmount: bigint, approvalDays: number, amount: bigint): bigint {
  const dailyCap = dailyAmount * BigInt(approvalDays);
  return amount > dailyCap ? amount : dailyCap;
}

/**
 * The --amount of a manual buy, in human units of the input token. Plain
 * positive decimal only (same shape toBaseUnits accepts): no exponent, no
 * sign, no spaces, not zero. Returned unchanged.
 */
export function parseManualAmount(raw: string | undefined): string {
  if (raw === undefined || !/^[0-9]+(\.[0-9]+)?$/.test(raw) || !/[1-9]/.test(raw)) {
    throw new ValidationError([`--amount: "${raw ?? ""}" must be a positive decimal, e.g. --amount 20`]);
  }
  return raw;
}

/** Ceiling for `npm run approve`, in input-token units. Never unlimited (F12). */
export const MAX_APPROVE_AMOUNT = "100000";

/** The amount of a manual Permit2 approve: a manual-amount decimal, capped at MAX_APPROVE_AMOUNT. */
export function parseApproveAmount(raw: string | undefined): string {
  const amount = parseManualAmount(raw);
  if (toBaseUnits(amount, AMOUNT_DECIMALS) > toBaseUnits(MAX_APPROVE_AMOUNT, AMOUNT_DECIMALS)) {
    throw new ValidationError([`approve amount ${amount} is above the ceiling ${MAX_APPROVE_AMOUNT}`]);
  }
  return amount;
}

// ============================================================
// assertOutputTransfer -- BTC at the destination, verified in the receipt (README.md: How it works)
// ============================================================

const TRANSFER_EVENT_ABI = [
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
] as const;

export interface ReceiptLog {
  address: string;
  topics: readonly `0x${string}`[];
  data: `0x${string}`;
}

export interface OutputExpectation {
  tokenOut: string;
  recipient: string;
  minimumAmount: bigint;
}

/**
 * Sums the tokenOut Transfers to the recipient and requires >= minimumAmount.
 * Any tokenOut Transfer ending at an address other than the recipient or
 * one of `intermediaries` (the Universal Router: pool -> router -> SWEEP to
 * the recipient) is rejected -- WBTC leaving to a third party is exactly
 * what must not pass.
 */
export function assertOutputTransfer(
  logs: readonly ReceiptLog[],
  expect: OutputExpectation,
  intermediaries: readonly string[] = []
): bigint {
  const problems: string[] = [];
  const events = parseEventLogs({
    abi: TRANSFER_EVENT_ABI,
    logs: logs.map((l) => ({ ...l, topics: [...l.topics] })) as never,
    strict: false,
  });

  let received = 0n;
  for (const ev of events) {
    if (!addressEquals(ev.address, expect.tokenOut)) continue;
    const { to, value } = ev.args as { to?: string; value?: bigint };
    if (to === undefined || value === undefined) continue;
    if (addressEquals(to, expect.recipient)) {
      received += value;
    } else if (!intermediaries.some((a) => addressEquals(a, to))) {
      problems.push(`WBTC transferred to ${getAddress(to)}, which is not the recipient`);
    }
  }

  if (received === 0n) {
    problems.push(`no Transfer of ${expect.tokenOut} to the recipient ${expect.recipient}`);
  } else if (received < expect.minimumAmount) {
    problems.push(`received ${received} below minimumAmount (${expect.minimumAmount})`);
  }
  if (problems.length > 0) fail(problems);
  return received;
}

// ============================================================
// decideRecovery -- after a BROADCAST (README.md invariant #4)
// ============================================================

/** Slack over the deadline for local clock vs block timestamp. */
export const RECOVERY_GRACE_SECONDS = 120;

export type RecoveryAction = "FINALIZE" | "FAILED_NONCE_CONSUMED" | "WAIT" | "FAILED_EXPIRED";

/**
 * Never returns "resend". With a receipt: finalize. No receipt and nonce
 * already consumed: another tx took the nonce, ours can no longer land. No
 * receipt and nonce free: the tx can still land until the deadline
 * (guaranteed by assertSwapTx) -- wait; past deadline + slack, it would only revert.
 */
export function decideRecovery(input: {
  hasReceipt: boolean;
  latestNonce: number;
  recordedNonce: number;
  nowSeconds: number;
  deadline: number;
}): RecoveryAction {
  if (input.hasReceipt) return "FINALIZE";
  if (input.latestNonce > input.recordedNonce) return "FAILED_NONCE_CONSUMED";
  if (input.nowSeconds <= input.deadline + RECOVERY_GRACE_SECONDS) return "WAIT";
  return "FAILED_EXPIRED";
}

// ============================================================
// strategies (F1b) -- several budgets summed into one swap per day,
// the result split back per strategy. DECISIONS.md #20.
// ============================================================

/** Cap on one scheduled swap (the sum of active strategies), in input-token units. */
export const MAX_RUN_TOTAL = "1000";
/** Strategy amounts are validated and summed at USDT0 precision. */
export const AMOUNT_DECIMALS = 6;

const MAX_LABEL_LENGTH = 40;

export interface StrategyInput {
  label?: string | null;
  amount?: string;
  endDate?: string | null;
  maxTotal?: string | null;
}

export function amountToUnits(amount: string): bigint {
  return toBaseUnits(amount, AMOUNT_DECIMALS);
}

function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Validates strategy create/PATCH data; unknown keys are left to their own handlers. */
export function parseStrategyInput(raw: Record<string, unknown>, todayUtc: string, mode: "create" | "update"): StrategyInput {
  const problems: string[] = [];
  const out: StrategyInput = {};

  if ("label" in raw || mode === "create") {
    const label = raw.label ?? null;
    if (label !== null && typeof label !== "string") problems.push("label: must be text");
    else if (label === null || label.trim() === "") out.label = null;
    else if (label.trim().length > MAX_LABEL_LENGTH) problems.push(`label: at most ${MAX_LABEL_LENGTH} characters`);
    else if (/[\u0000-\u001f\u007f]/.test(label)) problems.push("label: no line breaks or control characters");
    else out.label = label.trim();
  }

  if ("amount" in raw || mode === "create") {
    const amount = raw.amount;
    const pattern = new RegExp(`^[0-9]+(\\.[0-9]{1,${AMOUNT_DECIMALS}})?$`);
    if (typeof amount !== "string" || !pattern.test(amount) || amountToUnits(amount) === 0n) {
      problems.push(`amount: must be a positive decimal with at most ${AMOUNT_DECIMALS} decimals, e.g. "10" or "12.5"`);
    } else if (amountToUnits(amount) > amountToUnits(MAX_RUN_TOTAL)) {
      problems.push(`amount: at most ${MAX_RUN_TOTAL}`);
    } else out.amount = amount;
  }

  if ("endDate" in raw || mode === "create") {
    const endDate = raw.endDate ?? null;
    if (endDate === null || endDate === "") out.endDate = null;
    else if (typeof endDate !== "string" || !isRealDate(endDate)) problems.push("endDate: must be a date as YYYY-MM-DD");
    else if (endDate <= todayUtc) problems.push(`endDate: must be after today (${todayUtc}, UTC)`);
    else out.endDate = endDate;
  }

  if ("maxTotal" in raw || mode === "create") {
    const maxTotal = raw.maxTotal ?? null;
    const pattern = new RegExp(`^[0-9]+(\\.[0-9]{1,${AMOUNT_DECIMALS}})?$`);
    if (maxTotal === null || maxTotal === "") out.maxTotal = null;
    else if (typeof maxTotal !== "string" || !pattern.test(maxTotal) || amountToUnits(maxTotal) === 0n) {
      problems.push(`maxTotal: must be a positive decimal with at most ${AMOUNT_DECIMALS} decimals, e.g. "500"`);
    } else out.maxTotal = maxTotal;
  }

  if (problems.length > 0) fail(problems);
  return out;
}

export type LimitReached = "end-date" | "max-total" | null;

/** A strategy buys on its end date and stops after it. */
export function limitReached(s: { endDate: string | null; maxTotalUnits: bigint | null }, investedUnits: bigint, todayUtc: string): LimitReached {
  if (s.endDate !== null && s.endDate < todayUtc) return "end-date";
  if (s.maxTotalUnits !== null && investedUnits >= s.maxTotalUnits) return "max-total";
  return null;
}

/** Full scheduled share or the remaining max-total budget, never below zero. */
export function nextShareUnits(amountUnits: bigint, maxTotalUnits: bigint | null, committedUnits: bigint): bigint {
  if (maxTotalUnits === null) return amountUnits;
  const left = maxTotalUnits - committedUnits;
  return left <= 0n ? 0n : left < amountUnits ? left : amountUnits;
}

/** Sum amounts in USDT0 base units and enforce the per-run cap. */
export function assertRunTotal(amounts: string[]): bigint {
  const total = amounts.reduce((sum, amount) => sum + amountToUnits(amount), 0n);
  if (total > amountToUnits(MAX_RUN_TOTAL)) {
    fail([`total of active strategies ${formatUnits(total, AMOUNT_DECIMALS)} is above the per-run cap of ${MAX_RUN_TOTAL}`]);
  }
  return total;
}

export function formatUnits(value: bigint, decimals: number): string {
  if (decimals === 0) return value.toString();
  const s = value.toString().padStart(decimals + 1, "0");
  return `${s.slice(0, -decimals)}.${s.slice(-decimals)}`;
}

/** Floors proportional parts; assigns the remainder to the largest weight, lowest id on a tie. */
export function splitProportional(total: bigint, weights: { id: number; weight: bigint }[]): Map<number, bigint> {
  if (weights.length === 0 || weights.some((w) => w.weight <= 0n)) fail(["splitProportional: needs at least one positive weight"]);
  if (new Set(weights.map((w) => w.id)).size !== weights.length) fail(["splitProportional: duplicate ids are not allowed"]);
  const sum = weights.reduce((s, w) => s + w.weight, 0n);
  const parts = new Map(weights.map((w) => [w.id, (total * w.weight) / sum]));
  const remainder = total - [...parts.values()].reduce((s, value) => s + value, 0n);
  const largest = [...weights].sort((a, b) => (b.weight > a.weight ? 1 : b.weight < a.weight ? -1 : a.id - b.id))[0]!;
  parts.set(largest.id, parts.get(largest.id)! + remainder);
  return parts;
}

export interface ShareResult {
  strategyId: number;
  amountOut: string;
  gasCostPol: string | null;
  gasCostUsd: string | null;
}

const GAS_POL_DECIMALS = 6;
const GAS_USD_DECIMALS = 4;

/** Splits one confirmed swap's output and gas costs in proportion to input shares. */
export function splitShares(
  amountOut: bigint,
  gasCostPol: string | null,
  gasCostUsd: string | null,
  shares: { strategyId: number; amountIn: bigint }[]
): ShareResult[] {
  const weights = shares.map((share) => ({ id: share.strategyId, weight: share.amountIn }));
  const out = splitProportional(amountOut, weights);
  const pol = gasCostPol === null ? null : splitProportional(toBaseUnits(gasCostPol, GAS_POL_DECIMALS), weights);
  const usd = gasCostUsd === null ? null : splitProportional(toBaseUnits(gasCostUsd, GAS_USD_DECIMALS), weights);
  return shares.map((share) => ({
    strategyId: share.strategyId,
    amountOut: out.get(share.strategyId)!.toString(),
    gasCostPol: pol === null ? null : formatUnits(pol.get(share.strategyId)!, GAS_POL_DECIMALS),
    gasCostUsd: usd === null ? null : formatUnits(usd.get(share.strategyId)!, GAS_USD_DECIMALS),
  }));
}

// ============================================================
// settings (F1c) -- shared by every strategy, edited in the app behind
// TOTP, bounded by caps that live HERE (README.md invariant #5): the server sends
// SETTINGS_CAPS to the frontend for its min/max/step, and validates every
// save with validateSettings regardless. DECISIONS.md #23.
// ============================================================

export interface Settings {
  runTime: string; // HH:MM UTC, quarter hours
  maxSlippagePct: number;
  maxPriceImpactPct: number;
  maxOracleDeviationPct: number;
  approvalDays: number;
  minPolBalance: number;
}

export const SETTINGS_CAPS = {
  maxSlippagePct: { min: 0.01, max: 2, step: 0.01 },
  maxPriceImpactPct: { min: 0.01, max: 3, step: 0.01 },
  maxOracleDeviationPct: { min: 0.01, max: 5, step: 0.01 },
  approvalDays: { min: 1, max: 90, step: 1 },
  minPolBalance: { min: 0, max: 100, step: 0.01 },
  runTimeStepMinutes: 15,
} as const;

const NUMERIC_KEYS = ["maxSlippagePct", "maxPriceImpactPct", "maxOracleDeviationPct", "approvalDays", "minPolBalance"] as const;

export function validateSettings(raw: Record<string, unknown>): Settings {
  const problems: string[] = [];
  const out: Partial<Settings> = {};

  const runTime = raw.runTime;
  if (typeof runTime !== "string" || !/^([01]\d|2[0-3]):(00|15|30|45)$/.test(runTime)) {
    problems.push(`runTime: "${String(runTime)}" must be HH:MM (UTC) on a quarter hour, e.g. "09:15"`);
  } else out.runTime = runTime;

  for (const key of NUMERIC_KEYS) {
    const value = raw[key];
    const cap = SETTINGS_CAPS[key];
    const n = typeof value === "number" ? value : typeof value === "string" && /^-?[0-9]+(\.[0-9]+)?$/.test(value.trim()) ? Number(value) : NaN;
    if (!Number.isFinite(n)) problems.push(`${key}: "${String(value)}" is not a number`);
    else if (key === "approvalDays" && !Number.isInteger(n)) problems.push(`${key}: must be a whole number of days`);
    else if (n < cap.min || n > cap.max) problems.push(`${key}: ${n} outside the allowed range ${cap.min}–${cap.max}`);
    else out[key] = n;
  }

  if (problems.length > 0) fail(problems);
  return out as Settings;
}

/** True once today's run time (UTC) has arrived. The daily lock stops a second buy later in the day. */
export function isDue(nowIso: string, runTime: string): boolean {
  return nowIso.slice(11, 16) >= runTime;
}

// ============================================================
// private key (F1d) -- the ONLY place a key typed into the app is checked.
// The error message never contains the input (README.md invariant #3).
// ============================================================

export function parsePrivateKey(raw: unknown): { key: `0x${string}`; address: `0x${string}` } {
  const problem = "privateKey: must be 64 hex characters (optionally with 0x) -- the value is not shown";
  if (typeof raw !== "string") fail([problem]);
  const trimmed = raw.trim();
  const hex = (trimmed.startsWith("0x") || trimmed.startsWith("0X") ? trimmed.slice(2) : trimmed).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex) || /^0+$/.test(hex)) fail([problem]);
  const key = `0x${hex}` as `0x${string}`;
  try {
    return { key, address: privateKeyToAccount(key).address };
  } catch {
    fail([problem]); // e.g. >= secp256k1 order
  }
}
