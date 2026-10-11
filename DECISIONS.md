# Decisions

Append-only log. A decision that changes **is not edited** — it becomes a new entry that supersedes the previous one, and the old one gets the mark `SUPERSEDED BY #n`.

It exists because the rationale for several of these decisions is expensive to reconstruct and easy to re-litigate. Each entry carries the evidence that supports it, with a date, so nobody has to redo the measurement.

Addresses appear here as **evidence of a check made on a date**, not as an operational source. The operational source is the code (`src/tokens.ts`, `src/config.ts`).

> **Translation note (2026-09-23, E3).** This file was originally written in Portuguese and translated to English as part of making the repository fully English. The translation is the one exception to append-only: same numbering, same content and evidence, no decision rewritten along the way. The Portuguese original is in git history (before E3).

> **Documentation note (2026-10-06).** Operational guidance and stable invariant/roadmap references now live in `README.md`. Links to private development documents were redirected without changing historical decisions. Entries describe evidence available on their dates; later decisions and dated addenda take precedence. In particular, #23 replaces the external output destination, #21 replaces Basic Auth, and #24 replaces free-form manual amounts.

---

## #1 — Input token is USDT0, not "USDT"

**Date:** 2026-09-22
**Status:** accepted

**Context.** The address given for USDT on Polygon was `0xc2132d05d31c914a87c6611c10748aeb04b58e8f`. The original plan called for a boot assertion comparing `symbol()` with the expected string.

**Decision.** The expected symbol is `USDT0`. The boot assertion compares against a value from env (`TOKEN_IN_SYMBOL`), not a string fixed in code.

**Evidence.** `eth_call` on 2026-09-22 against `polygon-bor-rpc.publicnode.com`:

```
symbol()      = USDT0
name()        = USDT0
decimals()    = 6
totalSupply() ≈ 737.161.044
```

The address is correct and is Polygon's canonical USDT — the contract was upgraded to the LayerZero OFT standard on 2025-08-27, and the symbol changed with it. It's a proxy: `implementation()` = `0x90040487a6c9f949c4f07cadcfb0f3b8eeab4229`.

**Consequence.** A naive `symbol === 'USDT'` check would have broken the bot on its first run. Since it's an upgradeable proxy, the symbol may change again — hence the expected value comes from configuration.

---

## #2 — USDT0 instead of USDC as the input token

**Date:** 2026-09-22
**Status:** accepted

**Context.** A first liquidity measurement, looking **only at v3 pools**, suggested USDT0 had shallow pools against WBTC and that switching to USDC would simplify the route. That measurement was incomplete and led to the opposite of the correct conclusion.

**Decision.** Keep USDT0. The direct route is one hop.

**Evidence.** **v4** pools via `StateView.getLiquidity(poolId)` (`0x5ea1bd7974c8a611cbab0bdcafcb1d9cc9b3ba5a`), hooks = `address(0)`, measured on 2026-09-22:

| pair | fee | liquidity L |
|---|---|---|
| WBTC/USDT0 | 0.05% | **71.2e9** |
| WBTC/USDT0 | 0.30% | 9.2e9 |
| WBTC/USDCn | 0.05% | 6.2e9 |
| WBTC/USDCn | 0.30% | 0.095e9 |
| WBTC/USDCe | 0.30% | 0.265e9 |

At ~$86k/BTC that's ~2.09M USDT of local depth in the 0.05% pool, against ~182k for native USDC — about 11× more. Estimated impact for 200/day: ~0.01% vs ~0.11%.

Converting `L` to "stable side" is a valid approximation near the current price; it's good for ranking, not as an exact number.

**Consequence.** The lesson that sticks: measuring only v3 gives the wrong answer, because routing today is dominated by v4. Any future pair re-evaluation must measure v4.

---

## #3 — No approve-to-zero before approve

**Date:** 2026-09-22
**Status:** accepted

**Context.** USDT on Ethereum has the legacy guard `require(!((_value != 0) && (allowances[...] != 0)))`, which forces zeroing the allowance before changing it. If USDT0 on Polygon behaved the same, the bot would need an extra transaction on every allowance adjustment.

**Decision.** Don't implement approve-to-zero.

**Evidence.** Empirical test on 2026-09-22. Found via `eth_getLogs` a holder with a non-zero allowance to Permit2 (a third-party address, allowance ≈ 1.157e77) and simulated via `eth_call` from it:

```
approve(0x000000000022D473030F116dDEE9F6B43aC78BA3, 123456) -> 0x...01  (true)
```

Non-zero → non-zero transition accepted. The legacy guard doesn't exist in this contract.

**Consequence.** Removes code instead of adding it. Worth rechecking if the proxy is upgraded (see #1).

---

## #4 — BTC destination via the `/quote` `recipient` field

**Date:** 2026-09-22
**Status:** superseded by #23 (OUTPUT_RECIPIENT removed, 2026-09-26)

**Context.** The purchased BTC doesn't need to stay in the hot wallet. The obvious alternative would be a `transfer` after the swap — one more transaction, more gas, and a window in which the BTC sits in the hot wallet.

**Decision.** Use the `/quote` `recipient` field. When `OUTPUT_RECIPIENT` is set, the Universal Router delivers the WBTC straight to the destination.

**Evidence.** Uniswap Trading API OpenAPI (`https://trade-api.gateway.uniswap.org/v1/api.json`), schema `receiverWalletAddress`: *"(optional) The wallet address which will receive the output of the swap. If not provided, the output is returned to the `swapper`."* Present in both `QuoteRequest.recipient` and `QuoteOutput.recipient`.

**Consequence.** No extra transaction, no additional gas, and the hot wallet never accumulates BTC. In exchange, `OUTPUT_RECIPIENT` becomes the one configuration field whose mistake is irreversible and would repeat every day — hence the EIP-55 checksum requirement, the warning if it's a contract, the pre-broadcast simulation and the post-receipt assertion.

The honest limit: `assertQuote` validates the **requested** `recipient`, not the one encoded in the Universal Router calldata. What closes that gap is the deterministic test on the fork.

**Addendum (2026-09-22, while implementing A2).** The initially assumed checksum mechanism was wrong. viem's `getAddress()` does **not reject** an invalid EIP-55 checksum — tested empirically: for any upper/lower case combination of a valid hex value (all lowercase, all uppercase, one letter flipped), `getAddress()` silently recomputes and returns the correctly formatted address for that same value. It only throws for genuinely malformed hex (wrong length, character outside `[0-9a-fA-F]`, missing `0x`).

What actually validates the checksum is `isAddress(value, { strict: true })`, which returns `false` when the case doesn't match the expected checksum for that value. `config.ts` uses that function as the gate (rejects on `false`) and only then calls `getAddress()` to get the canonical form.

**And more importantly, a threat-model correction:** the EIP-55 checksum encodes information **only in the letters' case**, derived from a hash of the lowercase address. It adds no redundancy at all to the digits (0-9), which have no case. That means the checksum protects against **a tool that lowercases/uppercases the whole string** (a copy-paste through an environment that normalizes case) — but **does not protect against a digit or letter swapped by mistake while typing**. Any 40-character hex sequence has a valid EIP-55 casing; the checksum doesn't say whether that value is the *right* address, only whether the case matches that specific value.

Practical consequence: the checksum requirement is still worth it (it blocks the error category it really covers, at the cost of one line), but it is **not** the main defense against sending BTC to the wrong address. That defense is the prominent display in `npm run check`, the pre-broadcast simulation, the post-receipt assertion, and — the one that actually guarantees it — the deterministic test on the fork before any real money.

---

## #5 — SQLite via `node:sqlite` instead of JSON files

**Date:** 2026-09-22
**Status:** accepted — supersedes the initial `dca.json` + `control.json` + lockfile design

**Context.** The initial design was a JSON file with atomic writes, a second JSON for the pause flag, and a lockfile with orphan detection by PID. The split into two JSONs existed to guarantee one writer per file, working around the lack of transactions. The argument against a database was "don't add a dependency".

**Decision.** SQLite through `node:sqlite`, in WAL mode, single file.

**Evidence.** `node:sqlite` is stdlib in Node 24 — works without a flag, without a dependency, without a native module to compile. Verified on 2026-09-22:

```
local              node v24.17.0   -> DatabaseSync OK
node:24-alpine     node v24.21.0   -> DatabaseSync OK
```

The "no new dependency" argument that supported JSON no longer exists.

**Consequence.** It's not a format swap, it's code removal — and of the most fragile code:

- **The whole lockfile** disappears, including orphan-lock detection by PID, which is exactly what fails the day the container dies on a `kill -9`.
- **The manual atomic write** and rewriting the whole file on every run disappear.
- **The split into `control.json`** was a symptom of the lack of transactions, not design.
- **The hand-written aggregations** for the app tiles become a query.

The bigger gain is correctness. Claiming the day becomes `INSERT ... ON CONFLICT (wallet, date) DO NOTHING` inside `BEGIN IMMEDIATE`: `changes === 0` means the day was already claimed. **Mutual exclusion and idempotency become the same mechanism**, guaranteed by the primary key, without the TOCTOU window between "read the state" and "decide to buy" that the lockfile tried to plug from the outside.

Trade-offs, both resolved: backup requires `VACUUM INTO` (with WAL, `cp` can capture an inconsistent state), and `npm run export` dumps JSON/CSV so the data is never trapped.

---

## #6 — Authentication is a v1 requirement, not roadmap

**Date:** 2026-09-22
**Status:** accepted — supersedes "bind on 127.0.0.1 without auth"

**Context.** The previous design was a local app, bound to `127.0.0.1`, without authentication — correct for a bare VPS where the history would be checked via `rsync`. The deploy became Coolify, which provisions domain and TLS and exposes the app to the internet.

**Decision.** Mandatory Basic Auth. The app **refuses to start** with an empty `APP_PASSWORD`.

**Consequence.** No insecure default and no "open for now" mode, which is how this ends up forgotten in production. Constant-time comparison (SHA-256 of both sides plus `timingSafeEqual`), per-IP attempt throttle read from the `X-Forwarded-For` the proxy injects, and `/health` as the only open route, with no data in the body.

The pause route is the app's first write, so it has a CSRF guard: the browser resends Basic Auth on a cross-site POST, and requiring JSON plus a custom header forces a preflight.

Known ceiling: single password, no session, no 2FA. Good enough for one user behind TLS. When configuration routes appear, it needs to become a real session.

---

## #7 — WBTC kept, despite the double wrapping

**Date:** 2026-09-22
**Status:** accepted

**Context.** WBTC's `name()` on Polygon returns `"(PoS) Wrapped BTC"`: it's BitGo-custodied WBTC, bridged again through the Polygon PoS bridge. Custody and bridge stacked, on an asset meant for long-term accumulation. That risk is larger than any the rest of the system mitigates — calldata validation protects against a bad swap today, not against the issuer or the bridge three years from now.

**Decision.** Keep WBTC.

**Consequence.** Risk accepted and recorded. Since the input and output tokens come from env and validation is parameterized, migrating to another asset later means changing two variables and re-validating v4 liquidity (see #2).

---

## #8 — RPC: Infura as primary, public as fallback

**Date:** 2026-09-22
**Status:** SUPERSEDED BY #14 — (originally: accepted, supersedes "public RPC only")

**Context.** The initial decision was to start with public RPC only. Then came the question about Infura.

**Decision.** Infura (`https://polygon-mainnet.infura.io/v3/<PROJECT_ID>`) as primary, `polygon.drpc.org` as fallback, via viem's `fallback()` transport.

**Evidence.** Check on 2026-09-22:

- DNS resolves to `polygon-mainnet.infura-router.public.blockchain-networks-1-prod-us-east-1.eks.infura.org`, AWS IPs
- TLS `CN=infura.io`, SAN `*.infura.io`, issuer `Amazon RSA 2048 M04`, valid until 2027-02-01
- Domain `infura.io` registered on 2016-04-15
- Root host without key → `404`; `/v3/<invalid id>` → `401 invalid project id`

Public endpoints tested: `polygon-bor-rpc.publicnode.com` and `polygon.drpc.org` respond. **`polygon-rpc.com` is dead** (`API key disabled, tenant disabled`) and `1rpc.io/matic` requires a paid plan for `eth_simulateV1` — neither works as a default, even though both are obvious choices.

`eth_simulateV1` confirmed working on `publicnode` and `drpc`; on Infura it couldn't be tested without a credential.

**Consequence.** **`RPC_URL` is a secret** — the project ID is in the URL. It joins the list with `PRIVATE_KEY` and `UNISWAP_API_KEY`. This matters more than it seems: viem/undici error messages carry the full URL, so sanitization replaces the known URLs with `<rpc>` in any error string, instead of trusting which fields the library populates. Without it, the first RPC timeout dumps the credential into the Coolify log.

The Chainlink check still does **not** protect against a hostile RPC, because the oracle is read through the same RPC. Closing that is roadmap.

**Addendum (2026-09-22, while implementing B1).** `eth_simulateV1` reconfirmed supported on `polygon-bor-rpc.publicnode.com` -- really tested via `wallet.ts::supportsSimulateV1()` running against real Polygon, not just the earlier raw probe. Instead of leaving the Infura confirmation as a loose TODO, `check.ts` (`npm run check`) now automatically tests `supportsSimulateV1()` against the configured `RPC_URL`.

**Addendum 2 (2026-09-22, Infura PROJECT_ID provided).** `npm run check` ran against the user's real Infura: **`eth_simulateV1` confirmed supported**. Open item closed -- the pre-broadcast simulation (D1) can rely on it on the primary `RPC_URL`, without needing the fallback for that call specifically.

**Side finding, unrelated to this decision:** the well-known test key `0x0101...01` (common in tutorials) has an **active EIP-7702 delegation on Polygon mainnet** -- `eth_getCode` on its derived address returns `0xef0100` + a contract address, not the empty `0x` you'd expect from a fresh EOA. Confirmed by direct `eth_getCode`, it's not a bug in `isContract()`. Noted here only so it isn't rediscovered as a "mysterious bug" later: this specific key must never be used for anything beyond a throwaway local test, and `isContract()` deliberately reports `true` in this case -- that's the correct behavior under EIP-7702, not a read failure.

---

## #9 — Fixed infrastructure addresses (Permit2, Universal Router, Chainlink feeds)

**Date:** 2026-09-22
**Status:** accepted

**Context.** `tokens.ts` (A3) hardcodes these addresses in code -- see the "Repository documents" table entry: "addresses, limits, allowlists" live in code, never in documentation, because docs aren't testable. But these values were verified in this session in conversation text, never committed as evidence in `DECISIONS.md`. Before typing them again into `tokens.ts` (transcription risk in a value that becomes a security allowlist), I re-verified.

**Decision.** Use the addresses below, hardcoded in `tokens.ts`.

**Evidence.** Re-verified on 2026-09-22 against `polygon-bor-rpc.publicnode.com`, chainId 137:

| contract | address | verification |
|---|---|---|
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | `eth_getCode`: 9152 bytes of bytecode |
| Universal Router | `0x1095692a6237d83c6a72f3f5efedb9a670c49223` | `eth_getCode`: 19499 bytes |
| Universal Router 2.1.1 | `0x8b844f885672f333bc0042cb669255f93a4c1e6b` | `eth_getCode`: 24546 bytes |
| Chainlink BTC/USD | `0xc907E116054Ad103354f2D350FD2514433D57F6f` | `description()`="BTC / USD", `decimals()`=8, `latestRoundData()`=85460.60, age -1s |
| Chainlink USDT/USD | `0x0A6513e40db6EB1b165753AD52E80663aeA50545` | `description()`="USDT / USD", `decimals()`=8, `latestRoundData()`=0.9997, age 4s |
| Chainlink POL/USD | `0xAB594600376Ec9fD91F8e885dADF0CE036862dE0` | `description()`="MATIC / USD" (legacy name, correct address), `decimals()`=8, `latestRoundData()`=0.10934, age 29s |

Source of the Universal Router and feed addresses: `developers.uniswap.org/docs/protocols/v4/deployments` (Universal Router) and Chainlink's public feed listing for Polygon -- confirmed here by direct on-chain reads, not just by the documentation.

**Consequence.** `tokens.ts` uses viem's `getAddress()` on each constant when the module loads: any transcription error producing malformed hex breaks boot immediately, instead of silently becoming a wrong address in the allowlist. `tokens.test.ts` pins these exact values as an assertion, without network (see README.md: Development and verification), so an accidental future one-character edit is caught by `node --test`, not in production.

**Addendum (2026-09-22, while preparing C1).** The user shared the command `npx skills add uniswap/uniswap-ai --skill swap-integration`, a third-party skill (Uniswap's official repository) for AI agents. The harness automatically blocked the install (external code); read via GitHub instead of installed.

The content had a **wrong** claim, contradicting what this document already recorded: it claimed `/swap` expects the `quoteResponse` **spread** into the body (`{...quoteResponse, signature}`), when in fact `quote` is a required **nested** field (`CreateSwapRequest.quote`, `oneOf` `ClassicQuote`/`WrapUnwrapQuote`/`BridgeQuote`) -- reconfirmed by fetching the live OAS again, not from session memory. That part of the skill was discarded.

But checking the claim led to finding something real and unrelated to the error: the `x-universal-router-version` header does exist in the OAS, and its enum is `["2.0", "2.1.1", "2.1.2"]` with **default `2.1.2`** -- a redeploy of 2.1.1 with identical calldata, but at its **own address per chain**. The allowlist in `tokens.ts` only had the 2.0 and 2.1.1 addresses. Without 2.1.2, the first real dry-run (C2) would have failed closed in `assertSwapTx` (unknown `to`) -- safe, but a confusing block to debug without this cause in hand.

**2.1.2 address on Polygon**, verified at `developers.uniswap.org/docs/protocols/v4/deployments` and confirmed by `eth_getCode` (24380 bytes of bytecode): `0xDc264714F68d84CF29BC605589405E78bDBE7C9f`. Added to the allowlist.

**Additional decision:** `uniswap.ts` (C1) will pin `x-universal-router-version` explicitly on calls to `/quote` and `/swap`, instead of relying on the API default -- which this very finding proves has already changed once (the integration docs describe the default as having been 2.1.1 before). Pinning prevents a future silent default from invalidating the allowlist again. All three addresses stay in the allowlist as defense in depth.

---

## #10 — Permit TTL: two separate caps, calibrated with real data

**Date:** 2026-09-22
**Status:** accepted — fixes a `MAX_PERMIT_TTL_SECONDS` value wrongly applied to two different fields

**Context.** The original `assertPermit` implementation (A4) used a single `MAX_PERMIT_TTL_SECONDS = 3600` (1h) for **two fields with different semantics** in the Permit2 AllowanceTransfer message: `sigDeadline` (signature validity) and `details.expiration` (on-chain allowance validity, if the permit is executed). The 1h value was chosen without empirical data -- a reasonable guess for `sigDeadline`, but never verified for `expiration`.

**Decision.** Two separate caps: `MAX_PERMIT_TTL_SECONDS` (1h, for `sigDeadline`/`deadline`) and `MAX_ALLOWANCE_EXPIRATION_SECONDS` (35 days, for `details.expiration`).

**Evidence.** A real call to `POST /quote` on 2026-09-22 (real API key, USDT0→WBTC pair, 200 USDT0), the first time `assertPermit` was tested against production data instead of synthetic fixtures, returned:

```
sigDeadline: 1746s out (~29 min)       -- within the 1h cap, comfortably
expiration:  2591977s out (~30 days)   -- FAR beyond the old 1h cap
```

The old code would have **rejected that real quote** for `details.expiration` "beyond the maximum TTL" -- that is, `assertPermit` in its first version would reject every real purchase, not just an edge case. Without testing against the real API before closing C1, this bug would only have shown up in the first dry-run.

**Consequence.** `MAX_ALLOWANCE_EXPIRATION_SECONDS = 35 * 86400` gives margin over the observed value (~30 days) without becoming "no cap". The risk this cap mitigates was already narrow even before the fix: `permitAmount: "EXACT"` limits the authorized amount to the day's purchase, so even a 30-day window only exposes that specific amount. `sigDeadline` stays at 1h, which the real data confirms is generous slack (~29 min observed).

General lesson: a security-policy value that's "reasonable in your head" (README.md invariant #5 already asks for them to live in code, but that doesn't waive calibrating against real data before locking the value). `validation.test.ts` now has an explicit positive case with ~30-day expiration, so this regression never slips by again.

---

## #11 — Private key stays on the server (current design kept)

**Date:** 2026-09-22
**Status:** accepted

**Context.** The user asked whether `PRIVATE_KEY` could be moved off the server by signing via MetaMask.

**Decision.** Keep the current design: `PRIVATE_KEY` on the server, a low hot-wallet balance as the mitigation. None of the alternatives was implemented.

**Evidence for the alternatives evaluated:**

- **MetaMask directly** -- discarded. Requires an open browser and a human clicking "Confirm" on each transaction; incompatible with autonomous daily execution (contradicts the bot's purpose described in README.md).
- **Smart wallet with a restricted session key** (Uniswap Calibur, EIP-7702) -- assessed as harder than the original roadmap suggested. Verified at `developers.uniswap.org/docs/protocols/smart-wallet/concepts/alternative-signers`: added keys are **not** scoped by default ("by default, added keys do not expire and have no hooks"; "a malicious key could steal all of your ETH and tokens"). Real scoping (spend only USDT0, only via the Universal Router, daily cap) depends on the *hooks* system, and `developers.uniswap.org/docs/protocols/smart-wallet/concepts/hooks` explicitly warns that the repository's example hooks **are not production code**. In other words, this path requires writing and auditing our own smart contract -- it's not a configuration flag.
- **Remote custody / MPC** (Fireblocks, Turnkey, Privy, Dfns) -- the most realistic path without writing a contract, but introduces a dependency on a paid third-party provider.
- **WalletConnect + approval on the phone** -- takes the key off the server, but reintroduces a human per swap, giving up daily autonomy.

**Consequence.** No code change. `README.md` (roadmap item 4) updated with this assessment, correcting the earlier text that presented the smart wallet path as simpler than it is. The item stays on the roadmap, no deadline.

**Addendum (2026-09-27).** The private key now lives encrypted in the database (#25), but the app and `MASTER_KEY` still run on the server. Keep only a low hot-wallet balance.

---

## #12 — `MAX_DCA_AMOUNT` removed

**Date:** 2026-09-23
**Status:** accepted

**Context.** `DCA_AMOUNT` and `MAX_DCA_AMOUNT` lived in the same `.env`. Whoever edits one edits the other; the cap only caught a typo in `DCA_AMOUNT` alone. The same pair was checked twice (boot in `config.ts` and `assertAmountWithinBudget` in `dca.ts`).

**Decision.** Remove the env var, the boot check, `assertAmountWithinBudget` and the corresponding tests. Alternative evaluated and discarded by the user: move the cap to a constant in code (would require a commit to change, would really catch a typo).

**What still limits the amount of a purchase:**
- `assertQuote` requires `input.amount` to be exactly equal to `DCA_AMOUNT` -- the API can't inflate the amount.
- `permitAmount: "EXACT"`, checked in `assertPermit` against the same value.
- `approve(PERMIT2, DCA_AMOUNT × APPROVAL_DAYS)` (D1) limits what Permit2 can pull.
- A low hot-wallet balance (7–14 days) is the real loss cap (#11).

**Consequence.** A typo in `DCA_AMOUNT` (e.g. `2000` instead of `200`) passes and buys as far as balance and allowance allow. Accepted. If configuration from the UI (README.md, roadmap item 3) is built, a cap out of the UI's reach becomes necessary again.

**Addendum (2026-09-25).** F1b (#20) adds a per-run cap in code (`MAX_RUN_TOTAL = 1000`). `DCA_AMOUNT` now only seeds strategy #1; strategy amounts live in the database.

---

## #13 — Execution (D1): deadline read from calldata, simulation with output check, recovery without re-broadcast

**Date:** 2026-09-23
**Status:** accepted

**Context.** D1 turns the dry-run into real execution: approve, signing, broadcast, receipt, recovery.

**Decisions and evidence:**

- **The deadline comes from the calldata, not the request.** The OAS says `CreateSwapRequest.deadline` is "the unix timestamp at which the order will be reverted", but the API **ignores** the field: requests for `now+300` and `now+3000` returned the same calldata with `deadline = now+1801`, equal to the permit's `sigDeadline` (test on 2026-09-23 against the real API). `assertSwapTx` decodes `execute(bytes,bytes[],uint256)`, caps the deadline at `MAX_SWAP_DEADLINE_SECONDS` (1h) and returns it; that value is what goes into the database and bounds recovery.
- **Simulation via `eth_simulateV1` (`simulateCalls`), not `eth_call`.** Simulates approve + swap in the same block when there's an approve, and runs `assertOutputTransfer` on the **simulated logs** -- WBTC going to the wrong address is caught before any tx signature exists. The hop through the Universal Router (pool → router → `SWEEP`) is accepted as an intermediary; any other WBTC destination fails.
- **Capped approve also shrinks.** `needsApproval` fires when the allowance doesn't cover the day **or exceeds the cap** (`DCA_AMOUNT × APPROVAL_DAYS`). The inherited unlimited allowance (`type(uint256).max`) becomes the cap on the first real run -- one extra approve tx, once.
- **BROADCAST before sending.** The tx is signed locally (hash known before broadcasting), `BROADCAST` + nonce + hash are recorded, only then `sendRawTransaction`. An error on send marks nothing -- recovery decides.
- **Recovery (`decideRecovery`, pure).** With a receipt: finalize. No receipt and nonce consumed: another tx took the nonce. No receipt and nonce free: wait until `deadline + 120s`; after that the tx would only revert. Never resends. **Order matters:** read the nonce BEFORE the receipt -- in the reverse order, the tx was mined between the two reads on the fork and became a false "nonce consumed" (real bug, caught on the first fork run). Even so, before declaring the nonce consumed, it waits up to 30s for a receipt (lagging node / fallback to another node).
- **An output that doesn't match pauses the DCA.** Tx confirmed but WBTC outside the recipient or below `minimumAmount`: `FAILED` (doesn't count as a purchase in the app) + automatic pause. Repeating tomorrow without understanding why is the worst case.
- **`npm run revoke` also pauses.** Without that, the next run would see allowance 0 and approve again, undoing the revoke.
- **`RPC_URL` accepts `http://` only for `127.0.0.1`/`localhost`** (anvil fork), with an anchored regex so `http://127.0.0.1.evil.com` doesn't pass.

**Verification (anvil fork, 2026-09-23):** full cycle with approve (unlimited → 300 USDT0) + swap → `CONFIRMED` with the whole row; simulated crash after `BROADCAST` → recovery finalizes `CONFIRMED`; second run on the same day does nothing; paused → `PAUSED`; inaccessible database → exits without broadcasting (nonce unchanged); revoke → allowance 0 + pause. Mainnet checked untouched afterwards (nonce and allowance the same).

**Fork artifact, not a bug:** on a fork reused after a swap, the Permit2 nonce diverges from mainnet (1 vs 0) and the API signs the permit with the mainnet nonce -- the simulation fails with `ExecutionFailed(uint256,bytes)`. A fresh fork per scenario (D2) avoids this.

---

## #14 — RPC: one public RPC (drpc), no Infura

**Date:** 2026-09-23
**Status:** accepted — supersedes #8

**Context.** #8 set Infura as the primary RPC with `polygon.drpc.org` as the fallback. In practice `RPC_URL` in `.env` never held a real project ID -- it kept the literal placeholder `.../v3/<PROJECT_ID>`, Infura answered `401`, and viem's `fallback()` silently moved every call to drpc. Everything that ran up to this point (`npm run check`, dry-runs, the D1 fork runs) actually ran on drpc. #8's addendum 2 ("`eth_simulateV1` confirmed on Infura") most likely measured drpc for the same reason.

**Decision.** Use `https://polygon.drpc.org` as the only RPC: `RPC_URL=https://polygon.drpc.org`, `RPC_URL_FALLBACK` empty. The fallback support stays in code (`createRpcClient`), just unused.

**Why.** The bot makes one burst of calls per day, and a missed day is cheap (it fails toward not buying, README.md invariant #6), so a paid provider's extra reliability buys little. drpc is already proven for everything the bot needs, `eth_simulateV1` included. One RPC means the config matches what actually runs -- the problem with #8 was a primary that silently wasn't. Trust is unchanged: the bot trusts whichever RPC answers, oracle reads included (roadmap item 6 still applies).

**Consequence.** No account and no key in the URL; the code still treats `RPC_URL` as a secret, which costs nothing and covers a keyed URL if one is ever used again. If drpc is down or throttling at run time, that day's purchase fails and the next day retries. If that starts happening, add a second RPC in `RPC_URL_FALLBACK` -- no code change needed.

---

## #15 — Gas limit: max(API, own estimate + 20%); fork battery on a throwaway key

**Date:** 2026-09-23
**Status:** accepted

**Context.** D2 automates the fork battery. The first scenario (approve + swap, fresh wallet) passed the `eth_simulateV1` simulation and then **reverted on-chain out of gas**: the API returned `gasLimit` 126100, the swap really needs 212433 (`cast estimate` on the same state; `cast run` shows `OutOfGas` inside the v4 pool's `sync`). `eth_simulateV1` didn't catch it because it runs without the tx's gas limit.

**Evidence.** Same quote shape for the real wallet (read-only, mainnet): API `gasLimit` 273695 vs own estimate 259120 -- accurate, ~5% slack. The difference is whether the API can simulate the swap on mainnet: the throwaway wallet has no Permit2 allowance (nor balance) there, so the API falls back to a short fixed-looking value.

**Why it matters in production, not just on the fork.** The quote is taken **before** our approve is sent. Every `APPROVAL_DAYS` the capped allowance runs out; that day the API sees no allowance at quote time, returns the short fallback, the approve lands, and the swap reverts -- a missed day plus gas, on a schedule.

**Decision.** `signTx` always runs `estimateGas` (after the approve is mined, so it sees the real state) and signs with `chooseGasLimit(api, estimate)` = the larger of the API's value and estimate + 20%. `MAX_GAS_LIMIT` still caps the result. A tx that would revert now fails in `estimateGas`, before `BROADCAST` -- fail closed.

**Fork battery design (`scripts/fork.sh`, `npm run fork`).** One fresh anvil fork per scenario (a reused fork diverges from mainnet's Permit2 nonce, #13). Each scenario uses a **throwaway key** generated on the spot, never `PRIVATE_KEY`: the Uniswap API quotes a swapper with no mainnet funds just fine, and any tx that leaked to mainnet would come from an empty address. Funding is two anvil calls (POL via `anvil_setBalance`, USDT0 via `anvil_setStorageAt` -- balances mapping at slot 0, checked with `balanceOf` right after), so the planned `fund-fork.ts` wasn't needed. The dropped-tx scenario moves the row's `deadline` into the past in the database instead of waiting ~30 min: recovery compares against the wall clock, which anvil can't fast-forward.

---

## #16 — `WALLET_ADDRESS` removed; the address is always derived from `PRIVATE_KEY`

**Date:** 2026-09-23
**Status:** accepted

**Context.** `loadAppConfig()` required `WALLET_ADDRESS` (A5) so the app could run without `PRIVATE_KEY` (Phase 0.5, synthetic data). In practice it stayed empty and blocked the app after the first real swap, while the key that determines it was sitting in the same `.env`.

**Decision.** `WALLET_ADDRESS` no longer exists. `loadAppConfig()` requires `PRIVATE_KEY`, derives the address with `privateKeyToAccount`, and doesn't keep the key. A leftover `WALLET_ADDRESS` in an old `.env` is ignored. One source of truth: the app can't show one wallet's history while the bot buys for another.

**Consequence.** The app, `pause`/`resume`, `export` and `seed` now need `PRIVATE_KEY` in their env. The Phase 0.5 "app with no credentials at all" mode is gone -- accepted: in production the app and the bot share one container and one env (E2), so the key is there anyway.

**Addendum (2026-09-27).** The address is now derived from the encrypted key stored in the database (#25), not from `PRIVATE_KEY` in env. The env key is only a one-time seed for an empty database.

---

## #17 — Manual purchases alongside the daily run

**Date:** 2026-09-23
**Status:** accepted -- refines invariant #2

**Context.** The `(wallet, date)` lock was written as "one purchase per UTC day". The user wants to buy more on some days (buying a dip), and to see the first manual swap (D3) in the production history next to the scheduled purchase of the same day -- impossible with one row per day.

**Decision.** The lock stays exactly as it is, but its meaning is narrowed: it makes the **scheduled** run idempotent (a cron that fires twice, a retry, two processes -- the fork battery's `parallel` scenario). Manual purchases go to a separate `manual_runs` table: same columns, own `id`, `created_at`, no per-day limit. `npm run buy -- --amount X` runs the identical path -- `runVerifiedFlow`, every assertion in `validation.ts`, simulation, BROADCAST before sending -- via one shared `execute()`; only the row differs. Details:
- **Recovery** covers both tables (a `saver(run)` picks the table). A manual BROADCAST is resolved by nonce/receipt like a daily one, by whichever run comes next. A manual PENDING older than 1h is marked FAILED (never broadcast).
- **Paused -> manual buy refused.** Pause is also the revoke's emergency stop; a manual buy while paused would undo it.
- **Approval cap** = `max(DCA_AMOUNT × APPROVAL_DAYS, amount)` (`approvalCapFor`), otherwise a manual buy above the daily cap would approve too little.
- **App/export** show both, newest first, manual rows tagged.

**Known limit.** A manual buy started while the scheduled run is signing can pick the same nonce; one tx replaces the other and recovery marks the loser FAILED (nonce consumed) -- never a double spend, possibly a missed buy. Acceptable for a human-triggered action.

**Verification.** TDD for the database and pure parts (10 new tests), fork battery +4 scenarios (`manual`, `manual_cap`, `manual_kill9`, `manual_paused`), all 11 green. Found on the way: `logger` crashed on an `undefined` field once a secret was registered (fixed, with a test that registers one).

---

## #18 — Email report via Resend; manual buy from the app as a child process

**Date:** 2026-09-24
**Status:** accepted

**Email report (F3).** After each **scheduled** run (not manual buys, not the "day already processed" no-op), one short email: CONFIRMED with amounts, price, deviation, gas, tx link and running totals; FAILED with the error; PAUSED. Resend's HTTP API via `fetch` -- no new dependency, and its test sender (`onboarding@resend.dev`) delivers to the account owner's address with no DNS setup. Rules:
- **Never affects a purchase.** Sent after the run is final; errors are logged and swallowed; exit code unchanged. Fork scenario `report_failure` runs against the real API with a bogus key (401) and checks the purchase still confirms and the key isn't logged.
- **Config never throws for it.** Only one of `RESEND_API_KEY`/`REPORT_EMAIL_TO`, or a malformed address -> a warning and reporting off. A broken email setup must not stop the bot from buying.
- **Hidden like the secrets:** `config.report` is non-enumerable and out of `toJSON`; the API key is registered with the logger. The address lives in env only (the repo goes public, E6).
- The summary math moved from `server.ts` to `report.ts::summarize` (shared by tiles and email), now summing base units before dividing.

**Buy button.** `POST /api/buy {amount}` runs `dca.ts --manual --amount X` in a child process (`fork`), so the button shares every check, BROADCAST-before-send and recovery with the CLI -- no second implementation. One at a time (409 while running); `GET /api/buy` reports running/exit code for the UI to poll; same CSRF guard as pause/resume; amount validated server-side with `parseManualAmount`; the UI asks for confirmation. Paused -> the child refuses (as the CLI does).

**Security consequence.** The app password can now spend: someone holding it can buy BTC with the wallet's USDT0. The BTC still goes to the configured recipient and every price/slippage/oracle check applies, so the worst case is buying at market on a day you didn't choose -- not losing funds. Stronger auth stays in F1.

**Verification.** 9 new unit tests (config + report); fork scenario `app_buy`: CSRF 400, amount 0 -> 400, 202, concurrent 409, manual row CONFIRMED, WBTC matches. Battery 13/13.

---

## #19 — TOTP for sensitive actions, 15-minute elevation, encrypted secrets

**Date:** 2026-09-24
**Status:** accepted — addendum to #6

**Context.** F1 moves the key, the strategies and the limits into the app. With only Basic Auth, a leaked `APP_PASSWORD` would allow raising slippage (sandwich) or replacing the key. #6 anticipated this ("when configuration routes appear, it needs to become a real session").

**Decision.**
- **TOTP** (RFC 6238, SHA-1, 6 digits, 30 s, ±1 step), hand-written with `node:crypto` (`src/totp.ts`). Enrolment in the app with a QR code (Authy / Google Authenticator). Replay protection persisted (`auth_state.totp_last_step`, compare-and-set). Global lockout: 5 wrong codes in a row from any IP → 15 min. Wrong codes count toward a **separate per-IP TOTP throttle** from the Basic Auth throttle -- a correct Basic Auth does not clear it. A failed code submitted during an active global lockout does not extend the lock (the 15 min window is fixed from the 5th failure, not sliding). Every TOTP field in the API (request body, response) is named `totp`, kept consistent across enrol/verify/unlock routes.
- **Elevation window:** a valid code sets an in-memory token cookie (`HttpOnly; Secure; SameSite=Strict; Path=/api`), fixed 15 min. Basic Auth still required on every request; no login session.
- **Secrets encrypted at rest:** AES-256-GCM, `MASTER_KEY` from env (32 bytes base64), secret name as AAD (`src/crypto.ts`). The app refuses to start without it, or if a stored secret doesn't decrypt.
- **QR library vendored**, not an npm dependency and not a CDN: `public/vendor/qrcode.js` is `qrcode-generator@2.0.4`'s `dist/qrcode.js` UMD build (MIT), sha256 of the original file (before the vendoring comment was prepended): `79ec86f82856005b1c887905cfccfcfbec3821ca61c7fd5a952faa5f778f791c`. A third-party script on the page that shows the TOTP secret (and, from F1d, accepts the private key) would be a supply-chain hole. CSP `script-src 'self'`; the inline script moved to `public/app.js`.
- **Reset:** `npm run totp-reset` (container: `node dist/scripts/totp-reset.js`).

**Known ceiling.** The first enrolment is protected only by the password. `MASTER_KEY` and the database on the same server: encryption protects files, exports and backups, not a compromised server. `MASTER_KEY` must be backed up. The per-IP TOTP throttle keys on the first `X-Forwarded-For` entry, like the Basic Auth throttle -- a client can influence it; the global lockout (5 wrong codes / 15 min, any IP) is the real brute-force control.

---

## #20 — Strategies: several budgets, one swap per day, exact split

**Date:** 2026-09-25
**Status:** accepted — extends #17; covers README.md roadmap item 1 with one wallet and several strategies

**Context.** Several DCA budgets can run at once, each with its own amount, history and optional end date or maximum total. The same hot wallet and private key fund them.

**Decision.**
- The day's eligible strategies are summed into **one scheduled swap**. `run_shares` records each strategy's input at claim time and its proportional WBTC and gas after confirmation. `splitShares` floors each part and gives the remainder to the largest input share (lowest strategy ID on a tie), so the parts sum exactly to the on-chain total.
- `claimScheduledRun` takes the `(wallet, date)` lock and each `(strategy_id, date)` share in one `BEGIN IMMEDIATE`. A strategy created after today's swap starts tomorrow. A new wallet cannot buy a strategy that already received a share today.
- A **1000 USDT0 per-run cap** lives in code (`MAX_RUN_TOTAL`). The API refuses a create or edit that would push the active total above it; the bot fails closed if the database is changed out of band.
- End date and max total are optional and editable. A final scheduled share buys only the remaining budget. Reaching a limit marks the strategy `completed`; increasing or clearing the limit can reactivate it. Manual Stop is final. Deletion requires a stopped or completed strategy and no purchase in flight. `runs` rows remain for recovery.
- Global pause uses `control.wallet = '*'` and applies regardless of the wallet key. `DCA_AMOUNT` seeds strategy #1 once; thereafter the database is authoritative.

---

## #21 — Login session (30 days) replaces Basic Auth; TOTP only for dangerous operations

**Date:** 2026-09-25
**Status:** accepted — supersedes the "Basic Auth on every request" part of #6 and #19

**Context.** Basic Auth was asked for again after every browser restart, and TOTP opened a 15-min window for strategy changes only -- the manual buy (`POST /api/buy`) had no second factor.

**Decision.**
- **Login:** `POST /api/login` with the password and, once an authenticator is enrolled, a TOTP code -> `dca_session` cookie (`HttpOnly; Secure; SameSite=Strict; Path=/`), **30 days, fixed expiry** (not extended by use). A code at login also opens the 15-min elevation window.
- **Sessions in the database** (schema v6, `sessions`), only `sha256(token)` stored, so a restart/redeploy doesn't log out and a database copy can't be replayed as a cookie. `POST /api/logout` (this device), `POST /api/logout-all` (every session).
- **Basic Auth removed**, not kept as a fallback: one auth path, and a password alone no longer reads the app once TOTP is enrolled. The fork scenario `app_buy` and the route test log in through `/api/login` (curl cookie jar).
- **Without a session**, only `/health`, `/api/login`, `/`, `/app.js` and `/vendor/qrcode.js` answer -- the page and scripts carry no data; the page shows its own login form on the first 401.
- **TOTP (elevation window or a code in the body) required for:** manual buy, global resume, strategy resume, create/edit/stop/delete. **Not** for pause (global or strategy) -- the safe direction, README.md invariant #6.
- **Throttle:** wrong password -> per-IP backoff (the existing map). The password is checked before the code, so a password guesser never touches the global `TotpLockout`. Session checks aren't throttled (256-bit token).

**Known ceiling.** Before enrolment the password alone logs in (bootstrap, same exposure as before F6). A stolen session cookie gives read access and pause for up to 30 days, but nothing dangerous without a TOTP code; `logout everywhere` revokes it. `Secure` cookies need HTTPS or `localhost` -- plain `http://<LAN IP>` won't keep a session.

---

## #22 — Balance health panel: the app reads the chain, read-only

**Date:** 2026-09-25
**Status:** accepted — relaxes "server.ts deliberately doesn't use RPC" (A5)

**Context.** F7: show whether the wallet can keep paying the active strategies (USDT0, gas, Permit2 allowance) without running `npm run check` by hand.

**Decision.**
- `GET /api/balance` (session required) reads USDT0 balance, POL balance and the USDT0 -> Permit2 allowance with the same `wallet.ts` functions as `npm run check`. Nothing is signed; the app still never loads a signer.
- RPC settings come from `loadConfig()` -- the full bot config, present in the container because it also runs the scheduled task. If it doesn't load, the app still starts and the panel says "unavailable" (history and control never needed RPC). `loadConfig()` registers `RPC_URL` as a secret, so a logged network error is redacted (checked: `URL: <redacted>`).
- Chain reads cached 60 s in memory, **failures included**, so an RPC outage doesn't turn page loads into more RPC calls.
- Math is pure (`src/health.ts`, TDD): USDT0 runway = floor(balance / sum of active amounts); gas runway = floor((POL - MIN_POL_BALANCE) / average swap gas of the last 10 confirmed scheduled runs) + 1, because `dca.ts` checks the minimum before spending; allowance below the next total = warning (the next run approves again, routine every `APPROVAL_DAYS`), never critical. Status: critical < 1 run, warning < 7 (`RUNWAY_WARNING_DAYS`), else ok. Runs-out date = the first scheduled run it can't pay (the next run is tomorrow, UTC).

**Known ceiling.** Manual buys aren't in the runway (they're ad hoc); the gas average ignores the occasional approve tx.

---

## #23 — Settings in the database, hard caps in code, 15-minute cron gate

**Date:** 2026-09-26
**Status:** accepted — supersedes #4; addendum to #12

**Decision.**
- Shared settings (run time, slippage, price impact, oracle deviation, approval days, min POL balance) live in a single `settings` row (schema v7), edited in the app behind TOTP (#19, #21). Seeded once from the old env vars (all five or none; a partial set or an out-of-cap value refuses to run). A dry-run reads them from the env without writing, like it never seeds strategies.
- Hard caps in code (`SETTINGS_CAPS`): slippage ≤ 2 %, price impact ≤ 3 %, oracle deviation ≤ 5 %, approval days 1–90, min POL 0–100, run time on quarter hours. The server sends them to the frontend (native `min`/`max`/`step`) and validates every save; `loadSettings` re-validates the stored row on every run.
- Coolify's Scheduled Task runs every 15 minutes; `dca.ts` exits silently -- no network call, no log -- before `run_time`, and once today's run is final (CONFIRMED/FAILED/PAUSED). PENDING/BROADCAST still go through recovery. No scheduler in the app process: a crashed web server can't skip a purchase, and a restart catches up on the next tick.
- `OUTPUT_RECIPIENT` removed: the WBTC always stays in the DCA wallet (a changeable destination is the one setting that turns a leaked app password into theft). A non-empty `OUTPUT_RECIPIENT` in env refuses to run. Fork scenario `destination` removed; `not_due`, `not_configured`, `bad_env` added.
- The balance panel (#22) takes `min POL balance` from the settings row.

---

## #24 — A manual buy spends the strategy's configured amount

**Date:** 2026-09-26
**Status:** accepted — amends #17 (the manual amount was free until now)

**Context.** The amount is already part of each strategy; a free-form amount on the buy button was a second, unbounded way to spend the wallet (only the per-strategy max total limited it).

**Decision.**
- Manual buy = pick a strategy, confirm "Buy <its amount> USDT0 into <label>?", TOTP (#21). The app has no amount field.
- `claimManualRun` derives the amount under its write lock: the strategy's amount, or only what's left of its max total (same `nextShareUnits` rule as the final scheduled share); nothing left -> refused. `manualBuyUnits` is the single formula (claim, API preview, dry-run).
- `POST /api/buy` takes only `strategyId`; a body `amount` is refused (400), never trusted. The CLI `npm run buy -- --strategy <id>` refuses `--amount`.
- To buy a different amount: edit the strategy (or create a paused one used only for manual buys -- a paused strategy's amount isn't in the daily total).

---

## #25 — Private key stored encrypted in the database, replaceable from the app

**Date:** 2026-09-27
**Status:** accepted — addendum to #11 and #16; production rollout pending

**Decision.** Store the key as `secrets.private_key`, encrypted with AES-256-GCM under `MASTER_KEY` (#19). An optional `PRIVATE_KEY` in env seeds an empty database once; after that, the stored key takes precedence. The app accepts replacement through a write-only field behind session authentication and TOTP elevation (#21). No route returns the key. The app derives the displayed address from the stored key (#16). Replacement is refused while any purchase is PENDING or BROADCAST, so recovery stays bound to the wallet that started it.

**Consequence.** A fresh deployment can be configured in the app with infrastructure env only: `APP_PASSWORD`, `MASTER_KEY`, `UNISWAP_API_KEY`, `RPC_URL`, `DB_FILE`, `APP_PORT` and `TOKEN_*` (plus optional report and fallback RPC settings). The database stores ciphertext, and exports do not include the key. A compromised server that can access both the database and `MASTER_KEY` can still recover it (#11); keep a low hot-wallet balance. Losing `MASTER_KEY` makes the stored key unreadable, so keep independent backups of `MASTER_KEY` and the private key outside the server.

**Verification boundary.** Local key handling and the 22-scenario fork battery passed. Production migration, removal of the legacy Coolify `PRIVATE_KEY`, a subsequent confirmed purchase, and the user's backup confirmation remain pending (see the dated verification addendum below).


**Verification addendum (2026-10-06).** The implementation is complete. Recorded production evidence includes the snapshot/export and healthy deploy on 2026-09-27, two successful previews on 2026-09-28, removal of legacy `PRIVATE_KEY` runtime/preview variables and healthy redeploy, and the user's confirmation of independent key backups. The historical boundary above no longer describes those completed steps. Explicit documentation of a scheduled purchase after key removal and the browser/TOTP replacement check remain outstanding; this addendum does not claim new production verification.

---

## #26 — Email report mode lives in its own table, default "all"

**Date:** 2026-10-01
**Status:** accepted — extends #18 (report after scheduled runs)

**Decision.** `report_pref` (schema v8) holds one row with `mode`: `all`, `errors` (only FAILED runs) or `off`. No row means `all`, so every existing install keeps its reports through the migration. `POST /api/report` sets it with the login session and CSRF guard only, no TOTP (user decision, 2026-10-01): it moves no funds. Trade-off: a stolen session could silence failure emails. `dca.ts` reads it after the run is final and skips the send (logged) when the outcome isn't covered; PAUSED counts as a normal outcome, not an error. A missing Resend config still means no email in any mode, and `GET /api/settings` reports `reportConfigured` (a boolean, never the key or address) so the app can say so.

**Why not a `settings` column.** `Settings` is validated as a whole and compared deep-equal in many places; a notification preference is not a trading cap, and a separate row works before the settings row exists.

---

## #27 — "Stopped" merged into "completed"

**Date:** 2026-10-01
**Status:** accepted — amends #19/F1b strategy lifecycle

**Decision.** A strategy is `active`, `paused` or `completed`. Ending one by hand (the app's "Complete" button) and reaching its end date or max total are the same state; `stopped` no longer exists. Schema v9 turns every `stopped` row into `completed` (end time kept); the column CHECK still lists `stopped` because SQLite can't alter it, and nothing writes it.

**Revival.** `stopped` used to be final; `completed` was revivable. The merged state is revivable, with two guards: moving a limit (later end date, higher or cleared max total) reactivates it automatically only if no limit still applies, and editing just the label or amount leaves it completed (otherwise a limitless, hand-completed strategy would restart on any edit). The app's "Reactivate" button sends `status: "active"` behind TOTP, refused while a limit is still reached. Deleting history still needs `completed`.

---

## #28 — Manual Permit2 approve is a one-shot top-up

**Date:** 2026-10-01
**Status:** accepted — extends #17 (approval cap)

**Decision.** `npm run approve -- <amount>` sets the USDT0 -> Permit2 allowance to exactly `<amount>` (positive decimal, ceiling `MAX_APPROVE_AMOUNT` in `validation.ts`, never unlimited), through the usual `assertApprovalTx` -> simulate -> sign -> receipt path. It does not pause and is allowed while paused: an allowance alone moves nothing, every swap still passes `validation.ts`.

**Shrink kept.** `needsApproval` is unchanged, so a scheduled run that finds allowance above the cap (day total × `approval_days`) shrinks it back. The top-up lasts until the next run; to keep a larger allowance, raise `approval_days`. User was unsure (2026-10-01), so the smaller change won; revisit if a persistent top-up is wanted.


---

## #29 — Installable PWA: shell-only cache, no push

**Date:** 2026-10-01
**Status:** accepted — F11

**Decision.** The app ships a web manifest (`display: standalone`), icons and a service worker (`/sw.js`, no auth, `Cache-Control: no-cache`). The worker caches only the static shell listed in `SHELL` (page, `app.js`, QR vendor, manifest, icons), network first, cache only when the network fails. It never touches `/api/*`, login or any authenticated response, so balances and history always come from the server (invariant 6: stale data must not look live). Offline, the page opens from the cached shell and shows an "Offline" banner. A test checks that the cache list has no `/api` path and that every listed file is served.

**Out of scope.** Push notifications: email reports (#18, #26) stay the alert channel. No new dependency; CSP unchanged (the worker is same-origin, falls under `script-src 'self'`). Install works over HTTPS (production domain) and `localhost`, not plain LAN `http://` (cookies are `Secure`).


---

## #30 — Main screen: hash routes, one page per strategy

**Date:** 2026-10-01
**Status:** accepted — F10

**Decision.** The app is one page with three hash routes, no reload, browser back works: home (`#`) shows the strategy cards, a one-line wallet health (details open on their own only on warning/critical/unavailable), tiles and history for all strategies; `#s/<id>` is one strategy's page (its card, "Buy N USDT0 now" as the only primary action, a native `popover` "⋯" menu with Pause/Resume/Edit and, below a separator, Complete/Delete history; its own tiles and history); `#settings` (⚙ in the header) holds global Pause/Resume, authenticator, sessions, wallet key, settings and email report. The header also shows the TOTP state (🔒 / 🔓 N min) linking to `#settings`. The pause and setup banners sit outside the views, so they show everywhere.

**Why.** The old strategy bar mixed up to five buttons, destructive next to routine; history sat under admin panels; manual buy had its own strategy select. Per-strategy pages were the user's suggestion during the work (2026-10-01) and replace the "selected card" state. Global pause lives in `#settings` (two taps) rather than the header: it's rare, and the banner already says when it's on. Frontend only, no backend or API change.

## #31 — Low-funds email alert after the scheduled run

**Date:** 2026-10-06
**Status:** accepted — F15

**Decision.** After the scheduled run's report, `dca.ts` reads the USDT0 and POL balances again and runs `health.ts::fundsAlert` on the same runway math the app shows: alert when either resource covers `alert_days` runs or fewer, and always when it covers 0 (the next run can't be paid). `alert_days` is a column on `report_pref` (schema v10, 0-30, default 2), set through `POST /api/report` with the session + CSRF guard, no TOTP, like the report mode (#26). The alert ignores the report mode: an empty wallet is the one case the user always wants to hear about. It needs the Resend config, and like reports a failure is logged and never changes the run.

**Why after the scheduled run.** The run happens once per UTC day, so the alert needs no "already sent" state and can't repeat on every 15-minute tick. Reading after the swap counts today's spend. The allowance runway is left out: a low allowance only means another approve, not missing funds.

**Trade-off.** If the scheduler never runs, no alert either (the watchdog stays deferred). A wallet that empties between runs, such as after a manual buy, is reported after the next scheduled run.

