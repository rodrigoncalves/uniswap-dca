#!/usr/bin/env bash
# D2 fork battery: runs the real bot (src/dca.ts, src/revoke.ts,
# src/control.ts) against a local anvil fork of Polygon, one fresh fork per
# scenario (a reused fork diverges from mainnet's Permit2 nonce and the API
# signs permits with the mainnet one -- DECISIONS.md #13).
#
# Safety: every scenario uses a THROWAWAY key generated on the spot, never
# PRIVATE_KEY from .env. Even if a signed tx leaked to mainnet, it would come
# from an empty address and be rejected. RPC_URL_FALLBACK is forced empty so
# an anvil failure can't fall through to mainnet anyway.
#
# Needs foundry (anvil, cast), sqlite3 and a real UNISWAP_API_KEY in .env
# (the API quotes against live mainnet state).
#
# Usage: npm run fork [-- scenario ...]   (no args = all)
#        KEEP_FORK=1 leaves the last anvil running for inspection (cast run <hash>).
set -euo pipefail
cd "$(dirname "$0")/.."

FORK_URL=${FORK_URL:-https://polygon.drpc.org}
PORT=${FORK_PORT:-8545}
R=http://127.0.0.1:$PORT
USDT0=0xc2132D05D31c914a87C6611C10748AEb04B58e8F
WBTC=0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6
PERMIT2=0x000000000022D473030F116dDEE9F6B43aC78BA3
DCA_AMOUNT=10
APPROVAL_DAYS=30
CAP=$((DCA_AMOUNT * APPROVAL_DAYS * 1000000)) # USDT0 has 6 decimals
WORK=$(mktemp -d)
ANVIL_PID=""

cleanup() { [ -n "$ANVIL_PID" ] && kill "$ANVIL_PID" 2>/dev/null || true; }
trap "${KEEP_FORK:+:} cleanup" EXIT

fail() { echo "  FAIL: $*" >&2; exit 1; }
expect() { [ "$1" = "$2" ] || fail "$3: expected '$2', got '$1'"; echo "  ok: $3 = $2"; }

# Fresh fork + fresh funded throwaway wallet + fresh database.
fresh() {
  cleanup
  if cast chain-id --rpc-url "$R" >/dev/null 2>&1; then fail "something already listens on $R"; fi
  anvil --fork-url "$FORK_URL" --port "$PORT" --silent >"$WORK/anvil.log" 2>&1 &
  ANVIL_PID=$!
  for _ in $(seq 1 60); do cast chain-id --rpc-url "$R" >/dev/null 2>&1 && break; sleep 0.5; done
  [ "$(cast chain-id --rpc-url "$R")" = 137 ] || fail "fork is not chainId 137"

  local w
  w=$(cast wallet new --json | node -e 'const [w]=JSON.parse(require("fs").readFileSync(0));console.log(w.private_key,w.address)')
  KEY=${w% *}
  ADDR=${w#* }
  DB="$WORK/$1.db"
  LOG="$WORK/$1.log"

  cast rpc anvil_setBalance "$ADDR" 0x56BC75E2D63100000 --rpc-url "$R" >/dev/null # 100 POL
  # USDT0 balances live in a plain mapping at slot 0 (found by probing; the
  # balanceOf check below fails loudly if an upgrade ever moves it).
  cast rpc anvil_setStorageAt "$USDT0" "$(cast index address "$ADDR" 0)" "$(cast to-uint256 100000000)" --rpc-url "$R" >/dev/null
  [ "$(usdt0 "$ADDR")" = 100000000 ] || fail "USDT0 funding did not stick"

  BOT_ENV=(MASTER_KEY="$(openssl rand -base64 32)" PRIVATE_KEY="$KEY" RPC_URL="$R" RPC_URL_FALLBACK= DB_FILE="$DB"
    DCA_AMOUNT="$DCA_AMOUNT" APPROVAL_DAYS="${DAYS:-$APPROVAL_DAYS}"
    MAX_SLIPPAGE_PCT=0.5 MAX_PRICE_IMPACT_PCT=1.0 MAX_ORACLE_DEVIATION_PCT=2.0 MIN_POL_BALANCE=0.5
    RESEND_API_KEY="${RESEND_KEY:-}" REPORT_EMAIL_TO="${REPORT_TO:-}")
}

# Real entrypoints, one node process each (no npm/tsx wrapper, so kill -9 hits the bot itself).
run() { env "${BOT_ENV[@]}" node --import tsx --env-file=.env "src/$1.ts" "${@:2}" >>"$LOG" 2>&1; }
run_bg() { env "${BOT_ENV[@]}" node --import tsx --env-file=.env src/dca.ts "$@" >>"$LOG" 2>&1 & BOT_PID=$!; }

usdt0() { cast call "$USDT0" "balanceOf(address)(uint256)" "$1" --rpc-url "$R" | cut -d' ' -f1; }
wbtc() { cast call "$WBTC" "balanceOf(address)(uint256)" "$1" --rpc-url "$R" | cut -d' ' -f1; }
allowance() { cast call "$USDT0" "allowance(address,address)(uint256)" "$ADDR" "$PERMIT2" --rpc-url "$R" | cut -d' ' -f1; }
nonce() { cast nonce "$ADDR" --rpc-url "$R"; }
row() { sqlite3 "$DB" "SELECT $1 FROM runs WHERE wallet='$ADDR'"; }
mrows() { sqlite3 "$DB" "SELECT $1 FROM manual_runs WHERE wallet='$ADDR' ORDER BY id"; }
share() { sqlite3 "$DB" "SELECT $1 FROM run_shares WHERE strategy_id=$2"; }
strategies() {
  run control resume >/dev/null
  sqlite3 "$DB" "$1"
}
fund() {
  cast rpc anvil_setBalance "$1" 0x56BC75E2D63100000 --rpc-url "$R" >/dev/null
  cast rpc anvil_setStorageAt "$USDT0" "$(cast index address "$1" 0)" "$(cast to-uint256 100000000)" --rpc-url "$R" >/dev/null
}
set_key() { # simulate replacing the key in the app, encrypted in this scenario's DB
  env "${BOT_ENV[@]}" NEW_KEY="$1" node --import tsx --input-type=module -e '
    const { openDb } = await import("./src/db.ts");
    const { storePrivateKey } = await import("./src/setup.ts");
    const db = openDb(process.env.DB_FILE);
    try {
      storePrivateKey(db, Buffer.from(process.env.MASTER_KEY, "base64"), process.env.NEW_KEY);
    } finally {
      db.close();
    }'
}
logged() { grep -c "$1" "$LOG" || true; }

# Fork-only: the API signs permits with MAINNET's Permit2 nonce, which stays
# at 0 for a throwaway wallet, while each swap on the fork bumps the fork's
# nonce -- so a second swap in one scenario reverts (ExecutionFailed wrapping
# InvalidNonce, DECISIONS.md #13). Zero allowance[owner][USDT0][router]
# (Permit2 mapping at slot 1) before each extra swap.
ROUTER=0xDc264714F68d84CF29BC605589405E78bDBE7C9f
reset_permit2() {
  local slot
  slot=$(cast index address "$ROUTER" "$(cast index address "$USDT0" "$(cast index address "$ADDR" 1)")")
  cast rpc anvil_setStorageAt "$PERMIT2" "$slot" 0x0000000000000000000000000000000000000000000000000000000000000000 --rpc-url "$R" >/dev/null
  [ "$(cast call "$PERMIT2" "allowance(address,address,address)(uint160,uint48,uint48)" "$ADDR" "$USDT0" "$ROUTER" --rpc-url "$R" | tail -1 | cut -d' ' -f1)" = 0 ] ||
    fail "Permit2 nonce reset did not stick"
}

# Allowance already within the cap, so the day's run sends only the swap.
pre_approve() { cast send "$USDT0" "approve(address,uint256)" "$PERMIT2" "$CAP" --private-key "$KEY" --rpc-url "$R" >/dev/null; }

# Automine off, bot in background (args passed to dca.ts), wait until the
# signed swap sits in anvil's mempool. TABLE=manual_runs for a manual buy.
start_until_mempool() {
  cast rpc evm_setAutomine false --rpc-url "$R" >/dev/null
  run_bg "$@"
  local hash=""
  for _ in $(seq 1 240); do
    hash=$(sqlite3 "$DB" "SELECT tx_hash FROM ${TABLE:-runs} WHERE wallet='$ADDR' AND status='BROADCAST'" 2>/dev/null || true)
    if [ -n "$hash" ] && [ "$(cast rpc eth_getTransactionByHash "$hash" --rpc-url "$R")" != null ]; then break; fi
    kill -0 "$BOT_PID" 2>/dev/null || fail "bot exited before broadcasting (see $LOG)"
    sleep 0.5
  done
  [ -n "$hash" ] || fail "no BROADCAST row within 120s (see $LOG)"
  TX_HASH=$hash
}

# ---------------------------------------------------------------- scenarios

s_idempotency() {
  fresh idempotency
  run dca || fail "first dca failed (see $LOG)"
  expect "$(row status)" CONFIRMED "first run"
  run dca || fail "second dca failed (see $LOG)"
  expect "$(logged 'day already processed')" 0 "second tick exits silently (today's run is final, F1c)"
  expect "$(nonce)" 2 "nonce (nothing new sent)"
}

s_parallel() {
  fresh parallel
  run dca & local a=$!
  run dca & local b=$!
  wait $a || true
  wait $b || true
  expect "$(row status)" CONFIRMED "status"
  expect "$(logged 'day already processed')" 1 "exactly one loser"
  expect "$(logged 'swap broadcast')" 1 "exactly one swap"
  expect "$(nonce)" 2 "nonce (one approve + one swap)"
}

s_kill9() {
  fresh kill9
  pre_approve
  start_until_mempool
  kill -9 "$BOT_PID"
  wait "$BOT_PID" 2>/dev/null || true
  expect "$(row status)" BROADCAST "status after kill -9"
  cast rpc evm_mine --rpc-url "$R" >/dev/null
  cast rpc evm_setAutomine true --rpc-url "$R" >/dev/null
  run dca || fail "recovery run failed (see $LOG)"
  expect "$(logged 'recovering pending BROADCAST')" 1 "recovery ran"
  expect "$(row status)" CONFIRMED "status after recovery"
  expect "$(row tx_hash)" "$TX_HASH" "same tx, not a new one"
  expect "$(wbtc "$ADDR")" "$(row amount_out)" "wallet WBTC = amount_out"
  expect "$(nonce)" 2 "nonce (approve + one swap, no re-broadcast)"
}

s_dropped() {
  fresh dropped
  pre_approve
  start_until_mempool
  cast rpc anvil_dropTransaction "$TX_HASH" --rpc-url "$R" >/dev/null
  kill -9 "$BOT_PID" # would otherwise wait out the ~30 min deadline
  wait "$BOT_PID" 2>/dev/null || true
  cast rpc evm_setAutomine true --rpc-url "$R" >/dev/null
  # ponytail: wall clock can't be fast-forwarded (recovery uses Date.now), so
  # the deadline is moved into the past instead -- same branch of decideRecovery.
  sqlite3 "$DB" "UPDATE runs SET deadline = strftime('%s','now') - 300 WHERE wallet='$ADDR'"
  run dca && fail "recovery of a dropped tx should exit non-zero"
  expect "$(row status)" FAILED "status"
  expect "$(row "error LIKE '%not mined by the deadline%'")" 1 "error names the deadline"
  cast rpc evm_mine --rpc-url "$R" >/dev/null
  expect "$(nonce)" 1 "nonce (only the approve, no re-broadcast)"
  expect "$(usdt0 "$ADDR")" 100000000 "USDT0 untouched"
}

s_pause() {
  fresh pause
  run control pause "fork battery"
  run dca || fail "dca failed (see $LOG)"
  expect "$(row status)" PAUSED "status"
  expect "$(nonce)" 0 "nonce (nothing sent)"
  expect "$(usdt0 "$ADDR")" 100000000 "USDT0 untouched"
}

s_revoke() {
  fresh revoke
  pre_approve
  set_key "$KEY"
  run revoke || fail "revoke failed (see $LOG)"
  expect "$(allowance)" 0 "allowance after revoke"
  expect "$(sqlite3 "$DB" "SELECT paused FROM control WHERE wallet='*'")" 1 "revoke paused the DCA"
  run dca || fail "dca failed (see $LOG)"
  expect "$(row status)" PAUSED "status"
  expect "$(allowance)" 0 "allowance still 0 (no re-approve)"
  expect "$(nonce)" 2 "nonce (approve + revoke only)"
}

s_approve() {
  fresh approve
  set_key "$KEY"
  run approve 500 || fail "approve failed (see $LOG)"
  expect "$(allowance)" 500000000 "allowance after approve 500"
  run approve 100001 && fail "above-ceiling approve should exit non-zero"
  expect "$(allowance)" 500000000 "allowance unchanged by refused approve"
  expect "$(nonce)" 1 "nonce (one approve only)"
}

s_manual() {
  fresh manual
  run dca || fail "daily dca failed (see $LOG)"
  reset_permit2
  run dca --manual --strategy 1 || fail "first manual buy failed (see $LOG)"
  reset_permit2
  run dca --manual --strategy 1 || fail "second manual buy failed (see $LOG)"
  expect "$(row status)" CONFIRMED "daily run"
  expect "$(mrows status | tr '\n' ' ')" "CONFIRMED CONFIRMED " "two manual buys, same day"
  expect "$(mrows amount_in | tr '\n' ' ')" "10000000 10000000 " "manual amounts = the strategy's own (F8)"
  expect "$(wbtc "$ADDR")" "$(sqlite3 "$DB" "SELECT (SELECT amount_out FROM runs) + (SELECT SUM(amount_out) FROM manual_runs)")" "wallet WBTC = sum of all amount_out"
  expect "$(nonce)" 4 "nonce (approve + three swaps)"
}

s_manual_cap() {
  DAYS=2 fresh manual_cap # daily cap 10 x 2 = 20 USDT0; a PAUSED strategy's 50 isn't in the daily total
  strategies "INSERT INTO strategies (id,label,amount,status,created_at) VALUES (1,NULL,'10','active','2026-01-01T00:00:00Z'),(2,'big','50','paused','2026-01-01T00:00:00Z')"
  run dca --manual --strategy 2 || fail "manual buy above the cap failed (see $LOG)"
  expect "$(mrows status)" CONFIRMED "manual buy above the daily cap"
  expect "$(allowance)" 0 "approve raised to exactly the amount, fully spent"
}

s_manual_kill9() {
  fresh manual_kill9
  pre_approve
  TABLE=manual_runs start_until_mempool --manual --strategy 1
  kill -9 "$BOT_PID"
  wait "$BOT_PID" 2>/dev/null || true
  expect "$(mrows status)" BROADCAST "manual status after kill -9"
  cast rpc evm_mine --rpc-url "$R" >/dev/null
  cast rpc evm_setAutomine true --rpc-url "$R" >/dev/null
  reset_permit2
  run dca || fail "daily run failed (see $LOG)"
  expect "$(logged 'recovering pending manual BROADCAST')" 1 "daily run recovered the manual buy"
  expect "$(mrows status)" CONFIRMED "manual status after recovery"
  expect "$(mrows tx_hash)" "$TX_HASH" "same manual tx, not a new one"
  expect "$(row status)" CONFIRMED "daily run still bought"
  expect "$(nonce)" 3 "nonce (approve + manual swap + daily swap, no re-broadcast)"
}

s_manual_paused() {
  fresh manual_paused
  run control pause "fork battery"
  run dca --manual --strategy 1 && fail "manual buy while paused should exit non-zero"
  expect "$(mrows 'COUNT(*)')" 0 "no manual row recorded"
  expect "$(nonce)" 0 "nonce (nothing sent)"
}

s_report_failure() {
  RESEND_KEY=re_bogus_fork_battery_key REPORT_TO=nobody@example.com fresh report_failure
  run dca || fail "dca exited non-zero because of the email (see $LOG)"
  expect "$(row status)" CONFIRMED "purchase unaffected"
  expect "$(logged 'email report failed')" 1 "email failure logged"
  expect "$(logged 're_bogus_fork_battery_key')" 0 "API key never in the log"
}

s_report_errors_only() {
  RESEND_KEY=re_bogus_fork_battery_key REPORT_TO=nobody@example.com fresh report_errors_only
  strategies "INSERT INTO report_pref (id, mode) VALUES (1, 'errors')" # F9: errors only -- a CONFIRMED run sends nothing
  run dca || fail "dca failed (see $LOG)"
  expect "$(row status)" CONFIRMED "purchase unaffected"
  expect "$(logged 'email report skipped')" 1 "skip logged"
  expect "$(logged 'email report failed')" 0 "no send attempted"
}

s_report_off() {
  RESEND_KEY=re_bogus_fork_battery_key REPORT_TO=nobody@example.com fresh report_off
  strategies "INSERT INTO report_pref (id, mode) VALUES (1, 'off')" # F9: switched off in the app
  run dca || fail "dca failed (see $LOG)"
  expect "$(row status)" CONFIRMED "purchase unaffected"
  expect "$(logged 'email report skipped')" 1 "skip logged"
  expect "$(logged 'email report failed')" 0 "no send attempted"
}

set_usdt0() { cast rpc anvil_setStorageAt "$USDT0" "$(cast index address "$ADDR" 0)" "$(cast to-uint256 "$1")" --rpc-url "$R" >/dev/null; }

s_funds_low() {
  RESEND_KEY=re_bogus_fork_battery_key REPORT_TO=nobody@example.com fresh funds_low
  set_usdt0 30000000 # 30 USDT0: 2 runs left after today's 10 -- alert days default 2
  run dca || fail "dca failed (see $LOG)"
  expect "$(row status)" CONFIRMED "purchase unaffected"
  expect "$(logged 'low-funds alert failed')" 1 "alert attempted (bogus key)"
  expect "$(logged 're_bogus_fork_battery_key')" 0 "API key never in the log"
}

s_funds_empty() {
  RESEND_KEY=re_bogus_fork_battery_key REPORT_TO=nobody@example.com fresh funds_empty
  strategies "INSERT INTO report_pref (id, mode, alert_days) VALUES (1, 'off', 0)" # reports off, alert only when empty
  set_usdt0 10000000 # exactly today's amount: 0 runs left afterwards
  run dca || fail "dca failed (see $LOG)"
  expect "$(row status)" CONFIRMED "purchase unaffected"
  expect "$(logged 'email report skipped')" 1 "run report off"
  expect "$(logged 'low-funds alert failed')" 1 "running out always alerts"
}

s_funds_ok() {
  RESEND_KEY=re_bogus_fork_battery_key REPORT_TO=nobody@example.com fresh funds_ok
  strategies "INSERT INTO report_pref (id, mode) VALUES (1, 'off')"
  run dca || fail "dca failed (see $LOG)" # 100 USDT0: 9 runs left, quiet
  expect "$(logged 'low-funds alert')" 0 "no alert with enough funds"
}

s_app_buy() {
  fresh app_buy
  local port=18799 pw=fork-battery-app-password auth secret code
  env "${BOT_ENV[@]}" APP_PASSWORD="$pw" APP_PORT="$port" node --import tsx --env-file=.env src/server.ts >>"$LOG" 2>&1 &
  local app=$!
  for _ in $(seq 1 40); do curl -s "http://127.0.0.1:$port/health" >/dev/null && break; sleep 0.5; done
  # F6: session cookie from /api/login, then enrol TOTP -- confirming opens the elevation window the buy needs
  auth=(-b "$WORK/app_buy.cookies" -c "$WORK/app_buy.cookies" -H "Content-Type: application/json")
  expect "$(curl -s -o /dev/null -w '%{http_code}' "${auth[@]}" "http://127.0.0.1:$port/api/buy")" 401 "no session refused"
  expect "$(curl -s -o /dev/null -w '%{http_code}' "${auth[@]}" -H 'X-Dca-App: 1' -X POST -d "{\"password\":\"$pw\"}" "http://127.0.0.1:$port/api/login")" 200 "login"
  secret=$(curl -s "${auth[@]}" -H 'X-Dca-App: 1' -X POST -d '{}' "http://127.0.0.1:$port/api/totp/setup" | sed -E 's/.*"secret":"([A-Z2-7]+)".*/\1/')
  code=$(node --import tsx -e 'const t = await import("./src/totp.ts"); console.log(t.totpAt(t.base32Decode(process.argv[1]), t.stepAt(Date.now())))' "$secret")
  expect "$(curl -s -o /dev/null -w '%{http_code}' "${auth[@]}" -H 'X-Dca-App: 1' -X POST -d "{\"totp\":\"$code\"}" "http://127.0.0.1:$port/api/totp/confirm")" 200 "authenticator enrolled"
  expect "$(curl -s -o /dev/null -w '%{http_code}' "${auth[@]}" -X POST -d '{"strategyId":1}' "http://127.0.0.1:$port/api/buy")" 400 "POST without X-Dca-App refused (CSRF guard)"
  expect "$(curl -s -o /dev/null -w '%{http_code}' "${auth[@]}" -H 'X-Dca-App: 1' -X POST -d '{"amount":"5","strategyId":1}' "http://127.0.0.1:$port/api/buy")" 400 "client-chosen amount refused (F8)"
  expect "$(curl -s -o /dev/null -w '%{http_code}' "${auth[@]}" -H 'X-Dca-App: 1' -X POST -d '{"strategyId":1}' "http://127.0.0.1:$port/api/buy")" 202 "buy started"
  expect "$(curl -s -o /dev/null -w '%{http_code}' "${auth[@]}" -H 'X-Dca-App: 1' -X POST -d '{"strategyId":1}' "http://127.0.0.1:$port/api/buy")" 409 "second buy while running refused"
  local state=""
  for _ in $(seq 1 120); do state=$(curl -s "${auth[@]}" "http://127.0.0.1:$port/api/buy"); [[ $state == *'"running":false'* ]] && break; sleep 1; done
  kill "$app" 2>/dev/null || true
  wait "$app" 2>/dev/null || true
  [[ $state == *'"exitCode":0'* ]] || fail "buy from the app did not exit 0: $state (see $LOG)"
  expect "$(mrows status)" CONFIRMED "manual row from the app"
  expect "$(mrows amount_in)" 10000000 "amount = strategy #1's own (DCA_AMOUNT)"
  expect "$(wbtc "$ADDR")" "$(mrows amount_out)" "wallet WBTC = amount_out"
}

s_strategies() {
  fresh strategies
  strategies "INSERT INTO strategies (id,label,amount,status,created_at) VALUES (1,NULL,'10','active','2026-01-01T00:00:00Z'),(2,'B','20','active','2026-01-01T00:00:00Z')"
  run dca || fail "dca failed (see $LOG)"
  expect "$(row status)" CONFIRMED "one swap"
  expect "$(row amount_in)" 30000000 "swap amount = 10 + 20"
  expect "$(share amount_in 1)" 10000000 "share 1 in"
  expect "$(share amount_in 2)" 20000000 "share 2 in"
  expect "$(sqlite3 "$DB" 'SELECT SUM(amount_out) FROM run_shares')" "$(row amount_out)" "shares sum to amount_out"
  local out; out=$(row amount_out)
  expect "$(share amount_out 1)" $((out * 10 / 30)) "share 1 = floor(out/3)"
  expect "$(wbtc "$ADDR")" "$out" "wallet WBTC = amount_out"
  expect "$(nonce)" 2 "nonce (approve + one swap)"
}

s_late_strategy() {
  fresh late_strategy
  run dca || fail "dca failed (see $LOG)"
  sqlite3 "$DB" "INSERT INTO strategies (label,amount,status,created_at) VALUES ('late','20','active','2026-01-01T00:00:00Z')"
  run dca || fail "second dca failed (see $LOG)"
  expect "$(logged 'day already processed')" 0 "same day not reopened (silent: today's run is final)"
  expect "$(sqlite3 "$DB" 'SELECT COUNT(*) FROM run_shares WHERE strategy_id=2')" 0 "late strategy has no share today"
  expect "$(nonce)" 2 "nonce (nothing new)"
}

s_strategy_paused() {
  fresh strategy_paused
  strategies "INSERT INTO strategies (id,label,amount,status,created_at) VALUES (1,NULL,'10','active','2026-01-01T00:00:00Z'),(2,'P','20','paused','2026-01-01T00:00:00Z')"
  run dca || fail "dca failed (see $LOG)"
  expect "$(row amount_in)" 10000000 "paused strategy left out"
  expect "$(sqlite3 "$DB" 'SELECT COUNT(*) FROM run_shares WHERE strategy_id=2')" 0 "no share for the paused one"
}

s_end_date() {
  fresh end_date
  strategies "INSERT INTO strategies (id,label,amount,status,end_date,created_at) VALUES (1,NULL,'10','active','2020-01-01','2019-01-01T00:00:00Z'),(2,'B','5','active',NULL,'2026-01-01T00:00:00Z')"
  run dca || fail "dca failed (see $LOG)"
  expect "$(row amount_in)" 5000000 "ended strategy left out"
  expect "$(sqlite3 "$DB" 'SELECT status FROM strategies WHERE id=1')" completed "ended strategy completed"
  run dca --manual --strategy 1 && fail "manual buy into an ended strategy should exit non-zero"
  expect "$(mrows 'COUNT(*)')" 0 "no manual row"
}

s_max_total() {
  fresh max_total
  strategies "INSERT INTO strategies (id,label,amount,status,max_total,created_at) VALUES (1,NULL,'10','active','15','2026-01-01T00:00:00Z');
    INSERT INTO manual_runs (created_at,wallet,date,status,amount_in,strategy_id) VALUES ('2026-01-02T00:00:00Z','$ADDR','2026-01-02','CONFIRMED','8000000',1)"
  run dca || fail "dca failed (see $LOG)"
  expect "$(row amount_in)" 7000000 "last buy = what's left of the budget"
  expect "$(sqlite3 "$DB" 'SELECT status FROM strategies WHERE id=1')" completed "budget spent -> completed"
  run dca --manual --strategy 1 && fail "manual buy into a completed strategy should exit non-zero"
  expect "$(mrows 'COUNT(*)')" 1 "no new manual row"
}

s_key_change() {
  fresh key_change
  run dca || fail "first wallet's run failed (see $LOG)"
  local w2 key2 addr2
  w2=$(cast wallet new --json | node -e 'const [w]=JSON.parse(require("fs").readFileSync(0));console.log(w.private_key,w.address)')
  key2=${w2% *}; addr2=${w2#* }
  fund "$addr2"
  set_key "$key2"
  run dca || fail "second wallet's run failed (see $LOG)"
  expect "$(logged 'no strategy to buy today')" 1 "second wallet found nothing to buy"
  expect "$(cast nonce "$addr2" --rpc-url "$R")" 0 "second wallet sent nothing"
}

s_wrong_master_key() {
  fresh wrong_master_key
  run dca || fail "first run failed (see $LOG)"
  reset_permit2
  env "${BOT_ENV[@]}" MASTER_KEY="$(openssl rand -base64 32)" node --import tsx --env-file=.env src/dca.ts --manual --strategy 1 >>"$LOG" 2>&1 \
    && fail "wrong MASTER_KEY should exit non-zero"
  expect "$(logged 'cannot decrypt secret')" 1 "names the problem"
  expect "$(nonce)" 2 "nothing new sent"
  expect "$(strings "$DB" | grep -c "${KEY:2:40}" || true)" 0 "key not in the database in clear"
  expect "$(logged "${KEY:2:40}")" 0 "key not in the log"
}

# F1c: settings in the database, 15-min cron gate.
s_not_due() {
  local later
  later=$(node -e 'const d=new Date(Date.now()+30*60e3);const m=Math.ceil(d.getUTCMinutes()/15)*15;d.setUTCMinutes(m,0,0);console.log(d.toISOString().slice(11,16))')
  [[ "$later" > "$(date -u +%H:%M)" ]] || { echo "  skip: too close to UTC midnight"; return; }
  fresh not_due
  run control resume >/dev/null # creates and migrates the database
  sqlite3 "$DB" "INSERT INTO settings (id,run_time,max_slippage_pct,max_price_impact_pct,max_oracle_deviation_pct,approval_days,min_pol_balance,updated_at) VALUES (1,'$later',0.5,1,2,30,0.5,'x')"
  run dca || fail "not-due tick should exit 0 (see $LOG)"
  expect "$(sqlite3 "$DB" 'SELECT COUNT(*) FROM runs')" 0 "no run before the run time"
  expect "$(nonce)" 0 "nothing sent"
}

s_not_configured() {
  fresh not_configured
  # no legacy settings vars at all: an explicitly empty var wins over .env
  env "${BOT_ENV[@]}" MAX_SLIPPAGE_PCT= MAX_PRICE_IMPACT_PCT= MAX_ORACLE_DEVIATION_PCT= APPROVAL_DAYS= MIN_POL_BALANCE= \
    node --import tsx --env-file=.env src/dca.ts >>"$LOG" 2>&1 && fail "unconfigured run should exit non-zero"
  expect "$(logged 'finish setup in the app')" 1 "names the fix"
  expect "$(nonce)" 0 "nothing sent"
}

s_bad_env() {
  fresh bad_env
  env "${BOT_ENV[@]}" MAX_SLIPPAGE_PCT=10 node --import tsx --env-file=.env src/dca.ts >>"$LOG" 2>&1 && fail "out-of-cap env should exit non-zero"
  expect "$(logged 'maxSlippagePct')" 1 "names the value"
  expect "$(nonce)" 0 "nothing sent"
}

ALL=(idempotency parallel kill9 dropped pause revoke approve manual manual_cap manual_kill9 manual_paused report_failure report_off report_errors_only funds_low funds_empty funds_ok app_buy strategies late_strategy strategy_paused end_date max_total key_change wrong_master_key not_due not_configured bad_env)
for s in "${@:-${ALL[@]}}"; do
  echo "== $s"
  "s_$s"
done
echo "all passed (logs in $WORK)"
