import { test } from "node:test";
import assert from "node:assert/strict";
import { balanceHealth, averageGasWei, fundsAlert, RUNWAY_WARNING_DAYS } from "./health.js";

const U = 1_000_000n; // USDT0 has 6 decimals
const POL = 10n ** 18n;
const base = { tokenInUnits: 100n * U, dailyNeedUnits: 10n * U, polWei: 10n * POL, minPolWei: POL / 2n, avgGasWei: POL / 10n, allowanceUnits: 300n * U, nowIso: "2026-09-25T12:00:00.000Z", runTime: "00:00" };

test("USDT0 runway: whole days covered, and the date of the first run it can't pay", () => {
  const h = balanceHealth(base);
  assert.deepEqual(h.tokenIn, { status: "ok", runwayDays: 10, runsOutOn: "2026-10-06T00:00:00.000Z" });
});

test("USDT0 status: warning under RUNWAY_WARNING_DAYS, critical when the next run isn't covered", () => {
  assert.equal(RUNWAY_WARNING_DAYS, 7);
  assert.equal(balanceHealth({ ...base, tokenInUnits: 70n * U }).tokenIn.status, "ok");
  assert.equal(balanceHealth({ ...base, tokenInUnits: 69n * U }).tokenIn.status, "warning");
  assert.equal(balanceHealth({ ...base, tokenInUnits: 10n * U }).tokenIn.status, "warning");
  assert.deepEqual(balanceHealth({ ...base, tokenInUnits: 9n * U }).tokenIn, { status: "critical", runwayDays: 0, runsOutOn: "2026-09-26T00:00:00.000Z" });
});

test("runsOutOn is the run's instant: today's run still counts before run time", () => {
  const early = { ...base, runTime: "15:00" };
  assert.deepEqual(balanceHealth(early).tokenIn, { status: "ok", runwayDays: 10, runsOutOn: "2026-10-05T15:00:00.000Z" });
  assert.equal(balanceHealth({ ...early, tokenInUnits: 9n * U }).tokenIn.runsOutOn, "2026-09-25T15:00:00.000Z");
});

test("no active strategies: nothing to cover, everything ok with no runway", () => {
  const h = balanceHealth({ ...base, dailyNeedUnits: 0n, tokenInUnits: 0n, allowanceUnits: 0n });
  assert.deepEqual(h.tokenIn, { status: "ok", runwayDays: null, runsOutOn: null });
  assert.deepEqual(h.allowance, { status: "ok", runwayDays: null });
});

test("gas runway: the bot refuses below MIN_POL_BALANCE before spending, so runs = floor((pol - min) / avg) + 1", () => {
  // (10 - 0.5) / 0.1 = 95 -> 96 runs
  assert.deepEqual(balanceHealth(base).gas, { status: "ok", runwayDays: 96, runsOutOn: "2026-12-31T00:00:00.000Z" });
  assert.equal(balanceHealth({ ...base, polWei: POL / 2n + POL / 10n * 5n }).gas.status, "warning"); // 6 runs
  assert.deepEqual(balanceHealth({ ...base, polWei: POL / 2n - 1n }).gas, { status: "critical", runwayDays: 0, runsOutOn: "2026-09-26T00:00:00.000Z" });
});

test("gas runway without history: only the MIN_POL_BALANCE check applies", () => {
  assert.deepEqual(balanceHealth({ ...base, avgGasWei: null }).gas, { status: "ok", runwayDays: null, runsOutOn: null });
  assert.equal(balanceHealth({ ...base, avgGasWei: null, polWei: 0n }).gas.status, "critical");
});

test("allowance: ok while it covers the next run, warning when the next run must approve again", () => {
  assert.deepEqual(balanceHealth(base).allowance, { status: "ok", runwayDays: 30 });
  assert.deepEqual(balanceHealth({ ...base, allowanceUnits: 9n * U }).allowance, { status: "warning", runwayDays: 0 });
});

test("averageGasWei: mean of the recorded POL costs, null without any", () => {
  assert.equal(averageGasWei([]), null);
  assert.equal(averageGasWei(["0.083000", "0.017000"]), 5n * 10n ** 16n);
});

test("fundsAlert: warns at or under alertDays, always when the next run can't be paid, never with nothing to buy", () => {
  const at = (tokenIn: bigint, alertDays: number) => fundsAlert(balanceHealth({ ...base, tokenInUnits: tokenIn * U }), alertDays);
  assert.deepEqual(at(30n, 2), [], "3 runs left, alert at 2: quiet");
  assert.deepEqual(at(20n, 2), [{ resource: "USDT0", runwayDays: 2, runsOutOn: "2026-09-28T00:00:00.000Z" }]);
  assert.deepEqual(at(10n, 0), [], "alert days 0: quiet while the next run is covered");
  assert.deepEqual(at(9n, 0), [{ resource: "USDT0", runwayDays: 0, runsOutOn: "2026-09-26T00:00:00.000Z" }], "ran out: always");
  const gas = fundsAlert(balanceHealth({ ...base, polWei: POL / 4n }), 0);
  assert.deepEqual(gas, [{ resource: "POL", runwayDays: 0, runsOutOn: "2026-09-26T00:00:00.000Z" }], "below min POL: ran out of gas");
  assert.deepEqual(fundsAlert(balanceHealth({ ...base, dailyNeedUnits: 0n, tokenInUnits: 0n, avgGasWei: null }), 30), []);
});
