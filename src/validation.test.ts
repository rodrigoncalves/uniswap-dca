import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ValidationError,
  parsePrivateKey,
  assertQuote,
  assertPermit,
  assertSwapTx,
  assertApprovalTx,
  toBaseUnits,
  derivePrimaryType,
  computeImpliedPricePerBtc,
  assertOraclePriceWithinDeviation,
  MAX_PERMIT_TTL_SECONDS,
  MAX_ALLOWANCE_EXPIRATION_SECONDS,
  MAX_GAS_LIMIT,
  MAX_ORACLE_AGE_SECONDS,
  needsApproval,
  chooseGasLimit,
  approvalCapFor,
  parseManualAmount,
  parseApproveAmount,
  MAX_APPROVE_AMOUNT,
  assertOutputTransfer,
  decideRecovery,
  RECOVERY_GRACE_SECONDS,
  MAX_SWAP_DEADLINE_SECONDS,
  MAX_RUN_TOTAL,
  AMOUNT_DECIMALS,
  parseStrategyInput,
  amountToUnits,
  assertRunTotal,
  formatUnits,
  splitProportional,
  limitReached,
  nextShareUnits,
  splitShares,
  validateSettings,
  isDue,
  SETTINGS_CAPS,
} from "./validation.js";
import { encodeFunctionData as encodeFn, encodeEventTopics, encodeAbiParameters } from "viem";

// ============================================================ private key (F1d)

const K = "0x" + "11".repeat(32);

test("parsePrivateKey: accepts 0x+64 hex, trims, adds a missing 0x, accepts uppercase; derives the address", () => {
  const a = parsePrivateKey(K);
  assert.equal(a.key, K);
  assert.match(a.address, /^0x[0-9a-fA-F]{40}$/);
  assert.deepEqual(parsePrivateKey(`  ${K}\n`), a);
  assert.deepEqual(parsePrivateKey(K.slice(2)), a);
  assert.equal(parsePrivateKey("0x" + "AB".repeat(32)).key, "0x" + "ab".repeat(32));
});

test("parsePrivateKey: refuses bad shapes, zero, >= curve order -- never echoing the input", () => {
  const bad = [
    "0x" + "1".repeat(63), "0x" + "1".repeat(65), "0x" + "g".repeat(64), "", null, 42,
    "0x" + "0".repeat(64),
    "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141",
  ];
  for (const b of bad) {
    try {
      parsePrivateKey(b);
      assert.fail(`accepted ${String(b).slice(0, 6)}...`);
    } catch (err) {
      assert.ok(err instanceof ValidationError);
      if (typeof b === "string" && b.length > 8) assert.ok(!err.message.includes(b.slice(4, 20)), "message must not echo the key");
    }
  }
});

const USDT0 = "0xc2132D05D31c914a87C6611C10748AEb04B58e8F";
const WBTC = "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const ROUTER1 = "0x1095692A6237d83C6a72F3F5eFEdb9A670C49223";
const ROUTER2 = "0x8B844f885672f333Bc0042cB669255f93a4C1E6b";
const WALLET = "0x000000000000000000000000000000000000000A";
const OTHER_ADDR = "0x000000000000000000000000000000000000dEaD";
const COLD_WALLET = "0x0000000000000000000000000000000000000c11";

function assertRejects(fn: () => unknown, substring: string): void {
  assert.throws(
    fn,
    (err: unknown) => err instanceof ValidationError && err.message.includes(substring),
    `expected ValidationError containing "${substring}"`
  );
}

// ============================================================
// assertQuote
// ============================================================

function baseQuote() {
  return {
    routing: "CLASSIC",
    chainId: 137,
    swapper: WALLET,
    input: { token: USDT0, amount: "200000000" },
    output: { token: WBTC, amount: "232405", recipient: WALLET, minimumAmount: "231245" },
    slippage: 0.5,
    priceImpact: 0.05,
    txFailureReasons: [],
  };
}

function baseQuoteExpectation() {
  return {
    chainId: 137,
    swapperAddress: WALLET,
    tokenIn: USDT0,
    tokenOut: WBTC,
    expectedRecipient: WALLET,
    expectedInputAmount: 200000000n,
    maxSlippagePct: 0.5,
    maxPriceImpactPct: 1.0,
  };
}

test("assertQuote: accepts a valid quote", () => {
  assert.doesNotThrow(() => assertQuote(baseQuote(), baseQuoteExpectation()));
});

test("assertQuote: rejects routing other than CLASSIC (Polygon has no UniswapX)", () => {
  assertRejects(() => assertQuote({ ...baseQuote(), routing: "DUTCH_V2" }, baseQuoteExpectation()), "routing");
});

test("assertQuote: rejects chainId other than 137", () => {
  assertRejects(() => assertQuote({ ...baseQuote(), chainId: 1 }, baseQuoteExpectation()), "chainId");
});

test("assertQuote: rejects swapped tokenIn", () => {
  assertRejects(
    () => assertQuote({ ...baseQuote(), input: { token: WBTC, amount: "200000000" } }, baseQuoteExpectation()),
    "input.token"
  );
});

test("assertQuote: rejects swapped tokenOut", () => {
  assertRejects(
    () =>
      assertQuote(
        { ...baseQuote(), output: { ...baseQuote().output, token: USDT0 } },
        baseQuoteExpectation()
      ),
    "output.token"
  );
});

test("assertQuote: rejects recipient other than expected (does not trust the API echo)", () => {
  assertRejects(
    () =>
      assertQuote(
        { ...baseQuote(), output: { ...baseQuote().output, recipient: OTHER_ADDR } },
        baseQuoteExpectation()
      ),
    "recipient"
  );
});

test("assertQuote: accepts recipient == cold wallet when configured", () => {
  const quote = { ...baseQuote(), output: { ...baseQuote().output, recipient: COLD_WALLET } };
  const expectation = { ...baseQuoteExpectation(), expectedRecipient: COLD_WALLET };
  assert.doesNotThrow(() => assertQuote(quote, expectation));
});

test("assertQuote: rejects input amount other than expected", () => {
  assertRejects(
    () => assertQuote({ ...baseQuote(), input: { ...baseQuote().input, amount: "999999999" } }, baseQuoteExpectation()),
    "input.amount"
  );
});

test("assertQuote: rejects slippage above the cap", () => {
  assertRejects(() => assertQuote({ ...baseQuote(), slippage: 5 }, baseQuoteExpectation()), "slippage");
});

test("assertQuote: rejects priceImpact above the cap", () => {
  assertRejects(() => assertQuote({ ...baseQuote(), priceImpact: 10 }, baseQuoteExpectation()), "priceImpact");
});

test("assertQuote: rejects when txFailureReasons is not empty (the API's own simulation already failed)", () => {
  assertRejects(
    () => assertQuote({ ...baseQuote(), txFailureReasons: ["SIMULATION_ERROR"] }, baseQuoteExpectation()),
    "txFailureReasons"
  );
});

test("assertQuote: rejects minimumAmount <= 0", () => {
  assertRejects(
    () => assertQuote({ ...baseQuote(), output: { ...baseQuote().output, minimumAmount: "0" } }, baseQuoteExpectation()),
    "minimumAmount"
  );
});

test("assertQuote: rejects swapper other than the wallet", () => {
  assertRejects(() => assertQuote({ ...baseQuote(), swapper: OTHER_ADDR }, baseQuoteExpectation()), "swapper");
});

// ============================================================
// assertPermit -- AllowanceTransfer (PermitSingle) and SignatureTransfer
// ============================================================

const NOW = 1_800_000_000; // seconds, fixed for tests -- never Date.now() inside validation.ts

function allowanceTransferPermit(overrides: Record<string, unknown> = {}) {
  return {
    domain: { chainId: 137, verifyingContract: PERMIT2 },
    types: {
      PermitSingle: [
        { name: "details", type: "PermitDetails" },
        { name: "spender", type: "address" },
        { name: "sigDeadline", type: "uint256" },
      ],
      PermitDetails: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint160" },
        { name: "expiration", type: "uint48" },
        { name: "nonce", type: "uint48" },
      ],
    },
    values: {
      details: { token: USDT0, amount: "200000000", expiration: String(NOW + 1800), nonce: "0" },
      spender: ROUTER1,
      sigDeadline: String(NOW + 1800),
      ...overrides,
    },
  };
}

function basePermitExpectation() {
  return {
    chainId: 137,
    tokenIn: USDT0,
    expectedAmount: 200000000n,
    allowedSpenders: [ROUTER1, ROUTER2] as readonly string[],
    maxSignatureTtlSeconds: MAX_PERMIT_TTL_SECONDS,
    maxAllowanceExpirationSeconds: MAX_ALLOWANCE_EXPIRATION_SECONDS,
    nowSeconds: NOW,
  };
}

test("assertPermit: accepts a valid AllowanceTransfer message", () => {
  assert.doesNotThrow(() => assertPermit(allowanceTransferPermit(), basePermitExpectation()));
});

test("assertPermit: rejects wrong chainId in the domain", () => {
  const permit = allowanceTransferPermit();
  permit.domain = { ...permit.domain, chainId: 1 };
  assertRejects(() => assertPermit(permit, basePermitExpectation()), "chainId");
});

test("assertPermit: rejects verifyingContract other than Permit2", () => {
  const permit = allowanceTransferPermit();
  permit.domain = { ...permit.domain, verifyingContract: OTHER_ADDR };
  assertRejects(() => assertPermit(permit, basePermitExpectation()), "verifyingContract");
});

test("assertPermit: rejects token other than expected", () => {
  const permit = allowanceTransferPermit({ details: { token: WBTC, amount: "200000000", expiration: String(NOW + 1800), nonce: "0" } });
  assertRejects(() => assertPermit(permit, basePermitExpectation()), "token");
});

test("assertPermit: rejects amount other than the exact expected (permitAmount=EXACT, not '<=cap')", () => {
  const permit = allowanceTransferPermit({ details: { token: USDT0, amount: "999999999", expiration: String(NOW + 1800), nonce: "0" } });
  assertRejects(() => assertPermit(permit, basePermitExpectation()), "amount");
});

test("assertPermit: rejects spender outside the allowlist", () => {
  const permit = allowanceTransferPermit({ spender: OTHER_ADDR });
  assertRejects(() => assertPermit(permit, basePermitExpectation()), "spender");
});

test("assertPermit: rejects sigDeadline in the past", () => {
  const permit = allowanceTransferPermit({ sigDeadline: String(NOW - 10) });
  assertRejects(() => assertPermit(permit, basePermitExpectation()), "sigDeadline");
});

test("assertPermit: rejects sigDeadline too far in the future (TTL)", () => {
  const permit = allowanceTransferPermit({ sigDeadline: String(NOW + MAX_PERMIT_TTL_SECONDS + 1000) });
  assertRejects(() => assertPermit(permit, basePermitExpectation()), "sigDeadline");
});

test("assertPermit: accepts ~30-day expiration -- the real API default (found testing against production, not guessed)", () => {
  // A real /quote call on 2026-09-22 returned expiration exactly ~30 days
  // out. MAX_PERMIT_TTL_SECONDS (1h) does NOT apply to this field -- they
  // are different properties (see the comment in validation.ts).
  const thirtyDays = 30 * 86400;
  const permit = allowanceTransferPermit({
    details: { token: USDT0, amount: "200000000", expiration: String(NOW + thirtyDays), nonce: "0" },
  });
  assert.doesNotThrow(() => assertPermit(permit, basePermitExpectation()));
});

test("assertPermit: rejects expiration (allowance) beyond the MAX_ALLOWANCE_EXPIRATION_SECONDS cap", () => {
  const permit = allowanceTransferPermit({
    details: { token: USDT0, amount: "200000000", expiration: String(NOW + MAX_ALLOWANCE_EXPIRATION_SECONDS + 1000), nonce: "0" },
  });
  assertRejects(() => assertPermit(permit, basePermitExpectation()), "expiration");
});

function signatureTransferPermit(overrides: Record<string, unknown> = {}) {
  return {
    domain: { chainId: 137, verifyingContract: PERMIT2 },
    types: {
      PermitTransferFrom: [
        { name: "permitted", type: "TokenPermissions" },
        { name: "spender", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
      TokenPermissions: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint256" },
      ],
    },
    values: {
      permitted: { token: USDT0, amount: "200000000" },
      spender: ROUTER1,
      nonce: "0",
      deadline: String(NOW + 1800),
      ...overrides,
    },
  };
}

test("assertPermit: accepts a valid SignatureTransfer message (second shape)", () => {
  assert.doesNotThrow(() => assertPermit(signatureTransferPermit(), basePermitExpectation()));
});

test("assertPermit: rejects deadline in the past (SignatureTransfer)", () => {
  const permit = signatureTransferPermit({ deadline: String(NOW - 10) });
  assertRejects(() => assertPermit(permit, basePermitExpectation()), "deadline");
});

test("assertPermit: rejects unknown permit format (neither details nor permitted)", () => {
  const permit = allowanceTransferPermit();
  // @ts-expect-error -- deliberately building an invalid shape
  permit.values = { spender: ROUTER1, sigDeadline: String(NOW + 1800) };
  assertRejects(() => assertPermit(permit, basePermitExpectation()), "format");
});

// ============================================================
// assertSwapTx
// ============================================================

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
const SWAP_DEADLINE = 1_790_000_000;

function executeCalldata(deadline: number): `0x${string}` {
  return encodeFn({ abi: UR_EXECUTE_ABI, functionName: "execute", args: ["0x0a0004", ["0x1234"], BigInt(deadline)] });
}

function baseSwapTx() {
  return {
    to: ROUTER1,
    from: WALLET,
    data: executeCalldata(SWAP_DEADLINE),
    value: "0",
    chainId: 137,
    gasLimit: "300000",
  };
}

function baseSwapExpectation() {
  return {
    chainId: 137,
    fromAddress: WALLET,
    allowedTo: [ROUTER1, ROUTER2] as readonly string[],
    maxGasLimit: MAX_GAS_LIMIT,
    maxDeadline: SWAP_DEADLINE,
  };
}

test("assertSwapTx: rejects calldata that is not execute(bytes,bytes[],uint256)", () => {
  assertRejects(() => assertSwapTx({ ...baseSwapTx(), data: "0x1234abcd" }, baseSwapExpectation()), "execute");
});

test("assertSwapTx: rejects deadline beyond the requested one (recovery depends on it)", () => {
  assertRejects(
    () => assertSwapTx({ ...baseSwapTx(), data: executeCalldata(SWAP_DEADLINE + 1) }, baseSwapExpectation()),
    "deadline"
  );
});

test("assertSwapTx: returns the deadline decoded from calldata (the API ignores the deadline requested on /swap)", () => {
  assert.equal(assertSwapTx({ ...baseSwapTx(), data: executeCalldata(SWAP_DEADLINE - 60) }, baseSwapExpectation()), SWAP_DEADLINE - 60);
});

test("MAX_SWAP_DEADLINE_SECONDS: covers the ~30 min observed on the real API, without becoming 'no cap'", () => {
  assert.ok(MAX_SWAP_DEADLINE_SECONDS >= 1800 && MAX_SWAP_DEADLINE_SECONDS <= 3600);
});

test("assertSwapTx: accepts deadline earlier than requested", () => {
  assert.doesNotThrow(() => assertSwapTx({ ...baseSwapTx(), data: executeCalldata(SWAP_DEADLINE - 60) }, baseSwapExpectation()));
});

test("assertSwapTx: accepts a valid tx", () => {
  assert.doesNotThrow(() => assertSwapTx(baseSwapTx(), baseSwapExpectation()));
});

test("assertSwapTx: rejects to outside the allowlist", () => {
  assertRejects(() => assertSwapTx({ ...baseSwapTx(), to: OTHER_ADDR }, baseSwapExpectation()), "to");
});

test("assertSwapTx: rejects wrong chainId", () => {
  assertRejects(() => assertSwapTx({ ...baseSwapTx(), chainId: 1 }, baseSwapExpectation()), "chainId");
});

test("assertSwapTx: rejects from other than the wallet", () => {
  assertRejects(() => assertSwapTx({ ...baseSwapTx(), from: OTHER_ADDR }, baseSwapExpectation()), "from");
});

test("assertSwapTx: rejects empty data", () => {
  assertRejects(() => assertSwapTx({ ...baseSwapTx(), data: "0x" }, baseSwapExpectation()), "data");
});

test("assertSwapTx: rejects value != '0' (input is ERC-20, must not send POL)", () => {
  assertRejects(() => assertSwapTx({ ...baseSwapTx(), value: "1000" }, baseSwapExpectation()), "value");
});

test("assertSwapTx: accepts zero value in hex (real API format: \"0x00\")", () => {
  assert.doesNotThrow(() => assertSwapTx({ ...baseSwapTx(), value: "0x00" }, baseSwapExpectation()));
});

test("assertSwapTx: rejects non-zero hex value", () => {
  assertRejects(() => assertSwapTx({ ...baseSwapTx(), value: "0x01" }, baseSwapExpectation()), "value");
});

test("assertSwapTx: rejects non-integer value", () => {
  assertRejects(() => assertSwapTx({ ...baseSwapTx(), value: "abc" }, baseSwapExpectation()), "value");
  assertRejects(() => assertSwapTx({ ...baseSwapTx(), value: "" }, baseSwapExpectation()), "value");
});

test("assertApprovalTx: accepts zero value in hex", () => {
  assert.doesNotThrow(() => assertApprovalTx({ ...baseApprovalTx(), value: "0x0" }, baseApprovalExpectation()));
});

test("assertSwapTx: rejects maxFeePerGas and gasPrice together", () => {
  assertRejects(
    () => assertSwapTx({ ...baseSwapTx(), maxFeePerGas: "100", gasPrice: "100" }, baseSwapExpectation()),
    "gasPrice"
  );
});

test("assertSwapTx: rejects gasLimit above the cap", () => {
  assertRejects(
    () => assertSwapTx({ ...baseSwapTx(), gasLimit: (MAX_GAS_LIMIT + 1n).toString() }, baseSwapExpectation()),
    "gasLimit"
  );
});

test("assertSwapTx: accepts missing gasLimit (wallet.ts estimates later)", () => {
  const { gasLimit, ...rest } = baseSwapTx();
  void gasLimit;
  assert.doesNotThrow(() => assertSwapTx(rest, baseSwapExpectation()));
});

// ============================================================
// assertApprovalTx -- 'to' is the TOKEN, not Permit2. Easy to invert.
// ============================================================

import { encodeFunctionData } from "viem";

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

function approveCalldata(spender: string, amount: bigint): `0x${string}` {
  return encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: "approve", args: [spender as `0x${string}`, amount] });
}

function baseApprovalTx() {
  return {
    to: USDT0, // the TOKEN, not Permit2
    from: WALLET,
    data: approveCalldata(PERMIT2, 6000000000n),
    value: "0",
    chainId: 137,
  };
}

function baseApprovalExpectation() {
  return {
    chainId: 137,
    fromAddress: WALLET,
    tokenAddress: USDT0,
    expectedSpender: PERMIT2,
    maxAmount: 6000000000n, // cap = dcaAmount * approvalDays
  };
}

test("assertApprovalTx: accepts a valid approval", () => {
  assert.doesNotThrow(() => assertApprovalTx(baseApprovalTx(), baseApprovalExpectation()));
});

test("assertApprovalTx: rejects 'to' other than the token (e.g. someone passed Permit2 by mistake)", () => {
  assertRejects(() => assertApprovalTx({ ...baseApprovalTx(), to: PERMIT2 }, baseApprovalExpectation()), "to");
});

test("assertApprovalTx: rejects decoded spender other than Permit2", () => {
  const tx = { ...baseApprovalTx(), data: approveCalldata(OTHER_ADDR, 6000000000n) };
  assertRejects(() => assertApprovalTx(tx, baseApprovalExpectation()), "spender");
});

test("assertApprovalTx: rejects decoded amount above the cap", () => {
  const tx = { ...baseApprovalTx(), data: approveCalldata(PERMIT2, 999999999999n) };
  assertRejects(() => assertApprovalTx(tx, baseApprovalExpectation()), "amount");
});

test("assertApprovalTx: rejects calldata that is not approve (wrong selector)", () => {
  const tx = { ...baseApprovalTx(), data: "0xdeadbeef" as `0x${string}` };
  assertRejects(() => assertApprovalTx(tx, baseApprovalExpectation()), "approve");
});

// ============================================================
// toBaseUnits
// ============================================================

test("toBaseUnits: converts a plain integer", () => {
  assert.equal(toBaseUnits("200", 6), 200000000n);
});

test("toBaseUnits: converts a decimal", () => {
  assert.equal(toBaseUnits("0.5", 6), 500000n);
});

test("toBaseUnits: rejects more decimal places than the token supports (silent precision loss)", () => {
  assert.throws(() => toBaseUnits("200.1234567", 6));
});

test("toBaseUnits: zero decimal places given still works", () => {
  assert.equal(toBaseUnits("5", 8), 500000000n);
});

// ============================================================
// derivePrimaryType
// ============================================================

test("derivePrimaryType: finds PermitSingle (AllowanceTransfer), ignoring referenced PermitDetails", () => {
  assert.equal(derivePrimaryType(allowanceTransferPermit().types), "PermitSingle");
});

test("derivePrimaryType: finds PermitTransferFrom (SignatureTransfer), ignoring referenced TokenPermissions", () => {
  assert.equal(derivePrimaryType(signatureTransferPermit().types), "PermitTransferFrom");
});

test("derivePrimaryType: ignores EIP712Domain even if present in the types map", () => {
  const types = { ...allowanceTransferPermit().types, EIP712Domain: [{ name: "name", type: "string" }] };
  assert.equal(derivePrimaryType(types), "PermitSingle");
});

test("derivePrimaryType: throws unless there is exactly one candidate (ambiguous)", () => {
  assert.throws(() => derivePrimaryType({ A: [{ name: "x", type: "uint256" }], B: [{ name: "y", type: "uint256" }] }));
});

// ============================================================
// oracle: computeImpliedPricePerBtc + assertOraclePriceWithinDeviation
// ============================================================

test("computeImpliedPricePerBtc: computes the USDT0-per-BTC price from base units", () => {
  // 200 USDT0 (6 dec) for 0.00232 WBTC (8 dec) -> ~86206 USDT0/BTC
  const price = computeImpliedPricePerBtc({
    amountInBaseUnits: 200000000n,
    amountOutBaseUnits: 232000n,
    decimalsIn: 6,
    decimalsOut: 8,
  });
  assert.ok(Math.abs(price - 86206.9) < 1, `expected ~86206.9, got ${price}`);
});

function baseOracleInput() {
  return {
    amountInBaseUnits: 200000000n,
    amountOutBaseUnits: 232405n,
    decimalsIn: 6,
    decimalsOut: 8,
    btcUsd: 86022.315,
    usdtUsd: 1.00013,
    maxDeviationPct: 2.0,
    btcUsdUpdatedAt: NOW - 30,
    usdtUsdUpdatedAt: NOW - 30,
    maxOracleAgeSeconds: MAX_ORACLE_AGE_SECONDS,
    nowSeconds: NOW,
  };
}

test("assertOraclePriceWithinDeviation: accepts price within tolerance", () => {
  assert.doesNotThrow(() => assertOraclePriceWithinDeviation(baseOracleInput()));
});

test("assertOraclePriceWithinDeviation: rejects price deviation above the cap", () => {
  const input = { ...baseOracleInput(), amountOutBaseUnits: 400000n }; // implied price well below the oracle
  assertRejects(() => assertOraclePriceWithinDeviation(input), "deviation");
});

test("assertOraclePriceWithinDeviation: rejects stale BTC/USD feed", () => {
  const input = { ...baseOracleInput(), btcUsdUpdatedAt: NOW - MAX_ORACLE_AGE_SECONDS - 100 };
  assertRejects(() => assertOraclePriceWithinDeviation(input), "stale");
});

test("assertOraclePriceWithinDeviation: rejects stale USDT/USD feed", () => {
  const input = { ...baseOracleInput(), usdtUsdUpdatedAt: NOW - MAX_ORACLE_AGE_SECONDS - 100 };
  assertRejects(() => assertOraclePriceWithinDeviation(input), "stale");
});

// ============================================================
// extra robustness -- malformed API data must not crash raw
// ============================================================

test("assertQuote: rejects non-numeric input.amount without crashing raw", () => {
  assertRejects(
    () => assertQuote({ ...baseQuote(), input: { ...baseQuote().input, amount: "abc" } }, baseQuoteExpectation()),
    "input.amount"
  );
});

test("assertPermit: rejects non-numeric amount without crashing raw", () => {
  const permit = allowanceTransferPermit({ details: { token: USDT0, amount: "abc", expiration: String(NOW + 1800), nonce: "0" } });
  assertRejects(() => assertPermit(permit, basePermitExpectation()), "amount");
});

test("assertOraclePriceWithinDeviation: rejects btcUsd <= 0 (anomalous feed print)", () => {
  const input = { ...baseOracleInput(), btcUsd: 0 };
  assertRejects(() => assertOraclePriceWithinDeviation(input), "btcUsd");
});

test("assertOraclePriceWithinDeviation: rejects usdtUsd <= 0 (anomalous feed print)", () => {
  const input = { ...baseOracleInput(), usdtUsd: -1 };
  assertRejects(() => assertOraclePriceWithinDeviation(input), "usdtUsd");
});

// ============================================================
// needsApproval
// ============================================================

test("needsApproval: allowance between the day amount and the cap -- not needed", () => {
  assert.equal(needsApproval(500n, 100n, 1000n), false);
  assert.equal(needsApproval(100n, 100n, 1000n), false);
  assert.equal(needsApproval(1000n, 100n, 1000n), false);
});

test("needsApproval: allowance below the day amount -- needed", () => {
  assert.equal(needsApproval(99n, 100n, 1000n), true);
  assert.equal(needsApproval(0n, 100n, 1000n), true);
});

test("needsApproval: allowance above the cap (e.g. unlimited) -- needed, to shrink it", () => {
  assert.equal(needsApproval(2n ** 256n - 1n, 100n, 1000n), true);
});

// ============================================================
// chooseGasLimit
// ============================================================

test("chooseGasLimit: API limit below our estimate + 20% -- uses ours (real fork case: 126100 vs 212433)", () => {
  assert.equal(chooseGasLimit(126_100n, 212_433n), 254_919n);
});

test("chooseGasLimit: API limit above our estimate + 20% -- keeps the API's", () => {
  assert.equal(chooseGasLimit(400_000n, 259_120n), 400_000n);
});

test("chooseGasLimit: no API limit -- our estimate + 20%", () => {
  assert.equal(chooseGasLimit(null, 100_000n), 120_000n);
});

// ============================================================
// assertOutputTransfer
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

function transferLog(token: string, from: string, to: string, value: bigint) {
  return {
    address: token,
    topics: encodeEventTopics({
      abi: TRANSFER_EVENT_ABI,
      eventName: "Transfer",
      args: { from: from as `0x${string}`, to: to as `0x${string}` },
    }) as `0x${string}`[],
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
  };
}

const OUT_EXPECT = { tokenOut: WBTC, recipient: COLD_WALLET, minimumAmount: 10000n };

test("assertOutputTransfer: returns the WBTC Transfer amount to the recipient", () => {
  const logs = [transferLog(USDT0, WALLET, ROUTER1, 10000000n), transferLog(WBTC, ROUTER1, COLD_WALLET, 11745n)];
  assert.equal(assertOutputTransfer(logs, OUT_EXPECT), 11745n);
});

test("assertOutputTransfer: recipient comparison is case-insensitive", () => {
  const logs = [transferLog(WBTC, ROUTER1, COLD_WALLET, 11745n)];
  assert.equal(assertOutputTransfer(logs, { ...OUT_EXPECT, recipient: COLD_WALLET.toLowerCase() }), 11745n);
});

test("assertOutputTransfer: rejects when WBTC went to another address", () => {
  const logs = [transferLog(WBTC, ROUTER1, OTHER_ADDR, 11745n)];
  assertRejects(() => assertOutputTransfer(logs, OUT_EXPECT), "recipient");
});

test("assertOutputTransfer: ignores Transfer of another token to the recipient", () => {
  const logs = [transferLog(USDT0, ROUTER1, COLD_WALLET, 11745n)];
  assertRejects(() => assertOutputTransfer(logs, OUT_EXPECT), "recipient");
});

test("assertOutputTransfer: rejects amount below minimumAmount", () => {
  const logs = [transferLog(WBTC, ROUTER1, COLD_WALLET, 9999n)];
  assertRejects(() => assertOutputTransfer(logs, OUT_EXPECT), "minimumAmount");
});

test("assertOutputTransfer: rejects WBTC leaving to a third party besides the recipient", () => {
  const logs = [transferLog(WBTC, ROUTER1, COLD_WALLET, 11745n), transferLog(WBTC, ROUTER1, OTHER_ADDR, 5n)];
  assertRejects(() => assertOutputTransfer(logs, OUT_EXPECT), OTHER_ADDR);
});

// ============================================================
// decideRecovery -- never returns "resend"; only finalize, wait or fail
// ============================================================

const REC = { recordedNonce: 7, deadline: 1_790_000_000 };

test("decideRecovery: with receipt, finalizes (regardless of the rest)", () => {
  assert.equal(decideRecovery({ ...REC, hasReceipt: true, latestNonce: 8, nowSeconds: REC.deadline + 99999 }), "FINALIZE");
});

test("decideRecovery: no receipt and nonce consumed -- another tx used the nonce", () => {
  assert.equal(decideRecovery({ ...REC, hasReceipt: false, latestNonce: 8, nowSeconds: REC.deadline - 10 }), "FAILED_NONCE_CONSUMED");
});

test("decideRecovery: no receipt, nonce free, before deadline + slack -- waits", () => {
  assert.equal(decideRecovery({ ...REC, hasReceipt: false, latestNonce: 7, nowSeconds: REC.deadline }), "WAIT");
  assert.equal(
    decideRecovery({ ...REC, hasReceipt: false, latestNonce: 7, nowSeconds: REC.deadline + RECOVERY_GRACE_SECONDS }),
    "WAIT"
  );
});

test("decideRecovery: no receipt, nonce free, after deadline + slack -- can no longer execute", () => {
  assert.equal(
    decideRecovery({ ...REC, hasReceipt: false, latestNonce: 7, nowSeconds: REC.deadline + RECOVERY_GRACE_SECONDS + 1 }),
    "FAILED_EXPIRED"
  );
});

test("assertOutputTransfer: hop through the Universal Router (pool -> router -> SWEEP) is accepted as intermediary", () => {
  const logs = [transferLog(WBTC, OTHER_ADDR, ROUTER1, 11745n), transferLog(WBTC, ROUTER1, COLD_WALLET, 11745n)];
  assertRejects(() => assertOutputTransfer(logs, OUT_EXPECT), "is not the recipient");
  assert.equal(assertOutputTransfer(logs, OUT_EXPECT, [ROUTER1]), 11745n);
});

// ============================================================
// manual purchases (DECISIONS.md #17)
// ============================================================

test("approvalCapFor: the daily cap when the amount fits in it", () => {
  assert.equal(approvalCapFor(10n, 30, 20n), 300n);
});

test("approvalCapFor: a manual amount above the daily cap raises the cap to that amount", () => {
  assert.equal(approvalCapFor(10n, 30, 500n), 500n);
});

test("parseManualAmount: accepts positive decimals, returns them unchanged", () => {
  assert.equal(parseManualAmount("20"), "20");
  assert.equal(parseManualAmount("0.5"), "0.5");
});

test("parseManualAmount: refuses missing, zero, negative, exponent and non-numeric", () => {
  for (const bad of [undefined, "", "0", "0.0", "-5", "1e3", "abc", " 20"]) {
    assert.throws(() => parseManualAmount(bad), ValidationError, String(bad));
  }
});

test("parseApproveAmount: accepts a positive decimal up to the ceiling", () => {
  assert.equal(parseApproveAmount("500"), "500");
  assert.equal(parseApproveAmount(MAX_APPROVE_AMOUNT), MAX_APPROVE_AMOUNT);
});

test("parseApproveAmount: refuses above the ceiling and malformed values", () => {
  for (const bad of [undefined, "0", "-1", "1e3", "abc", "100000.01", "1000000"]) {
    assert.throws(() => parseApproveAmount(bad), ValidationError, String(bad));
  }
});

// ============================================================ strategies (F1b)

test("parseStrategyInput: create with amount only -> label and endDate null", () => {
  assert.deepEqual(parseStrategyInput({ amount: "10" }, "2026-09-24", "create"), { label: null, amount: "10", endDate: null, maxTotal: null });
});

test("parseStrategyInput: create needs an amount", () => {
  assertRejects(() => parseStrategyInput({ label: "x" }, "2026-09-24", "create"), "amount");
});

test("parseStrategyInput: label trimmed, empty -> null, max 40, no control characters", () => {
  assert.equal(parseStrategyInput({ amount: "1", label: "  Isabela Aug/26  " }, "2026-09-24", "create").label, "Isabela Aug/26");
  assert.equal(parseStrategyInput({ amount: "1", label: "   " }, "2026-09-24", "create").label, null);
  assertRejects(() => parseStrategyInput({ amount: "1", label: "x".repeat(41) }, "2026-09-24", "create"), "40");
  assertRejects(() => parseStrategyInput({ amount: "1", label: "a\nb" }, "2026-09-24", "create"), "label");
  assertRejects(() => parseStrategyInput({ amount: "1", label: 5 }, "2026-09-24", "create"), "label");
});

test("parseStrategyInput: amount is a positive decimal string, <= 6 decimals, <= MAX_RUN_TOTAL", () => {
  for (const good of ["0.000001", "10", "999.5", MAX_RUN_TOTAL]) {
    assert.equal(parseStrategyInput({ amount: good }, "2026-09-24", "create").amount, good);
  }
  for (const bad of ["0", "0.0", "-1", "1e3", "10.1234567", "1000.000001", "", " 10", 10, null]) {
    assertRejects(() => parseStrategyInput({ amount: bad }, "2026-09-24", "create"), "amount");
  }
});

test("parseStrategyInput: endDate strictly after today; empty or null clears it; bad dates refused", () => {
  assert.equal(parseStrategyInput({ amount: "1", endDate: "2026-09-25" }, "2026-09-24", "create").endDate, "2026-09-25");
  assertRejects(() => parseStrategyInput({ amount: "1", endDate: "2026-09-24" }, "2026-09-24", "create"), "endDate");
  assertRejects(() => parseStrategyInput({ endDate: "2026-09-24" }, "2026-09-24", "update"), "endDate");
  assert.equal(parseStrategyInput({ endDate: "" }, "2026-09-24", "update").endDate, null);
  assert.equal(parseStrategyInput({ endDate: null }, "2026-09-24", "update").endDate, null);
  assertRejects(() => parseStrategyInput({ amount: "1", endDate: "2026-09-23" }, "2026-09-24", "create"), "endDate");
  assertRejects(() => parseStrategyInput({ amount: "1", endDate: "2026-02-30" }, "2026-09-24", "create"), "endDate");
  assertRejects(() => parseStrategyInput({ amount: "1", endDate: "24/09/2026" }, "2026-09-24", "create"), "endDate");
});

test("parseStrategyInput: update returns only the keys sent; unknown keys ignored", () => {
  assert.deepEqual(parseStrategyInput({ amount: "5", status: "stopped", totp: "123456" }, "2026-09-24", "update"), { amount: "5" });
  assert.deepEqual(parseStrategyInput({}, "2026-09-24", "update"), {});
});

test("parseStrategyInput: maxTotal optional positive decimal; empty clears; no upper bound", () => {
  assert.equal(parseStrategyInput({ amount: "1" }, "2026-09-24", "create").maxTotal, null);
  assert.equal(parseStrategyInput({ amount: "1", maxTotal: "5000" }, "2026-09-24", "create").maxTotal, "5000");
  assert.equal(parseStrategyInput({ maxTotal: "" }, "2026-09-24", "update").maxTotal, null);
  for (const bad of ["0", "-5", "1e3", "1.1234567", 100]) {
    assertRejects(() => parseStrategyInput({ amount: "1", maxTotal: bad }, "2026-09-24", "create"), "maxTotal");
  }
});

test("limitReached: end date before today, or invested >= max total; neither -> null", () => {
  assert.equal(limitReached({ endDate: "2026-09-24", maxTotalUnits: null }, 0n, "2026-09-24"), null, "buys on its end date");
  assert.equal(limitReached({ endDate: "2026-09-23", maxTotalUnits: null }, 0n, "2026-09-24"), "end-date");
  assert.equal(limitReached({ endDate: null, maxTotalUnits: 15_000_000n }, 14_999_999n, "2026-09-24"), null);
  assert.equal(limitReached({ endDate: null, maxTotalUnits: 15_000_000n }, 15_000_000n, "2026-09-24"), "max-total");
  assert.equal(limitReached({ endDate: null, maxTotalUnits: null }, 10n ** 18n, "2026-09-24"), null);
});

test("nextShareUnits: full amount while the budget allows, remainder at the end, 0 when spent", () => {
  assert.equal(nextShareUnits(10_000_000n, null, 999_000_000n), 10_000_000n);
  assert.equal(nextShareUnits(10_000_000n, 15_000_000n, 0n), 10_000_000n);
  assert.equal(nextShareUnits(10_000_000n, 15_000_000n, 8_000_000n), 7_000_000n);
  assert.equal(nextShareUnits(10_000_000n, 15_000_000n, 15_000_000n), 0n);
  assert.equal(nextShareUnits(10_000_000n, 15_000_000n, 20_000_000n), 0n, "never negative");
});

test("assertRunTotal: sums exactly, accepts == cap, refuses above", () => {
  assert.equal(assertRunTotal(["10", "20.5"]), 30_500_000n);
  assert.equal(assertRunTotal(["600", "400"]), 1_000_000_000n);
  assertRejects(() => assertRunTotal(["600", "400.000001"]), "1000");
});

test("formatUnits: fixed decimals", () => {
  assert.equal(formatUnits(70_000n, 6), "0.070000");
  assert.equal(formatUnits(12_345n, 4), "1.2345");
  assert.equal(formatUnits(0n, 4), "0.0000");
  assert.equal(formatUnits(5n, 0), "5");
});

test("splitProportional: exact sum, floor per part, remainder to the largest weight, tie -> lowest id", () => {
  const two = splitProportional(1000n, [{ id: 1, weight: 10n }, { id: 2, weight: 20n }]);
  assert.equal(two.get(1), 333n);
  assert.equal(two.get(2), 667n);
  const three = splitProportional(100n, [{ id: 3, weight: 5n }, { id: 1, weight: 5n }, { id: 2, weight: 5n }]);
  assert.deepEqual([three.get(1), three.get(2), three.get(3)], [34n, 33n, 33n]);
  const one = splitProportional(11_838n, [{ id: 7, weight: 10n }]);
  assert.equal(one.get(7), 11_838n);
  const zero = splitProportional(0n, [{ id: 1, weight: 1n }, { id: 2, weight: 3n }]);
  assert.deepEqual([zero.get(1), zero.get(2)], [0n, 0n]);
});

test("splitProportional: refuses an empty list or a non-positive weight", () => {
  assertRejects(() => splitProportional(10n, []), "weight");
  assertRejects(() => splitProportional(10n, [{ id: 1, weight: 0n }]), "weight");
});

test("splitProportional: refuses duplicate IDs so shares cannot overwrite each other", () => {
  assertRejects(() => splitProportional(10n, [{ id: 1, weight: 1n }, { id: 1, weight: 1n }]), "duplicate");
});

test("splitShares: WBTC and both gas figures split, and every column sums back to the input", () => {
  const shares = [{ strategyId: 1, amountIn: 10_000_000n }, { strategyId: 2, amountIn: 20_000_000n }];
  const out = splitShares(35_513n, "0.070001", "0.0071", shares);
  assert.deepEqual(out.map((s) => s.strategyId), [1, 2]);
  assert.equal(out.reduce((sum, s) => sum + BigInt(s.amountOut), 0n), 35_513n);
  assert.equal(out[0]!.amountOut, "11837");
  assert.equal(out[1]!.amountOut, "23676");
  assert.deepEqual(out.map((s) => s.gasCostPol), ["0.023333", "0.046668"]);
  assert.deepEqual(out.map((s) => s.gasCostUsd), ["0.0023", "0.0048"]);
});

test("splitShares: null gas stays null", () => {
  const out = splitShares(100n, null, null, [{ strategyId: 1, amountIn: 1n }]);
  assert.deepEqual(out, [{ strategyId: 1, amountOut: "100", gasCostPol: null, gasCostUsd: null }]);
});

// ============================================================ settings (F1c)

const GOOD_SETTINGS = { runTime: "00:00", maxSlippagePct: 0.5, maxPriceImpactPct: 1, maxOracleDeviationPct: 2, approvalDays: 30, minPolBalance: 0.5 };

test("validateSettings: good values pass through, numeric strings become numbers", () => {
  assert.deepEqual(validateSettings(GOOD_SETTINGS), GOOD_SETTINGS);
  assert.deepEqual(
    validateSettings({ runTime: "09:15", maxSlippagePct: "0.5", maxPriceImpactPct: "1.0", maxOracleDeviationPct: "2", approvalDays: "30", minPolBalance: "0" }),
    { runTime: "09:15", maxSlippagePct: 0.5, maxPriceImpactPct: 1, maxOracleDeviationPct: 2, approvalDays: 30, minPolBalance: 0 }
  );
});

test("validateSettings: every cap boundary -- min and max accepted, just outside refused", () => {
  const cases: [Exclude<keyof typeof SETTINGS_CAPS, "runTimeStepMinutes">, number, number][] = [
    ["maxSlippagePct", 0.01, 2], ["maxPriceImpactPct", 0.01, 3], ["maxOracleDeviationPct", 0.01, 5], ["approvalDays", 1, 90], ["minPolBalance", 0, 100],
  ];
  for (const [key, min, max] of cases) {
    assert.equal(validateSettings({ ...GOOD_SETTINGS, [key]: min })[key], min);
    assert.equal(validateSettings({ ...GOOD_SETTINGS, [key]: max })[key], max);
    assertRejects(() => validateSettings({ ...GOOD_SETTINGS, [key]: max + (key === "approvalDays" ? 1 : 0.01) }), key);
    assertRejects(() => validateSettings({ ...GOOD_SETTINGS, [key]: min - (key === "approvalDays" ? 1 : 0.01) }), key);
  }
});

test("validateSettings: approvalDays must be an integer", () => {
  assertRejects(() => validateSettings({ ...GOOD_SETTINGS, approvalDays: 30.5 }), "approvalDays");
});

test("validateSettings: junk refused with the field named, all problems at once", () => {
  for (const bad of ["abc", "", null, undefined, NaN, Infinity, "1e1", true]) {
    assertRejects(() => validateSettings({ ...GOOD_SETTINGS, maxSlippagePct: bad }), "maxSlippagePct");
  }
  try {
    validateSettings({ ...GOOD_SETTINGS, maxSlippagePct: 9, approvalDays: 0 });
    assert.fail("should throw");
  } catch (err) {
    assert.match((err as Error).message, /maxSlippagePct[\s\S]*approvalDays|approvalDays[\s\S]*maxSlippagePct/);
  }
});

test("validateSettings: runTime is HH:MM UTC on a quarter hour", () => {
  for (const good of ["00:00", "09:15", "12:30", "23:45"]) assert.equal(validateSettings({ ...GOOD_SETTINGS, runTime: good }).runTime, good);
  for (const bad of ["24:00", "9:15", "09:10", "09:15:00", "", 915, null]) assertRejects(() => validateSettings({ ...GOOD_SETTINGS, runTime: bad }), "runTime");
});

test("isDue: at or after today's run time (UTC), never before", () => {
  assert.equal(isDue("2026-09-24T08:59:59.999Z", "09:00"), false);
  assert.equal(isDue("2026-09-24T09:00:00.000Z", "09:00"), true);
  assert.equal(isDue("2026-09-24T09:00:03.000Z", "09:00"), true);
  assert.equal(isDue("2026-09-24T23:45:00.000Z", "00:00"), true);
  assert.equal(isDue("2026-09-24T00:00:00.000Z", "00:00"), true);
  assert.equal(isDue("2026-09-24T23:44:59.000Z", "23:45"), false);
});
