// F7: can the wallet keep executing the strategies? Pure math over balances
// read by server.ts (/api/balance). Thresholds live here, in code
// (README.md invariant #5). One scheduled run per UTC day at runTime: today's if it
// hasn't come yet, otherwise tomorrow's.
import { toBaseUnits, isDue } from "./validation.js";

export const RUNWAY_WARNING_DAYS = 7;
/** Confirmed runs averaged for the gas runway. */
export const GAS_SAMPLE_RUNS = 10;

export type HealthStatus = "ok" | "warning" | "critical";

export interface RunwayItem {
  status: HealthStatus;
  /** Scheduled runs (= days) covered; null when there is nothing to measure. */
  runwayDays: number | null;
  /** ISO instant (UTC) of the first run that can't be paid; the app shows it in local time. */
  runsOutOn: string | null;
}

export interface HealthInput {
  tokenInUnits: bigint;
  dailyNeedUnits: bigint;
  polWei: bigint;
  minPolWei: bigint;
  avgGasWei: bigint | null;
  allowanceUnits: bigint;
  nowIso: string;
  runTime: string; // HH:MM UTC
}

function addDays(dateUtc: string, days: number): string {
  return new Date(Date.parse(`${dateUtc}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function runway(runs: number, i: HealthInput): RunwayItem {
  const nextRun = addDays(i.nowIso.slice(0, 10), isDue(i.nowIso, i.runTime) ? 1 : 0);
  return { status: runs < 1 ? "critical" : runs < RUNWAY_WARNING_DAYS ? "warning" : "ok", runwayDays: runs, runsOutOn: `${addDays(nextRun, runs)}T${i.runTime}:00.000Z` };
}

export function balanceHealth(i: HealthInput): { tokenIn: RunwayItem; gas: RunwayItem; allowance: { status: HealthStatus; runwayDays: number | null } } {
  const tokenIn = i.dailyNeedUnits === 0n ? { status: "ok" as const, runwayDays: null, runsOutOn: null } : runway(Number(i.tokenInUnits / i.dailyNeedUnits), i);
  // dca.ts refuses to start below MIN_POL_BALANCE, checked BEFORE spending:
  // run k goes ahead while pol - (k-1)*avg >= min.
  const gas = i.polWei < i.minPolWei
    ? runway(0, i)
    : i.avgGasWei === null || i.avgGasWei === 0n
      ? { status: "ok" as const, runwayDays: null, runsOutOn: null }
      : runway(Number((i.polWei - i.minPolWei) / i.avgGasWei) + 1, i);
  // Below the next total the run approves again first: routine every
  // APPROVAL_DAYS, just an extra tx of gas -- warning, never critical.
  const allowance = i.dailyNeedUnits === 0n
    ? { status: "ok" as const, runwayDays: null }
    : { status: i.allowanceUnits >= i.dailyNeedUnits ? ("ok" as const) : ("warning" as const), runwayDays: Number(i.allowanceUnits / i.dailyNeedUnits) };
  return { tokenIn, gas, allowance };
}

/** Mean of recorded gas costs (POL decimal strings, as runs.gas_cost_pol stores them), in wei. */
export function averageGasWei(costsPol: string[]): bigint | null {
  if (costsPol.length === 0) return null;
  return costsPol.reduce((sum, cost) => sum + toBaseUnits(cost, 18), 0n) / BigInt(costsPol.length);
}

export interface FundsAlertItem { resource: "USDT0" | "POL"; runwayDays: number; runsOutOn: string }

/** Low-funds email (after the scheduled run): resources lasting <= alertDays runs; a run that can't be paid (0) always counts. */
export function fundsAlert(h: ReturnType<typeof balanceHealth>, alertDays: number): FundsAlertItem[] {
  return ([["USDT0", h.tokenIn], ["POL", h.gas]] as const).flatMap(([resource, r]) =>
    r.runwayDays !== null && r.runsOutOn !== null && r.runwayDays <= alertDays // alertDays >= 0, so 0 always counts
      ? [{ resource, runwayDays: r.runwayDays, runsOutOn: r.runsOutOn }]
      : []);
}
