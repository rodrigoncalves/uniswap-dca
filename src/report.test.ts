import { test } from "node:test";
import assert from "node:assert/strict";
import { summarize, buildReport, buildFundsAlert, shouldSendReport } from "./report.js";
import type { Run, Transfer } from "./db.js";

function run(overrides: Partial<Run>): Run {
  return {
    wallet: "0x000000000000000000000000000000000000000A", date: "2026-09-24", status: "CONFIRMED", nonce: 1,
    txHash: "0x" + "ab".repeat(32), blockNumber: "1", confirmedAt: "2026-09-24T00:00:12.000Z",
    amountIn: "10000000", amountOut: "11838", recipient: null, effectivePrice: "84473.73", minimumAmount: "11779",
    priceImpactPct: "0.07", oracleBtcUsd: "84400", oracleUsdtUsd: "1", oraclePolUsd: "0.1", oracleDeviationPct: "0.450",
    gasUsed: "211000", gasCostPol: "0.07", gasCostUsd: "0.0070", routing: "CLASSIC", routeString: null,
    requestId: null, quoteId: null, error: null, deadline: null,
    ...overrides,
  };
}

test("summarize: totals over CONFIRMED only, weighted average price, gas, counts", () => {
  const s = summarize([
    run({}),
    run({ date: "2026-09-23", amountIn: "5000000", amountOut: "5927", gasCostUsd: "0.0080" }),
    run({ date: "2026-09-22", status: "FAILED", amountIn: "10000000", amountOut: null }),
  ]);
  assert.equal(s.totalInvestedUsdt, 15);
  assert.equal(s.totalBtc, 0.00017765);
  assert.equal(s.weightedAvgPrice, 15 / 0.00017765);
  assert.equal(s.confirmedCount, 2);
  assert.equal(s.failedCount, 1);
  assert.ok(Math.abs(s.totalGasUsd - 0.015) < 1e-12);
});

test("summarize: revenue = BTC held at latest oracle price minus invested, in USDT and %", () => {
  // 0.0001 BTC bought for 10 USDT0; latest oracle 110000 -> worth 11 -> +1 (+10%)
  const s = summarize([run({ amountIn: "10000000", amountOut: "10000", oracleBtcUsd: "110000" })]);
  assert.ok(Math.abs(s.pnlUsdt! - 1) < 1e-9);
  assert.ok(Math.abs(s.pnlPct! - 10) < 1e-9);
  const none = summarize([]);
  assert.equal(none.pnlUsdt, null);
  assert.equal(none.pnlPct, null);
});

test("buildReport CONFIRMED: amounts in the subject, price, deviation, gas, tx link and running totals in the body", () => {
  const r = run({});
  const { subject, text } = buildReport(r, [], [r]);
  assert.equal(subject, "DCA 24/09/2026: bought 0.00011838 BTC for 10.00 USDT0");
  assert.match(text, /Price: 84,473\.73 USDT0\/BTC/);
  assert.match(text, /vs Chainlink: 0\.450%/);
  assert.match(text, /Gas: \$0\.0070/);
  assert.match(text, new RegExp(`https://polygonscan.com/tx/${r.txHash}`));
  assert.match(text, /Total: 10\.00 USDT0 -> 0\.00011838 BTC/);
});

test("buildReport FAILED: says so in the subject and carries the error", () => {
  const r = run({ status: "FAILED", error: "insufficient USDT0 balance", amountOut: null, txHash: null });
  const { subject, text } = buildReport(r, [], [r]);
  assert.equal(subject, "DCA 24/09/2026: FAILED -- nothing bought");
  assert.match(text, /insufficient USDT0 balance/);
});

test("buildReport PAUSED: says the day was skipped", () => {
  const r = run({ status: "PAUSED", amountIn: null, amountOut: null, txHash: null });
  assert.equal(buildReport(r, [], [r]).subject, "DCA 24/09/2026: paused -- nothing bought");
});

test("buildReport html CONFIRMED: headline amounts, details, tx button and totals", () => {
  const r = run({});
  const { html } = buildReport(r, [], [r]);
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /0\.00011838 BTC/);
  assert.match(html, /10\.00 USDT0/);
  assert.match(html, /84,473\.73/);
  assert.match(html, /0\.450%/);
  assert.match(html, new RegExp(`href="https://polygonscan.com/tx/${r.txHash}"`));
  assert.match(html, /Bought/);
});

test("buildReport html FAILED: the error is HTML-escaped, never injected as markup", () => {
  const r = run({ status: "FAILED", error: 'revert <script>alert("x")</script> & more', amountOut: null, txHash: null });
  const { html } = buildReport(r, [], [r]);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &amp; more/);
  assert.match(html, /Failed/);
});

test("buildReport html PAUSED: says paused, no tx button", () => {
  const r = run({ status: "PAUSED", amountIn: null, amountOut: null, txHash: null });
  const { html } = buildReport(r, [], [r]);
  assert.match(html, /Paused/);
  assert.doesNotMatch(html, /polygonscan/);
});

test("buildReport: with two strategies, lists each share in text and html", () => {
  const r = buildReport(run({ amountIn: "30000000", amountOut: "35513" }), [
    { label: "August/2026", amountIn: "10000000", amountOut: "11837" },
    { label: "Isabela Aug/26", amountIn: "20000000", amountOut: "23676" },
  ], [run({})]);
  assert.match(r.text, /By strategy:/);
  assert.match(r.text, /August\/2026: 10\.00 USDT0 → 0\.00011837 BTC/);
  assert.match(r.html, /Isabela Aug\/26/);
});

test("buildReport: a label with HTML is escaped", () => {
  const r = buildReport(run({}), [
    { label: "<b>x</b>", amountIn: "1", amountOut: "1" },
    { label: "y", amountIn: "1", amountOut: "1" },
  ], [run({})]);
  assert.ok(!r.html.includes("<b>x</b>"));
});

test("buildFundsAlert: ran-out subject wins, text lists every resource with its date", () => {
  const low = buildFundsAlert([{ resource: "USDT0", runwayDays: 2, runsOutOn: "2026-09-28T00:00:00.000Z" }], 2);
  assert.match(low.subject, /USDT0 runs out in 2 days/);
  assert.match(low.text, /USDT0: 2 runs left, the run of 28\/09\/2026 00:00 UTC can't be paid/);
  const out = buildFundsAlert([
    { resource: "USDT0", runwayDays: 1, runsOutOn: "2026-09-27T00:00:00.000Z" },
    { resource: "POL", runwayDays: 0, runsOutOn: "2026-09-26T00:00:00.000Z" },
  ], 2);
  assert.match(out.subject, /ran out of POL/);
  assert.match(out.text, /POL: 0 runs left/);
  assert.match(out.text, /USDT0: 1 run left/);
});

const DEST = "0xAB12cd34Ef56aB12Cd34Ef56ab12Cd34Ef56aB12";
const DEST2 = "0x00000000000000000000000000000000000000B2";
function transfer(overrides: Partial<Transfer>): Transfer {
  return {
    id: 1, wallet: "0x000000000000000000000000000000000000000A", date: "2026-09-24", destination: DEST, amount: "107",
    status: "CONFIRMED", failure: null, attempts: 1, claimedAt: null, nonce: 2, txHash: "0x" + "cd".repeat(32), blockNumber: "2",
    gasUsed: "50000", gasCostPol: "0.01", gasCostUsd: "0.0010", error: null, prevTxHash: null, createdAt: "2026-09-24T00:00:12.000Z",
    ...overrides,
  };
}

test("buildReport: mixed day lists each WBTC transfer, sent or not", () => {
  const transfers = [transfer({}), transfer({ id: 2, destination: DEST2, amount: "30", status: "FAILED", failure: "insufficient_wbtc", txHash: null })];
  const { text, html } = buildReport(run({}), [], [run({})], transfers);
  assert.ok(text.includes(`Sent 0.00000107 BTC to ${DEST}: https://polygonscan.com/tx/${transfers[0]!.txHash}`));
  assert.ok(text.includes(`NOT sent 0.00000030 BTC to ${DEST2} (insufficient_wbtc) -- it is in the DCA wallet; retry from the app`));
  assert.ok(html.includes(DEST2));
});

test("shouldSendReport: errors mode also sends when a transfer FAILED", () => {
  const ok = run({});
  const failedTransfer = [transfer({ status: "FAILED", failure: "reverted" })];
  assert.equal(shouldSendReport("errors", ok, []), false);
  assert.equal(shouldSendReport("errors", ok, failedTransfer), true);
  assert.equal(shouldSendReport("errors", run({ status: "FAILED" }), []), true);
  assert.equal(shouldSendReport("all", ok, []), true);
  assert.equal(shouldSendReport("off", ok, failedTransfer), false);
});

test("buildReport: a FAILED transfer shows in the subject, whatever the run status", () => {
  const failed = [transfer({}), transfer({ id: 2, destination: DEST2, status: "FAILED", failure: "reverted" })];
  for (const status of ["CONFIRMED", "FAILED", "PAUSED"] as const) {
    assert.match(buildReport(run({ status }), [], [run({})], failed).subject, / -- WBTC transfer FAILED$/, status);
    assert.doesNotMatch(buildReport(run({ status }), [], [run({})], [transfer({})]).subject, /WBTC transfer FAILED/, status);
  }
});
