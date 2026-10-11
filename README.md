# Daily BTC DCA bot

Buy WBTC on Polygon with USDT0 through the Uniswap Trading API. Active strategies share one daily swap; the bot splits its output and gas costs between them. A password-protected app shows history, invested amounts, accumulated BTC, average cost, unrealised revenue, and wallet health.

Node.js 24+, TypeScript, SQLite (`node:sqlite`), and `viem`. The HTTP server, tests, encryption, and email client use Node's standard library. Docker runs the app as a non-root user; an external scheduler runs the purchase process.

## How it works

- One scheduled swap per wallet per UTC day. Each active strategy gets at most one scheduled share for that date.
- Strategies have a daily amount, optional end date, and optional total investment limit. The final purchase can use only the remaining budget.
- WBTC stays in the DCA wallet. A separate output recipient is not supported.
- Manual buys are separate from the daily lock and spend the chosen strategy's amount, subject to its remaining budget. A paused strategy can be bought manually; global pause blocks purchases.
- SQLite records the nonce and transaction hash before broadcast. Recovery checks chain state instead of blindly sending again.
- Chainlink prices, router/token allowlists, bounded approvals, and pre-broadcast simulation are checked before signing transactions. Infrastructure addresses and limits are defined in `src/tokens.ts` and `src/validation.ts`; token configuration is in `.env.example`.

This is a hot-wallet bot. Its encrypted private key and decryption key are accessible to the server. Use a dedicated DCA wallet with a limited balance; the app's controls do not protect against a compromised server or stolen wallet key. WBTC adds custody and bridge risk, and USDT0 can be frozen by its issuer. The oracle is read through the same RPC client used for other chain reads.

## Install and configure

Prerequisites: Node.js 24 or newer, npm, a Uniswap Trading API key, and a Polygon RPC supporting `eth_simulateV1`. Docker is optional for local use. Start in the repository root:

```sh
npm ci
cp .env.example .env
chmod 600 .env
mkdir -p data
```

Edit `.env` before starting. Replace placeholders and set a unique password and master key. Generate the master key locally:

```sh
openssl rand -base64 32
```

Store the result as `MASTER_KEY`. Keep an independent copy outside the server, separate from a backup of the wallet's private key. Do not regenerate `MASTER_KEY` on redeploy: it decrypts both the stored wallet key and authenticator secret.

| Variable | Purpose |
|---|---|
| `APP_PASSWORD` | Required; at least 12 characters. Password for the single-user app. |
| `MASTER_KEY` | Required for the app and signer; exactly 32 random bytes encoded as base64. |
| `UNISWAP_API_KEY` | Required for purchases and the full bot configuration. |
| `RPC_URL` | Polygon RPC over HTTPS; loopback HTTP is accepted for local forks. |
| `RPC_URL_FALLBACK` | Optional second HTTPS RPC. Leave empty to disable fallback. |
| `TOKEN_IN`, `TOKEN_IN_SYMBOL`, `TOKEN_OUT`, `TOKEN_OUT_SYMBOL` | Use the Polygon USDT0/WBTC configuration supplied in `.env.example`. Symbols and decimals are checked on chain. |
| `DB_FILE` | SQLite path; `./data/dca.db` locally, `/data/dca.db` in the container. |
| `APP_PORT` | Listening port; use the supplied default or update the proxy and health check to match. |
| `RESEND_API_KEY`, `REPORT_EMAIL_TO` | Optional; both must be valid to enable email reports. |
| `REPORT_EMAIL_FROM` | Optional sender; use a sender allowed by your Resend account. |

The app can serve history and setup with only `APP_PASSWORD`, `MASTER_KEY`, `DB_FILE`, and `APP_PORT`; wallet health is unavailable until the full bot configuration is valid. A purchase also needs saved settings and a stored private key.

The example leaves legacy seed variables commented out. Configure settings, strategies, and the wallet through the app. For migration only, `DCA_AMOUNT` seeds the first strategy, all five legacy trading settings must be provided together or omitted together, and `PRIVATE_KEY` seeds an empty encrypted-key record. Existing database values take precedence; remove legacy seed variables after migration. A non-empty `OUTPUT_RECIPIENT` is rejected.

## First-run setup

Run the app:

```sh
npm run app
```

Open `http://localhost:8787` if using the default port. The server listens on all IPv4 interfaces; use localhost access during local setup and HTTPS behind a proxy for remote access. Session cookies are `Secure`; plain HTTP on a LAN address does not work for login.

1. **Authenticator:** log in with `APP_PASSWORD`. Before enrolment, the password alone permits setup. Open Settings, enrol an authenticator using the QR code, and confirm its six-digit code. Later logins require password and TOTP.
2. **Settings:** save slippage, price impact, oracle deviation, approval days, and the minimum POL balance. The form enforces caps provided by the server; the backend validates them again. The app saves the scheduled run time as **00:00 UTC**; it has no run-time field.
3. **Strategy:** create a strategy with its daily USDT0 amount. Label, end date, and max total are optional. A new strategy is active; keep the external scheduler disabled during setup.
4. **Wallet key:** enter the dedicated wallet's private key in Settings. The write-only field never returns the key. Compare the derived address with an independent wallet record. Back up the private key outside the server before funding it.
5. **Funding and checks:** fund that wallet with Polygon USDT0 and enough POL for gas. Verify balances and allowance using `npm run check`, then review a dry-run before enabling the scheduler.

The app uses fixed 30-day login sessions stored as token hashes in SQLite. TOTP opens a separate 15-minute elevation window for buys, resume, strategy changes, settings, and key replacement; a restart clears elevation but preserves login sessions. Pause needs only a login session. Email mode also needs only a session. Logout revokes this device; "Log out everywhere" revokes every login session.

## Preview and execute

| Command | Effect |
|---|---|
| `npm run check` | Reads chain ID, token metadata, balances, allowance, oracle feeds, destination, and simulation support. Signs nothing; the database is opened and may be created or migrated. |
| `npm run dca -- --dry-run` | Quotes and simulates the active strategies' total. May sign Permit2 typed data in memory; broadcasts nothing and does not claim a purchase. Opening the database may create or migrate it. |
| `npm run buy -- --strategy 1 --dry-run` | Previews a manual buy for strategy 1 with the same signing boundary. |
| `npm run dca` | Executes today's scheduled purchase when due, or recovers an unfinished one. May approve and swap real funds. |
| `npm run buy -- --strategy 1` | Executes an extra manual buy using strategy 1's configured amount. May approve and swap real funds. |
| `npm run pause -- "maintenance"` | Sets global pause in SQLite; does not change chain allowance. |
| `npm run resume` | Clears global pause; permits future scheduled/manual execution. |
| `npm run revoke` | Pauses first, then sends an on-chain approval setting Permit2's USDT0 allowance to zero. |
| `npm run approve -- 50` | Sets Permit2's allowance to the requested USDT0 amount; sends a transaction, including while paused. |
| `npm run --silent export` | Prints purchase history as JSON; it does not export settings, strategies as configuration, sessions, or encrypted secrets. |
| `npm run totp-reset` | Deletes authenticator enrolment so it can be set up again. Requires trusted server access. |

CLI execution relies on server access and does not prompt for app TOTP. Inspect dry-run output before running commands that move funds. A preview can run even when the real scheduled run is already processed or paused; its output explains that condition.

Scheduled approval caps are based on the day's total and saved approval days. The optional `approve` command is a one-shot change: the next purchase can replace an allowance above the configured cap with that cap. Raise approval days in Settings if you want a larger regular allowance. Revocation does not move WBTC or protect against someone holding the private key.

For an existing history export from this bot, `npm run import-manual -- <base64>` accepts a base64-encoded JSON array of exported runs (or the `IMPORT_ROWS` environment variable). It imports only CONFIRMED rows, skips transaction hashes already stored, and assigns the history to strategy 1 unless `IMPORT_STRATEGY` is set. This changes history, not chain balances; it is not a full database restore and does not validate arbitrary third-party input. Use only a trusted export after backing up the database.

## Dashboard and reports

Home shows all-strategy totals and history, with active strategies selected by default. Combine Active, Paused, and Completed filters to show other strategies. Open a card for its own totals, history, and buy button. Complete retains history; deleting history is restricted to completed strategies and is irreversible. Settings holds global controls, authenticator, sessions, wallet key, trading settings, and email mode.

"Revenue" is unrealised: accumulated BTC × the latest confirmed purchase's stored BTC/USDT0 oracle price, minus invested USDT0. Its percentage divides that result by invested USDT0. It excludes gas and uses the latest recorded purchase price, not a continuously refreshed market quote. Missing data shows no result. Deposits, withdrawals, or external wallet trades are not reconciled into these strategy totals.

Wallet health reads balances with a short cache. USDT0 runway uses active strategies' daily need; gas runway estimates from recent recorded swap costs and excludes manual future purchases and occasional approval gas. An RPC outage shows unavailable rather than inventing a balance. Run dates use UTC; the app displays times in the browser's local timezone.

Email modes are **All**, **Errors only** (FAILED runs), and **Off**. The default is All. Missing/invalid email configuration disables sending without blocking purchases. Reports cover scheduled outcomes, including PAUSED in All mode; manual buys do not email. Provider failures are logged and never change the purchase outcome. The bot has no watchdog for a scheduler that never starts and no guaranteed retry/delivery queue. A single-strategy email omits the "By strategy" section; multiple strategies get labelled shares.

**Low-funds alert.** After each scheduled run the bot reads the wallet once more and emails when USDT0 or POL (gas) covers that many daily runs or fewer, using the same runway math as wallet health. The threshold is set in the app's Email report panel, 0-30 days, default 2; 0 means only when the next run can't be paid. Running out always emails, whatever the threshold or report mode. It needs the same Resend configuration, sends at most one alert per day, and never affects the purchase.

The app is an installable PWA over HTTPS or localhost. Its service worker caches only the static shell; it does not cache API data. Offline mode does not provide live balances or execution. Phone installability and inbox delivery should be checked on the deployment where you use them.

## Docker and Coolify

Build the supplied Dockerfile. It compiles TypeScript and installs runtime dependencies, then starts `node dist/src/server.js` as user `node`.

```sh
docker build -t uniswap-dca-bot .
```

For Coolify:

1. Select the repository and Dockerfile build pack. Set the internal port to match `APP_PORT`.
2. Add the infrastructure variables as **runtime-only** variables. Do not pass secrets to the build. Set `DB_FILE=/data/dca.db`; omit legacy settings and `PRIVATE_KEY` for app-led setup.
3. Mount a persistent **named volume** at `/data`. Docker initializes a new named volume from the image's directory ownership. A host bind mount needs ownership writable by the container's `node` user; SQLite also needs to create `-wal` and `-shm` files in that directory. An existing volume retains its existing ownership.
4. Configure an HTTPS domain. Use `/health` for health checks and `127.0.0.1` as the check host; the server binds IPv4, and Alpine's `localhost` can resolve to IPv6 first.
5. Deploy, finish first-run setup, and check persistence across a redeploy before enabling scheduled purchases.
6. Add a Scheduled Task running `node dist/src/dca.js` with cron `*/15 * * * *` in UTC. It runs inside the app container with the same env and database. The saved run-time gate is 00:00 UTC; later ticks are quiet once the day's status is final. Do not add a second scheduler against a separate database.

The Docker health check confirms HTTP availability, not successful purchases, funded balances, email delivery, or scheduler operation. Check scheduled-task logs and recorded outcomes separately. Redeploys restart the container; avoid deploying during a purchase or unresolved broadcast.

Docker `--env-file` does not parse inline comments like Node's `.env` loader. If running the image directly, prepare a private runtime env file with values only, no inline comments, and a persistent `/data` volume. Inside the image, use compiled entrypoints instead of npm's development scripts:

```sh
node dist/src/check.js
node dist/src/dca.js --dry-run
node dist/src/control.js pause "maintenance"
node dist/scripts/export.js
```

## Backup and recovery

Back up three things independently: a consistent SQLite snapshot, `MASTER_KEY`, and the wallet's private key. The SQLite file contains settings, strategies, history, sessions, and encrypted secrets. JSON history export is useful for inspection, but cannot restore a configured deployment. Keep backups private; history includes wallet addresses and transactions. Automatic backups are not included.

Use SQLite's `VACUUM INTO` for an online snapshot rather than copying the live database file while WAL writes may be in progress. From the repository root, with your local env and database configured:

```sh
task_snapshot="data/dca-$(date -u +%Y%m%dT%H%M%SZ).db"
node --env-file=.env --input-type=module - "$task_snapshot" <<'NODE'
import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
const target = process.argv[2];
const db = new DatabaseSync(process.env.DB_FILE);
try {
  db.exec("VACUUM INTO '" + target.replaceAll("'", "''") + "'");
  chmodSync(target, 0o600);
} finally {
  db.close();
}
const snapshot = new DatabaseSync(target, { readOnly: true });
try {
  console.log(snapshot.prepare('PRAGMA integrity_check').get());
} finally {
  snapshot.close();
}
NODE
```

In a container terminal, Node uses the existing runtime env: omit `--env-file=.env` and choose a snapshot path on the persistent volume. Copy the verified snapshot to storage outside the server, alongside separately protected key backups.

To restore, disable the scheduler and stop all processes using the database. Preserve the current database and any WAL/SHM files together before replacement. Restore the snapshot at `DB_FILE` with writable directory ownership and the matching `MASTER_KEY`; do not leave sidecars from a different database beside it. Start the app, pause it before restarting the scheduler, inspect settings/strategies/history, and use `npm run check` to verify the current wallet. Restoring an old snapshot can remove today's purchase lock or nonce history: reconcile actual on-chain purchases before resuming so restoration cannot cause an extra buy.

If an authenticator is lost, use `npm run totp-reset` (or `node dist/scripts/totp-reset.js` in the container), then re-enrol from the app. Existing elevation windows can remain valid for up to 15 minutes; restart the app to clear them. Existing login sessions remain until logout/revocation or expiry. Reset does not recover a lost `MASTER_KEY`.

Wallet-key replacement is refused while a purchase is PENDING or BROADCAST. Changing the key switches future execution to a different wallet; it does not transfer funds from the old wallet. Keep its independent backup and inspect any unfinished transaction before changing wallets.

## Troubleshooting

| Symptom | Check |
|---|---|
| App refuses to start | Required app env, password length, master-key format, decryption of existing secrets, and database directory permissions. |
| Login does not stick | Use HTTPS or localhost, not plain LAN HTTP; check device clock and the 30-day expiry. |
| Setup banner remains | Enrol TOTP, save settings, create an active strategy, and store a wallet key. |
| Tick produces no output | Today's run may be final or the saved run time has not arrived. Check the task's exit status and app history. |
| No purchase | Global/strategy pause, completed limits, insufficient USDT0/POL, stale oracles, validation failure, or a task that did not run. FAILED/PAUSED scheduled dates are final; use a deliberate manual buy rather than deleting daily locks. |
| BROADCAST remains unresolved | Check the transaction receipt and wallet nonce; allow recovery on the next tick. Never erase the record or blindly resend. |
| Wallet health unavailable | Full bot config and stored key must be valid; RPC may be unavailable. |
| No email | Check mode, paired Resend/recipient env, sender eligibility, task logs, and inbox. Manual buys and absent scheduler invocations do not send reports. |
| SQLite is not writable after deploy | Verify the volume mount and directory ownership, including space for WAL/SHM sidecars. |

## Development and verification

```sh
npm test
npm run build
```

These checks use synthetic data and do not prove a live purchase or inbox delivery. For a synthetic UI database, use an isolated `DB_FILE` and `npm run seed`; never seed the operational database.

The optional fork battery requires Foundry's `anvil` and `cast`, `sqlite3`, a valid API key in `.env`, and a reachable Polygon fork RPC:

```sh
npm run fork
npm run fork -- idempotency parallel
```

Each scenario creates a funded throwaway wallet on a fresh local fork. It forcibly disables fallback RPC so an anvil failure cannot route a transaction to mainnet. It still calls the real Uniswap API for quotes. Keep real wallet keys out of test inputs. Validation progression is unit/build → synthetic app → fork → independently reviewed live preview → deliberate purchase → deployed scheduler, persistence, phone, and email checks.

## Invariants

The numbering is stable for references from code and the decision log.

1. **Nothing is signed without passing through `validation.ts`.** Every assertion lives there as a pure function with a test.
2. **The scheduled run is idempotent per `(wallet, date)` UTC, and each strategy gets at most one scheduled share per UTC date.** The primary keys of `runs` and `run_shares` are taken by `claimScheduledRun` inside one `BEGIN IMMEDIATE`. This is crash safety for automatic purchases; manual purchases have separate records and can happen more than once a day.
3. **Secrets never enter the logger:** private keys from env or encrypted storage (including plaintext), `UNISWAP_API_KEY`, `MASTER_KEY`, TOTP secrets, and RPC URLs. Network errors are sanitized by content; keyed RPC URLs are credentials.
4. **Never blindly re-broadcast.** After BROADCAST, recovery compares nonce and receipt before further action.
5. **Addresses, limits, and allowlists live in code**, never as a second operational source in documentation. The example env carries configurable token values; `src/tokens.ts` and `src/validation.ts` define infrastructure constants and validation bounds.
6. **Fail toward not buying.** An unreadable database, stale oracle, or uncertain validation prevents a purchase. Pause is the safe direction. Offline/cached UI data must not look live.
7. **The app refuses to start without `APP_PASSWORD` or a valid `MASTER_KEY`**, and refuses to start if a stored secret cannot decrypt. No insecure default.
8. **TDD for pure, testable logic without network.** Test first, implementation second as one task. Applies to validation, database logic, conversions, and derivations. Real I/O paths need focused integration or manual verification instead.

## Roadmap

These numbers retain the earlier roadmap order referenced by the decision log.

1. **Several strategies on one wallet:** implemented. Multiple wallets remain deferred.
2. **Alerts when a purchase does not happen:** recorded scheduled outcomes have email reports. A watchdog for an absent scheduler invocation remains deferred.
3. **Configuration from the UI:** implemented for strategies, trading settings, encrypted wallet key, and email mode. The app fixes the scheduled time at 00:00 UTC; a configurable frequency is out of scope.
4. **Private key off the server:** deferred. The current design encrypts it at rest but keeps signing on the server. Remote signing or restricted smart-wallet contracts would require a separate design and validation.
5. **Average cost versus market chart:** deferred; numeric totals and unrealised revenue are implemented.
6. **Oracle via an independent provider:** deferred; existing oracle and transaction reads share the RPC client.
7. **POL runway and automatic backup:** POL runway is implemented; automatic recurring SQLite snapshots remain deferred.

An app button for the existing allowance CLI is also optional. Selling, trading signals, rebalancing, third-party custody, other networks, and push notifications are out of scope. [DECISIONS.md](DECISIONS.md) records the rationale and superseded designs.

## License

MIT -- see [LICENSE](LICENSE). `public/vendor/qrcode.js` is Kazuhiko Arase's qrcode-generator, also MIT, with its own notice.
