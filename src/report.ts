// Summary numbers (shared by the app's tiles and the email) and the email
// report sent after each scheduled run (F3). buildReport/summarize are
// pure; sendReport is the one I/O call (Resend's HTTP API via fetch -- no
// dependency). Sending never affects a purchase: dca.ts calls it after the
// run is final and swallows its errors.

import type { Run } from "./db.js";
import type { ReportConfig } from "./config.js";
import type { FundsAlertItem } from "./health.js";

const DECIMALS_IN = 6; // USDT0
const DECIMALS_OUT = 8; // WBTC
const SEND_TIMEOUT_MS = 10_000;

/** Sums in base units, divides once -- no float drift across many purchases. */
function total(values: (string | null)[], decimals: number): number {
  return Number(values.reduce((sum, v) => sum + BigInt(v ?? "0"), 0n)) / 10 ** decimals;
}

/** `runs` newest first (listAllRuns order). */
export function summarize(runs: Run[]) {
  const confirmed = runs.filter((r) => r.status === "CONFIRMED");
  const totalInvestedUsdt = total(confirmed.map((r) => r.amountIn), DECIMALS_IN);
  const totalBtc = total(confirmed.map((r) => r.amountOut), DECIMALS_OUT);
  const latest = confirmed[0];
  const latestMarketPrice =
    latest?.oracleBtcUsd && latest?.oracleUsdtUsd ? Number(latest.oracleBtcUsd) / Number(latest.oracleUsdtUsd) : null;
  // Unrealised result: BTC held valued at the latest oracle price vs what was paid.
  const pnlUsdt = latestMarketPrice !== null && totalInvestedUsdt > 0 ? totalBtc * latestMarketPrice - totalInvestedUsdt : null;
  return {
    totalInvestedUsdt,
    totalBtc,
    weightedAvgPrice: totalBtc > 0 ? totalInvestedUsdt / totalBtc : null,
    latestMarketPrice,
    pnlUsdt,
    pnlPct: pnlUsdt === null ? null : (pnlUsdt / totalInvestedUsdt) * 100,
    confirmedCount: confirmed.length,
    failedCount: runs.filter((r) => r.status === "FAILED").length,
    totalGasUsd: confirmed.reduce((sum, r) => sum + (r.gasCostUsd ? Number(r.gasCostUsd) : 0), 0),
  };
}

/** "YYYY-MM-DD" (a UTC date) -> "dd/MM/yyyy", the display format everywhere. */
const day = (isoDate: string) => isoDate.split("-").reverse().join("/");
const price = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usdt = (base: string | null) => (Number(base ?? "0") / 10 ** DECIMALS_IN).toFixed(2);
const btc = (base: string | null) => (Number(base ?? "0") / 10 ** DECIMALS_OUT).toFixed(DECIMALS_OUT);

const escapeHtml = (v: string) =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Email for one scheduled run; `all` gives the running totals. Text + HTML (inline styles: mail clients drop <style>). */
export function buildReport(run: Run, shares: { label: string; amountIn: string; amountOut: string | null }[], all: Run[]): { subject: string; text: string; html: string } {
  const s = summarize(all);
  const shareRows: [string, string][] = shares.map((share) => [
    share.label,
    share.amountOut !== null ? `${usdt(share.amountIn)} USDT0 → ${btc(share.amountOut)} BTC` : `${usdt(share.amountIn)} USDT0`,
  ]);
  const shareText = shares.length > 1 ? ["", "By strategy:", ...shareRows.map(([label, value]) => `  ${label}: ${value}`)].join("\n") : "";
  const totals =
    `Total: ${s.totalInvestedUsdt.toFixed(2)} USDT0 -> ${s.totalBtc.toFixed(DECIMALS_OUT)} BTC` +
    (s.weightedAvgPrice ? `, average ${price(s.weightedAvgPrice)} USDT0/BTC over ${s.confirmedCount} purchases.` : ".");
  const txUrl = run.txHash ? `https://polygonscan.com/tx/${run.txHash}` : null;

  let subject: string, text: string, badge: { label: string; color: string; bg: string }, headline: string;
  let details: [string, string][] = [];
  if (run.status === "CONFIRMED") {
    subject = `DCA ${day(run.date)}: bought ${btc(run.amountOut)} BTC for ${usdt(run.amountIn)} USDT0`;
    text = [
      `Bought ${btc(run.amountOut)} BTC for ${usdt(run.amountIn)} USDT0.`,
      `Price: ${price(Number(run.effectivePrice))} USDT0/BTC (vs Chainlink: ${run.oracleDeviationPct}%)`,
      `Gas: $${run.gasCostUsd}`,
      `Tx: ${txUrl}`,
      shareText,
      "",
      totals,
    ].join("\n");
    badge = { label: "Bought", color: "#0f7b4f", bg: "#e3f6ec" };
    headline = `<div style="font-size:30px;font-weight:700;color:#111827;letter-spacing:-0.5px">${btc(run.amountOut)} BTC</div>
      <div style="font-size:15px;color:#6b7280;margin-top:4px">for ${usdt(run.amountIn)} USDT0</div>`;
    details = [
      ["Price", `${price(Number(run.effectivePrice))} USDT0/BTC`],
      ["vs Chainlink", `${run.oracleDeviationPct}%`],
      ["Gas", `$${run.gasCostUsd}`],
    ];
  } else if (run.status === "PAUSED") {
    subject = `DCA ${day(run.date)}: paused -- nothing bought`;
    text = `The DCA is paused; today was skipped.\n${shareText}\n${totals}`;
    badge = { label: "Paused", color: "#92600a", bg: "#fdf3dc" };
    headline = `<div style="font-size:20px;font-weight:600;color:#111827">Today was skipped</div>
      <div style="font-size:15px;color:#6b7280;margin-top:4px">The DCA is paused. Resume it from the app.</div>`;
  } else {
    subject = `DCA ${day(run.date)}: FAILED -- nothing bought`;
    text = [`Status: ${run.status}`, `Error: ${run.error ?? "(none recorded)"}`, txUrl ? `Tx: ${txUrl}` : "", shareText, "", totals]
      .filter((line, i, a) => line !== "" || a[i - 1] !== "")
      .join("\n");
    badge = { label: "Failed", color: "#b42318", bg: "#fdecea" };
    headline = `<div style="font-size:20px;font-weight:600;color:#111827">Nothing was bought</div>
      <div style="font-size:14px;color:#374151;margin-top:10px;padding:10px 12px;background:#f9fafb;border-radius:8px;font-family:ui-monospace,Menlo,monospace;word-break:break-word">${escapeHtml(run.error ?? "(no error recorded)")}</div>`;
  }

  const row = ([k, v]: [string, string]) =>
    `<tr><td style="padding:8px 0;color:#6b7280;font-size:14px">${k}</td><td style="padding:8px 0;color:#111827;font-size:14px;text-align:right;font-weight:500">${v}</td></tr>`;
  const totalRows: [string, string][] = [
    ["Invested", `${s.totalInvestedUsdt.toFixed(2)} USDT0`],
    ["Accumulated", `${s.totalBtc.toFixed(DECIMALS_OUT)} BTC`],
    ...(s.weightedAvgPrice ? ([["Average price", `${price(s.weightedAvgPrice)} USDT0/BTC`]] as [string, string][]) : []),
    ["Purchases", String(s.confirmedCount)],
  ];

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f3f4f6">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e5e7eb">
  <tr><td style="padding:20px 24px 0 24px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="font-size:13px;color:#6b7280">BTC DCA &middot; ${day(run.date)}</td>
      <td style="text-align:right"><span style="display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600;color:${badge.color};background:${badge.bg}">${badge.label}</span></td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:18px 24px 8px 24px">${headline}</td></tr>
  ${details.length ? `<tr><td style="padding:8px 24px 0 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #f0f1f3">${details.map(row).join("")}</table></td></tr>` : ""}
  ${shares.length > 1 ? `<tr><td style="padding:14px 24px 0 24px"><div style="font-size:12px;font-weight:600;color:#9ca3af;text-transform:uppercase;letter-spacing:0.6px;margin-bottom:4px">By strategy</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${shareRows.map(([k, v]) => row([escapeHtml(k), v])).join("")}</table></td></tr>` : ""}
  ${txUrl ? `<tr><td style="padding:14px 24px 4px 24px"><a href="${txUrl}" style="display:inline-block;padding:10px 16px;background:#111827;color:#ffffff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:500">View on Polygonscan</a></td></tr>` : ""}
  <tr><td style="padding:18px 24px 22px 24px">
    <div style="font-size:12px;font-weight:600;color:#9ca3af;text-transform:uppercase;letter-spacing:0.6px;margin-bottom:4px">So far</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${totalRows.map(row).join("")}</table>
  </td></tr>
</table>
<div style="font-size:12px;color:#9ca3af;margin-top:14px">Sent after the scheduled run. Manual buys don't send reports.</div>
</td></tr></table>
</body></html>`;

  return { subject, text, html };
}

/** Low-funds alert: plain text, sent at most once a day after the scheduled run. `items` non-empty (fundsAlert). */
export function buildFundsAlert(items: FundsAlertItem[], alertDays: number): { subject: string; text: string } {
  const sorted = [...items].sort((a, b) => a.runwayDays - b.runwayDays);
  const first = sorted[0]!;
  const subject = first.runwayDays === 0
    ? `DCA: ran out of ${first.resource} -- the next run can't buy`
    : `DCA: ${first.resource} runs out in ${first.runwayDays} day${first.runwayDays === 1 ? "" : "s"}`;
  const at = (iso: string) => `${day(iso.slice(0, 10))} ${iso.slice(11, 16)} UTC`;
  const text = [
    ...sorted.map((i) => `${i.resource}: ${i.runwayDays} run${i.runwayDays === 1 ? "" : "s"} left, the run of ${at(i.runsOutOn)} can't be paid.`),
    "",
    sorted.some((i) => i.resource === "POL") ? "POL pays gas; the run refuses to start below the minimum POL balance." : "",
    "Top up the DCA wallet to keep buying.",
    "",
    `Alerting at ${alertDays} day${alertDays === 1 ? "" : "s"} or less (change it in the app's settings); running out always alerts.`,
  ].filter((line, i, a) => line !== "" || a[i - 1] !== "").join("\n");
  return { subject, text };
}

export async function sendReport(cfg: ReportConfig, report: { subject: string; text: string; html?: string }): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: cfg.from, to: [cfg.to], subject: report.subject, text: report.text, html: report.html }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Resend answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
}
