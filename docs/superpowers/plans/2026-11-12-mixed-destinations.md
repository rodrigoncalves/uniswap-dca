# Mixed WBTC Destinations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the daily swap's strategies have different WBTC destinations, each strategy's WBTC still reaches its own destination. The swap delivers to the DCA wallet, then one ERC-20 `transfer` per external destination sends that destination's share. Each strategy is charged the gas it actually caused. The POL runway projects the real daily cost. A failed transfer is shown in the app and email, and can be retried from the app behind TOTP, sent immediately.

**Architecture:** Additive to F17 (DECISIONS.md #33). Same-destination days keep the in-swap `recipient` path, with no transfer.

Mixed days:
1. `claimScheduledRun` snapshots each strategy's destination into `run_shares.destination`.
2. `confirmScheduledRun` writes PENDING rows to a new `transfers` table, in the same DB transaction as the share results.
3. `dca.ts::deliverTransfers` claims each row (PENDING → SENDING), records BROADCAST before `sendRaw` (README invariant #4), and resolves it by receipt or nonce.
4. Every receipt, success or revert, charges its real gas to the strategies of that destination, in proportion to `amountIn`.
5. The app retries by resetting a safe FAILED row to PENDING and forking `dca.ts --transfers`, the same pattern as the manual buy from the app (DECISIONS #17).

Manual buys are unchanged.

**Tech Stack:** TypeScript (Node ≥24, `node:sqlite`, `node:test`), viem, plain JS frontend (`public/app.js`), `scripts/fork.sh` (anvil fork of Polygon).

**Spec:** DECISIONS.md #33 (F17), plus the user's choices in this session (2026-11-12):
- "swap + transfer" over "one swap per destination";
- failed transfers shown in the app and by email;
- manual retry from the app, sent **immediately**;
- each strategy's gas recorded at its real cost and used for the runway projection.

Task 7 records this as DECISIONS.md #34.

## Global Constraints

- **Never re-broadcast.**
  - A transfer is sent only by the process that moved it PENDING → SENDING (`claimTransfer`, atomic).
  - Its BROADCAST row (nonce + tx hash) is recorded before `sendRaw`.
  - SENDING older than `TRANSFER_SENDING_STALE_MS = 60 * 60 * 1000` returns to PENDING. Nothing was sent: BROADCAST precedes the send.
- **Destination checks.**
  - Before every send, re-validate the destination with `parseDestination(dest, { dcaWallet: account.address, extraForbidden: [config.tokenIn, config.tokenOut] })`.
  - Corrupt → FAILED `bad_destination`, nothing sent.
  - The destination is the claim-time snapshot (`run_shares.destination`), never `strategies.destination` at send time.
- **Pause.** While paused, no transfer is sent (they stay PENDING), and the retry route refuses.
- **`transfers.failure` codes**, exactly: `reverted`, `nonce_consumed`, `insufficient_wbtc`, `bad_destination`, `output_mismatch`.
  - Retryable: `reverted`, `nonce_consumed`, `insufficient_wbtc`.
  - `output_mismatch` also pauses the DCA, like the swap's `finalize`.
- **Real gas per strategy.**
  - Every transfer receipt (success or revert) costs `gasUsed * effectiveGasPrice`.
  - It is added to `transfers.gas_cost_pol/usd` (cumulative across retries).
  - It is added to `run_shares.gas_cost_pol/usd` of exactly the shares of that run whose snapshot destination equals the transfer's destination (`getAddress` compare). The split is proportional to `amountIn`, with `splitShares(0n, pol, usd, shares)`.
  - USD = POL × the swap run's `oracle_pol_usd`.
  - Decimals as today: POL 6 (`toFixed(6)`), USD 4.
  - A share on the DCA wallet is never charged transfer gas.
  - A tx that never mined costs nothing and adds nothing.
- **Strategy totals.** They and `run_shares.amount_out` are unchanged: a transfer moves WBTC already credited.
- **WBTC conservation (hard invariant, no more and no less), in base units, exact `bigint` equality:**
  1. `Σ run_shares.amount_out == runs.amount_out`, the WBTC the swap receipt delivered (`assertOutputTransfer`).
  2. On a mixed day: `Σ transfers.amount + Σ amount_out of shares with destination NULL == runs.amount_out`. Each transfer amount equals the sum of its destination's shares.
  3. Each transfer's receipt moves **exactly** `transfers.amount`, no more and no less, to its destination. A retry never changes `amount`, and `UNIQUE (wallet, date, destination)` forbids a second row.

  (1) and (2) are checked by `assertWbtcConservation` inside `confirmScheduledRun`'s transaction. A violation rolls back, so nothing is written. `finalize` then pauses the DCA and rethrows, which leaves the run BROADCAST. Every later tick fails the same way and buys nothing until someone looks: fail closed, no lost record. (3) is checked before signing (`assertTransferTx`, simulation) and on the receipt.
- **Commits.** No AI attribution lines (user's CLAUDE.md).
- **Schema.** `SCHEMA_VERSION` 11 → 12, in `db.ts::migrate`, with idempotent column checks like v11.

## Review Focus

1. **Two processes on the same PENDING transfer** (cron tick + app retry). Only one claims it, so a single signed tx and an accurate BROADCAST hash. Task 2 test (`claimTransfer` twice) + Task 4.
2. **Crash during SENDING or BROADCAST.**
   - SENDING: back to PENDING after the stale window.
   - BROADCAST: resolved by receipt or nonce, never resent.
   - Covered by a Task 2 test and the fork `destination_transfer_kill9` (Task 7).
3. **Reverted attempt, then a successful retry.** The strategy pays both attempts' gas; the transfer row shows the sum. Task 2 test (`recordTransferReceipt` twice).
4. **Cron gate after today's run is final.** `main()` must still run while a transfer is PENDING, SENDING or BROADCAST. Task 4 gate test.
5. **Rounding remainder on a mixed day** (e.g. 3 strategies, `amount_out` not divisible). The remainder must land in exactly one share and be delivered with it: transfers + DCA-wallet shares = `amount_out` to the satoshi. Task 2 test (`assertWbtcConservation` with a prime `amount_out`) + fork sum check (Task 7).
6. **Runway right after switching to mixed destinations** (no transfer history yet). The projection must not under-count. It falls back to the swap average per expected transfer (conservative). Task 5 test.

---

### Task 1: Snapshot destination per share at claim

**Files:**
- Modify: `src/db.ts` (`SCHEMA_VERSION`, `migrate`, `RunShare`, `rowToShare`, `claimScheduledRun`)
- Test: `src/db.test.ts`

**Interfaces:**
- Produces:
  - `RunShare.destination: string | null` (NULL = DCA wallet).
  - v12 adds `run_shares.destination TEXT`.
  - `claimScheduledRun` copies `strategies.destination` inside its existing `BEGIN IMMEDIATE`.

- [ ] **Step 1: Write failing tests**

```ts
test("claimScheduledRun snapshots each strategy's destination into its share (v12)", () => {
  // two active strategies; #1 destination DEST, #2 none
  assert.equal(claimScheduledRun(db, WALLET, "2026-11-12", NOW, 6).kind, "claimed");
  assert.deepEqual(listRunShares(db, WALLET, "2026-11-12").map((s) => s.destination), [DEST, null]);
  setStrategyDestination(db, 1, null); // edited after the claim
  assert.equal(listRunShares(db, WALLET, "2026-11-12")[0]!.destination, DEST, "snapshot, not live value");
});

test("migrate v11 -> v12: existing shares get destination NULL", () => {
  // same pattern as "migrate v10 -> v11": drop the column, user_version 11, reopen
  assert.equal(listRunShares(db, WALLET, DATE)[0]!.destination, null);
});
```

- [ ] **Step 2: Run** `node --import tsx --test src/db.test.ts`. Expected: FAIL (`destination` undefined).
- [ ] **Step 3: Implement.**
  - v12 is `ALTER TABLE run_shares ADD COLUMN destination TEXT`, guarded by `PRAGMA table_info`.
  - The claim selects `destination` and inserts it.
  - Update existing `RunShare` deepEqual fixtures.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(db): snapshot WBTC destination per run share (v12)`

---

### Task 2: `transfers` table, planning, claim, gas recording, retry (db + pure logic)

**Files:**
- Modify: `src/db.ts`, `src/validation.ts`
- Test: `src/db.test.ts`, `src/validation.test.ts`

**Interfaces:**
- Consumes: `RunShare.destination` (Task 1).
- Produces:

**Table** (created in the v12 migration):

```sql
CREATE TABLE IF NOT EXISTS transfers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet TEXT NOT NULL, date TEXT NOT NULL, destination TEXT NOT NULL, amount TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','SENDING','BROADCAST','CONFIRMED','FAILED')),
  failure TEXT CHECK (failure IN ('reverted','nonce_consumed','insufficient_wbtc','bad_destination','output_mismatch')),
  attempts INTEGER NOT NULL DEFAULT 0,
  claimed_at TEXT, nonce INTEGER, tx_hash TEXT, block_number TEXT,
  gas_used TEXT, gas_cost_pol TEXT, gas_cost_usd TEXT,  -- cumulative over attempts
  error TEXT, created_at TEXT NOT NULL,
  UNIQUE (wallet, date, destination)
);
```

**Types:**
- `type TransferFailure = "reverted" | "nonce_consumed" | "insufficient_wbtc" | "bad_destination" | "output_mismatch"`
- `interface Transfer`: camelCase of every column. `status` is the 5-value union, `failure: TransferFailure | null`.

**Pure function** (`validation.ts`):
- `planTransfers(shares: { destination: string | null; amountOut: bigint }[], swapRecipient: string, wallet: string): { destination: \`0x${string}\`; amount: bigint }[]`
- Returns `[]` unless `swapRecipient` equals `wallet` (case-insensitive).
- Otherwise it groups non-null destinations by `getAddress`, sums `amountOut`, drops zero sums, and keeps first-appearance order.

- `assertWbtcConservation(amountOut: bigint, shares: { destination: string | null; amountOut: bigint }[], transfers: { destination: string; amount: bigint }[]): void`. It `fail`s with a message naming the mismatch and both numbers when any of these is false:
  - `Σ shares.amountOut === amountOut`;
  - if `transfers.length > 0`: `Σ transfers.amount + Σ shares(destination null).amountOut === amountOut`;
  - each transfer's amount equals the sum of shares with that destination (`getAddress` compare);
  - every share with a non-null destination has a transfer.

**DB functions** (`db.ts`):
- `confirmScheduledRun(db, wallet, date, patch, results, transfers: { destination: string; amount: string }[])`:
  - calls `assertWbtcConservation(BigInt(patch.amountOut), <results joined with the shares' snapshot destinations>, transfers)` **inside** the transaction, before any write;
  - then inserts the transfers as PENDING (`created_at` = `patch.confirmedAt`).
- `listTransfers(db, opts: { wallet: string; date?: string; open?: boolean; unconfirmed?: boolean }): Transfer[]`, ordered by id.
  - `open` = PENDING | SENDING | BROADCAST.
  - `unconfirmed` = everything except CONFIRMED.
- `hasOpenTransfers(db, wallet: string): boolean`.
- `claimTransfer(db, id: number, nowIso: string, staleBeforeIso: string): boolean`.
  - In one `BEGIN IMMEDIATE`, it first moves SENDING rows with `claimed_at < staleBeforeIso` back to PENDING.
  - Then `UPDATE … SET status='SENDING', claimed_at=?, attempts=attempts+1 WHERE id=? AND status='PENDING'`.
  - Returns `changes === 1`.
- `updateTransfer(db, id, patch: { status?: "PENDING" | "BROADCAST" | "FAILED"; failure?: TransferFailure | null; nonce?: number; txHash?: string; error?: string | null }): void`.
- `recordTransferReceipt(db, id: number, receipt: { status: "CONFIRMED" | "FAILED"; failure: TransferFailure | null; error: string | null; blockNumber: string; gasUsed: string; gasCostPol: string; gasCostUsd: string }): void`. In one `BEGIN IMMEDIATE`:
  - sets status/failure/error/block;
  - **adds** gasUsed/gasCostPol/gasCostUsd to the row (null = 0);
  - splits gasCostPol/gasCostUsd with `splitShares(0n, …)` over that run's shares whose `destination` matches;
  - **adds** each part to `run_shares.gas_cost_pol/gas_cost_usd`;
  - uses decimal string addition via `toBaseUnits` / `formatUnits` at 6 (POL) and 4 (USD) decimals.
- `retryTransfer(db, id: number, paused: boolean): { ok: true } | { ok: false; reason: string }`. In one `BEGIN IMMEDIATE`, it refuses when:
  - `paused` → "DCA is paused -- resume first";
  - not FAILED → "only a failed transfer can be retried";
  - `failure` not retryable → "<failure> is not retryable -- inspect it by hand".
  - Otherwise: status PENDING, `failure`/`nonce`/`tx_hash`/`block_number`/`claimed_at` NULL, `error = "retry after " + (tx_hash ?? "no tx") + ": " + previous error`, gas columns kept.

- [ ] **Step 1: Write failing tests**

```ts
// validation.test.ts
test("planTransfers: swap delivered in-tx (recipient != wallet) -> no transfers", () => {
  assert.deepEqual(planTransfers([{ destination: DEST, amountOut: 100n }], DEST, WALLET), []);
});
test("planTransfers: one transfer per external destination, summed; DCA-wallet and zero shares skipped", () => {
  assert.deepEqual(
    planTransfers([
      { destination: DEST, amountOut: 100n }, { destination: null, amountOut: 50n },
      { destination: DEST.toLowerCase(), amountOut: 7n }, { destination: DEST2, amountOut: 30n },
      { destination: DEST3, amountOut: 0n },
    ], WALLET, WALLET),
    [{ destination: DEST, amount: 107n }, { destination: DEST2, amount: 30n }]
  );
});

test("planTransfers + splitShares conserve WBTC to the satoshi (prime amountOut, 3 strategies, mixed)", () => {
  const shares = [{ strategyId: 1, amountIn: 10n }, { strategyId: 2, amountIn: 10n }, { strategyId: 3, amountIn: 10n }];
  const dest = [DEST, null, DEST2];
  const split = splitShares(10_007n, null, null, shares);
  const withDest = split.map((s, i) => ({ destination: dest[i]!, amountOut: BigInt(s.amountOut) }));
  const transfers = planTransfers(withDest, WALLET, WALLET);
  assert.doesNotThrow(() => assertWbtcConservation(10_007n, withDest, transfers));
  assert.equal(transfers.reduce((s, t) => s + t.amount, 0n) + withDest[1]!.amountOut, 10_007n);
});
test("assertWbtcConservation rejects one satoshi more or less, anywhere", () => {
  const shares = [{ destination: DEST, amountOut: 100n }, { destination: null, amountOut: 50n }];
  const ok = [{ destination: DEST, amount: 100n }];
  assert.doesNotThrow(() => assertWbtcConservation(150n, shares, ok));
  assertRejects(() => assertWbtcConservation(151n, shares, ok), "amount_out");               // shares short
  assertRejects(() => assertWbtcConservation(149n, shares, ok), "amount_out");               // shares over
  assertRejects(() => assertWbtcConservation(150n, shares, [{ destination: DEST, amount: 101n }]), "transfer");
  assertRejects(() => assertWbtcConservation(150n, shares, [{ destination: DEST, amount: 99n }]), "transfer");
  assertRejects(() => assertWbtcConservation(150n, shares, []), "transfer"); // a share with destination left undelivered
});

// db.test.ts -- shares: #1 DEST amountIn 10_000000, #2 DEST amountIn 30_000000, #3 null amountIn 5_000000
test("confirmScheduledRun writes PENDING transfers atomically; rolled back with the share results", () => { /* ... */ });
test("confirmScheduledRun refuses (and writes nothing) when shares or transfers don't sum to amount_out", () => {
  // results summing to amountOut - 1n -> throws; run still BROADCAST, no share amount_out set, no transfers
  // transfers with amount + 1n -> throws; same
});
test("claimTransfer: only one claimer wins; stale SENDING returns to PENDING", () => {
  assert.equal(claimTransfer(db, id, T0, T0_MINUS_1H), true);
  assert.equal(claimTransfer(db, id, T0, T0_MINUS_1H), false, "second process loses");
  assert.equal(claimTransfer(db, id, T0_PLUS_2H, T0_PLUS_1H), true, "stale SENDING reclaimed");
  assert.equal(listTransfers(db, { wallet: WALLET })[0]!.attempts, 2);
});
test("recordTransferReceipt charges real gas to that destination's shares by amountIn, cumulative over attempts", () => {
  // swap already split: shares #1 0.001000, #2 0.003000, #3 0.000500 POL
  recordTransferReceipt(db, id, { status: "FAILED", failure: "reverted", error: "x", blockNumber: "1", gasUsed: "30000", gasCostPol: "0.000400", gasCostUsd: "0.0002" });
  retryTransfer(db, id, false); claimTransfer(db, id, NOW, STALE);
  recordTransferReceipt(db, id, { status: "CONFIRMED", failure: null, error: null, blockNumber: "2", gasUsed: "50000", gasCostPol: "0.000800", gasCostUsd: "0.0004" });
  const shares = listRunShares(db, WALLET, DATE);
  assert.deepEqual(shares.map((s) => s.gasCostPol), ["0.001300", "0.003900", "0.000500"]); // +0.0012 split 1:3; #3 untouched
  const t = listTransfers(db, { wallet: WALLET })[0]!;
  assert.deepEqual([t.status, t.gasUsed, t.gasCostPol, t.gasCostUsd], ["CONFIRMED", "80000", "0.001200", "0.0006"]);
});
test("retryTransfer: refuses while paused, non-FAILED, and output_mismatch / bad_destination; resets a reverted one", () => { /* ... */ });
```

- [ ] **Step 2: Run** `npm test`. Expected: FAIL (functions not defined).
- [ ] **Step 3: Implement** as specified. Existing `confirmScheduledRun` callers and tests pass `[]`.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(db): transfers table with claim, per-strategy gas and retry`

---

### Task 3: Transfer tx builder and validator

**Files:**
- Modify: `src/wallet.ts` (`buildTransferTx`), `src/validation.ts` (`assertTransferTx`, `transfer(address,uint256)` ABI)
- Test: `src/validation.test.ts`

**Interfaces:**
- Produces:
  - `buildTransferTx(token: \`0x${string}\`, from: \`0x${string}\`, to: \`0x${string}\`, amount: bigint): CallTx`, mirroring `buildApproveTx`.
  - `assertTransferTx(tx: ApprovalTxToValidate, expect: { chainId: number; fromAddress: string; tokenAddress: string; recipient: string; amount: bigint }): void`, in the style of `assertApprovalTx`.
  - Checks: chainId, from, `to` = token, value 0, decodes as `transfer`, recipient equal, amount **exactly** equal.

- [ ] **Step 1: Write failing tests:** accepts the output of `buildTransferTx`. Rejects (`assertRejects(..., "<field>")`) `to` ≠ token, value ≠ "0", `approve` calldata, other recipient, amount + 1n.
- [ ] **Step 2: Run** `node --import tsx --test src/validation.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(validation): build and validate WBTC transfer txs`

---

### Task 4: Send, recover and charge transfers in `dca.ts`; `--transfers` mode

**Files:**
- Modify: `src/dca.ts`
- Test: `src/dca.test.ts` (CLI gate, no network). On-chain behaviour is covered by the fork in Task 7.

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces:
  - `deliverTransfers(db, config, client, account): Promise<void>`.
  - CLI flag `--transfers`: recovery + delivery only, no gate and no purchase. Task 6 forks it.
  - Log lines `sending WBTC transfer` (before `sendRaw`) and `WBTC transfer confirmed` (Task 7 greps them).

- [ ] **Step 1: Destination source.**
  - `execute(...)` and `dryRun(...)` take `destinations: (string | null)[]` instead of `strategyIds`.
  - `realRun` passes `claim.shares.map((s) => s.destination)`. Manual buys and the dry run keep `destinationsOf(db, ids)`.
  - The mixed warning becomes `"strategies in this swap have different WBTC destinations -- swap to the DCA wallet, then one transfer per destination"`.
- [ ] **Step 2: Plan in `finalize`.**
  - On the scheduled branch, compute `splitShares(...)` once and pass `planTransfers(...)` (amounts stringified) to `confirmScheduledRun`.
  - If `confirmScheduledRun` throws a conservation error, call `setPaused(db, { paused: true, reason: "auto-paused: <date> WBTC split does not add up -- <message>" })`, log an error, and rethrow. The run stays BROADCAST, so nothing new is bought until someone inspects it.
- [ ] **Step 3: `deliverTransfers`.**
  - **Paused:** `logger.info("DCA paused -- WBTC transfers wait")`, return.
  - **Order:** iterate `listTransfers({ wallet, open: true })` oldest first.
  - **BROADCAST:**
    - Read the nonce (`latest`) first, then the receipt (same order as `recoverBroadcast`).
    - Receipt → **finalize**.
    - No receipt + nonce consumed → recheck once (`waitReceipt(NONCE_CONSUMED_RECHECK_MS)`), then `recordTransferReceipt` is **not** called (nothing mined). `updateTransfer(FAILED, failure "nonce_consumed", error "nonce N consumed by another tx; <hash> never mined")`.
    - No receipt + nonce free → `waitReceipt(APPROVE_RECEIPT_TIMEOUT_MS)`. Still none → leave it BROADCAST and **stop the loop**, since later nonces would queue behind it.
    - Never FAILED by time: a transfer has no deadline.
  - **PENDING:**
    - `claimTransfer(id, now, now - TRANSFER_SENDING_STALE_MS)`. Lost → skip.
    - Destination check with `parseDestination`. Bad → `updateTransfer(FAILED, "bad_destination")`.
    - WBTC balance check: `getErc20Balance(tokenOut) < amount` → `updateTransfer(FAILED, "insufficient_wbtc", "insufficient WBTC in the DCA wallet")`, no pause.
    - Then `buildTransferTx` → `assertTransferTx` → `simulate` + `assertOutputTransfer(logs, { tokenOut, recipient: dest, minimumAmount: amount })`.
    - Then sign with nonce `pending`, check `signed.gas > MAX_GAS_LIMIT`, `updateTransfer(BROADCAST, nonce, txHash)`.
    - Then log `sending WBTC transfer`, `sendRaw` (errors only logged), and resolve as BROADCAST above.
    - Any throw before BROADCAST → `updateTransfer({ status: "PENDING", error })`, log, `process.exitCode = 1`, continue.
  - **Finalize:**
    - `gasCostPol = gasUsed * effectiveGasPrice / 1e18`, `toFixed(6)`.
    - `gasCostUsd = gasCostPol * Number(run.oraclePolUsd)`, `toFixed(4)`, with `run = getRun(db, wallet, transfer.date)`.
    - Reverted → `recordTransferReceipt(FAILED, "reverted", "transfer reverted on-chain", …)`.
    - Success but `assertOutputTransfer` fails, **or its returned amount `!== BigInt(transfer.amount)`** (exact: no more, no less) → `recordTransferReceipt(FAILED, "output_mismatch", …)` + `setPaused` (same reasoning as the swap's `finalize`).
    - Apply the same exact-amount check to the pre-signing simulation: mismatch → `updateTransfer(PENDING, error)`, nothing signed.
    - Otherwise `recordTransferReceipt(CONFIRMED, …)` and log `WBTC transfer confirmed`.
    - Any FAILED sets `process.exitCode = 1`.
- [ ] **Step 4: Call sites.**
  - At the end of `recoverPreviousDays` (covers later ticks and manual runs).
  - In `realRun`, after `execute` and before `emailReport`.
  - In `main()`, `--transfers` loads the key the same way as a real run, then `await recoverPreviousDays(db, config, client, account, today)` and returns, skipping `isDue` and the day gate.
- [ ] **Step 5: Cron gate.** `if ((status === "CONFIRMED" || status === "FAILED" || status === "PAUSED") && !hasOpenTransfers(db, account.address)) return;`
- [ ] **Step 6: Gate tests** in `dca.test.ts`, following the existing `runCli` pattern:
  - today CONFIRMED + no open transfer → exit 0, no RPC attempted;
  - + a PENDING transfer → passes the gate, fails on the unreachable RPC, exit ≠ 0;
  - `--transfers` with a PENDING transfer before run time → also exit ≠ 0, so it ignored `isDue`.
- [ ] **Step 7: Dry run.** When mixed, print `planTransfers(splitShares(r.simulatedOut, null, null, …))` as `then transfer: <amount> WBTC -> <dest>`. Transfers are not simulated: the WBTC is not in the wallet yet.
- [ ] **Step 8: Run** `npm test && npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 9: Commit** `feat(dca): deliver mixed-destination WBTC by transfer, charging real gas per strategy`

---

### Task 5: POL runway projects the real daily gas

**Files:**
- Modify: `src/db.ts` (`recentTransferGasCostsPol`), `src/health.ts` (`projectedDailyGasWei`), `src/validation.ts` (`expectedTransfersPerDay`), `src/server.ts:109-121`, `src/dca.ts:570`, `public/app.js:620`
- Test: `src/health.test.ts`, `src/validation.test.ts`, `src/db.test.ts`

**Interfaces:**
- Produces:
  - `recentTransferGasCostsPol(db, limit: number): string[]`: `gas_cost_pol` of the latest CONFIRMED transfers, newest first. It includes the gas of earlier reverted attempts, because that is what the day really cost.
  - `expectedTransfersPerDay(destinations: (string | null)[], wallet: \`0x${string}\`, extraForbidden: readonly string[]): number`: 0 unless `resolveRecipient(...).mixed`; otherwise the count of distinct non-null destinations.
  - `projectedDailyGasWei(swapAvgWei: bigint | null, transferAvgWei: bigint | null, transfersPerDay: number): bigint | null`.
    - `null` when `swapAvgWei` is null.
    - Otherwise `swapAvgWei + BigInt(transfersPerDay) * (transferAvgWei ?? swapAvgWei)`. With no transfer history it falls back to the swap average: conservative, it never under-counts.
  - The balance API adds `transfersPerDay: number`. `avgGasPol` now carries the projected daily value.

- [ ] **Step 1: Write failing tests**

```ts
test("projectedDailyGasWei: swap only / with transfer history / without (conservative)", () => {
  assert.equal(projectedDailyGasWei(null, 10n, 2), null);
  assert.equal(projectedDailyGasWei(100n, null, 0), 100n);
  assert.equal(projectedDailyGasWei(100n, 20n, 2), 140n);
  assert.equal(projectedDailyGasWei(100n, null, 2), 300n);
});
test("expectedTransfersPerDay: same/none -> 0; mixed -> distinct external destinations", () => {
  assert.equal(expectedTransfersPerDay([DEST, DEST], WALLET, X), 0);
  assert.equal(expectedTransfersPerDay([null, null], WALLET, X), 0);
  assert.equal(expectedTransfersPerDay([DEST, null, DEST], WALLET, X), 1);
  assert.equal(expectedTransfersPerDay([DEST, DEST2, null], WALLET, X), 2);
});
test("recentTransferGasCostsPol: CONFIRMED only, newest first, cumulative attempts", () => { /* ... */ });
```

- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `server.ts` and `dca.ts::emailFundsAlert` compute `avgGasWei = projectedDailyGasWei(averageGasWei(recentGasCostsPol(...)), averageGasWei(recentTransferGasCostsPol(db, GAS_SAMPLE_RUNS)), expectedTransfersPerDay(<active strategies' destinations>, account, [tokenIn, tokenOut]))`.
  - Active strategies use the same filter as `activeAmounts`.
  - `app.js:620` label: `~X per run` becomes `~X per day${b.transfersPerDay ? ` (swap + ${b.transfersPerDay} transfer${b.transfersPerDay > 1 ? "s" : ""})` : ""}`.
- [ ] **Step 4: Run** `npm test && npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(health): POL runway includes WBTC transfer gas`

---

### Task 6: Visibility and retry (app, email, check)

**Files:**
- Modify: `src/server.ts` (state payload; route `POST /api/transfers/:id/retry`; generalize `startBuy`'s child launcher)
- Modify: `public/app.js`, `public/index.html` (banner)
- Modify: `src/report.ts` (`buildReport(..., transfers: Transfer[] = [])`), `src/dca.ts::emailReport`, `src/check.ts`
- Test: `src/server.routes.test.ts`, `src/report.test.ts`

**Interfaces:**
- Consumes: `listTransfers`, `retryTransfer`, `isPaused` (Task 2); `--transfers` (Task 4).
- Produces:
  - State JSON gains `transfers: Transfer[]` (`listTransfers({ wallet, unconfirmed: true })`).
  - `POST /api/transfers/:id/retry` uses `postJson` + `requireElevation` (TOTP), like the destination route.
    - 404 when the id is unknown.
    - 409 `{ error }` when `buyState.running` ("a purchase or transfer is already running") or `retryTransfer` refuses (its `reason`).
    - Otherwise 202 `{ ok: true }` after forking `DCA_ENTRY` with `["--transfers"]`.
    - `logger.warn("WBTC transfer retry from the app", { id })`.
  - `buyState`/`startBuy` become one child launcher, `startChild(args: string[], meta)`, so a manual buy and a retry never run at the same time.

- [ ] **Step 1: Write failing tests**
  - routes:
    - retry without TOTP → 401/403 (same code as the destination route);
    - retry of a `reverted` FAILED → 202, row now PENDING (stub the fork the way existing app-buy route tests do);
    - `output_mismatch` → 409;
    - unknown id → 404.
  - report:
    - a CONFIRMED run with transfers `[CONFIRMED 107 → DEST, FAILED insufficient_wbtc 30 → DEST2]`;
    - the text contains `Sent 0.00000107 BTC to <DEST>` + polygonscan link, and `NOT sent 0.00000030 BTC to <DEST2> (insufficient_wbtc) -- it is in the DCA wallet; retry from the app`;
    - in `errors` mode the report is still sent when any transfer FAILED.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Banner** (`index.html` + `app.js`), shown when `state.transfers` is non-empty. One row per transfer: date, short destination, BTC amount, status, error, tx link when `txHash`. Then:
    - a **Retry** button only for FAILED with a retryable `failure`; it opens the existing TOTP elevation flow, POSTs, then polls state until the row leaves PENDING/SENDING/BROADCAST;
    - `danger` class for FAILED, neutral for in-flight.
  - **Mixed warning** (`app.js:225`) becomes informational (no `danger`): "Active strategies have different WBTC destinations: the daily swap lands in the DCA wallet and a separate transfer (extra gas, charged to those strategies) sends each share to its destination."
  - **`emailReport`:** sends when `run.status === "FAILED" || transfers.some((t) => t.status === "FAILED")` in `errors` mode.
  - **`check.ts`:** mixed line becomes `today's scheduled swap: mixed destinations -- delivers to the DCA wallet, then N transfer(s)`, plus one line per unconfirmed transfer (`#id date dest amount status failure error`).
- [ ] **Step 4: Run** `npm test && npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(app): show failed WBTC transfers with TOTP retry; report and check list them`

---

### Task 7: Fork scenarios and docs

**Files:**
- Modify: `scripts/fork.sh`:
  - helper `xfer() { sqlite3 "$DB" "SELECT $1 FROM transfers WHERE wallet='$ADDR' ORDER BY id"; }`;
  - rewrite `s_destination_mixed`;
  - new `s_destination_two`, `s_destination_transfer_kill9`, `s_destination_transfer_retry`;
  - add them to `ALL`.
- Modify: `README.md` (line 11 and the "WBTC destination" paragraph), `DECISIONS.md` (new #34; #33 status: "mixed-day behaviour superseded by #34")

- [ ] **Step 1: `s_destination_mixed`.** Strategy 1 → `$recip`, 2 → none. Expect:
  - run CONFIRMED and `xfer status` CONFIRMED;
  - `wbtc $recip` = `share amount_out 1` and `wbtc $ADDR` = `share amount_out 2`;
  - nonce 3 (approve + swap + transfer);
  - `share gas_cost_pol 1` > `share gas_cost_pol 2`, since #1 also paid the transfer;
  - the sum of shares' `gas_cost_pol` = `row gas_cost_pol` + `xfer gas_cost_pol`, within 0.000001 for rounding;
  - **WBTC conservation, exact:** `SELECT SUM(amount_out) FROM run_shares` = `row amount_out` = `wbtc $recip` + `wbtc $ADDR`, and `xfer amount` = `wbtc $recip`.
  - Use a strategy amount that does not divide evenly (e.g. 10 and 5 → weights 2:1), so a rounding remainder exists.
- [ ] **Step 1b:** Apply the same exact sum checks in `s_destination_two`: `Σ share amount_out = row amount_out = Σ wbtc of destinations`, and DCA wallet 0.
- [ ] **Step 2: `s_destination_two`.** Two new addresses, one per strategy: two CONFIRMED transfers, `wbtc $ADDR` = 0, nonce 4.
- [ ] **Step 3: `s_destination_transfer_kill9`.**
  - Use the `start_until_mempool` pattern, waiting for `sending WBTC transfer`, then kill -9. Expect xfer BROADCAST.
  - Mine, then `run dca`. Expect xfer CONFIRMED, same `tx_hash`, nonce 3.
  - The run is already CONFIRMED, so this also proves the cron gate.
- [ ] **Step 4: `s_destination_transfer_retry`.**
  - Mixed day with the DCA wallet's WBTC drained before delivery. Run the swap with automine; before `deliverTransfers` sends, `cast send` the WBTC away using the anvil impersonation helpers already used in fork.sh. If no hook point exists, set the row back to PENDING by SQL after draining.
  - Expect FAILED `insufficient_wbtc`, nonce unchanged.
  - Refill WBTC (impersonate a holder), `sqlite3` set PENDING via `retryTransfer`'s effect (or call it through `node -e`), then `run dca --transfers`.
  - Expect CONFIRMED and `attempts` = 2.
- [ ] **Step 5: Run** `npm run fork -- destination destination_mixed destination_two destination_transfer_kill9 destination_transfer_retry destination_manual destination_bad kill9 funds_low`. Expected: all pass.
- [ ] **Step 6: Docs.**
  - **DECISIONS #34:**
    - context: the user's requests above;
    - decision: Architecture + Global Constraints, including the failure codes, retry rules and gas attribution;
    - trade-offs: not atomic; a failure leaves WBTC in the DCA wallet (the user's own); extra gas per destination, charged only to those strategies; transfers wait while paused; a stuck BROADCAST blocks later transfers until it resolves.
  - **README:** replace "if they differ … stays in the DCA wallet" with the transfer behaviour, the banner/retry, and the runway note.
- [ ] **Step 7: Run** `npm test && npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 8: Commit** `test(fork): mixed-destination transfers, crash and retry; docs: DECISIONS #34`
