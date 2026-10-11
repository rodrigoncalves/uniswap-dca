// npm run check -- read-only, nothing is signed. Confirms the config matches
// on-chain reality before anything risks money.
import { loadConfig, loadMasterKey } from "./config.js";
import { PERMIT2_ADDRESS, CHAINLINK_FEEDS } from "./tokens.js";
import { MAX_ORACLE_AGE_SECONDS } from "./validation.js";
import {
  createRpcClient,
  getAccount,
  getChainId,
  getNativeBalance,
  getErc20Balance,
  getErc20Allowance,
  getTokenMeta,
  getChainlinkPrice,
  supportsSimulateV1,
} from "./wallet.js";
import { logger } from "./logger.js";
import { openDb } from "./db.js";
import { loadSettings, loadPrivateKey } from "./setup.js";

function fmtAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}min`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const masterKey = loadMasterKey();
  const db = openDb(config.dbFile);
  try {
    const client = createRpcClient(config.rpcUrl, config.rpcUrlFallback);
    const account = getAccount(loadPrivateKey(db, masterKey));

  console.log("=== chainId ===");
  const chainId = await getChainId(client);
  console.log(chainId === 137 ? `✓ ${chainId} (Polygon)` : `✗ ${chainId} -- EXPECTED 137`);

  console.log("\n=== symbols and decimals (compared against the config, DECISIONS.md #1) ===");
  const [tokenInMeta, tokenOutMeta] = await Promise.all([
    getTokenMeta(client, config.tokenIn),
    getTokenMeta(client, config.tokenOut),
  ]);
  const tokenInOk = tokenInMeta.symbol === config.tokenInSymbol;
  const tokenOutOk = tokenOutMeta.symbol === config.tokenOutSymbol;
  console.log(
    `${tokenInOk ? "✓" : "✗"} TOKEN_IN  ${config.tokenIn} symbol=${tokenInMeta.symbol} decimals=${tokenInMeta.decimals}` +
      (tokenInOk ? "" : ` -- EXPECTED symbol=${config.tokenInSymbol}`)
  );
  console.log(
    `${tokenOutOk ? "✓" : "✗"} TOKEN_OUT ${config.tokenOut} symbol=${tokenOutMeta.symbol} decimals=${tokenOutMeta.decimals}` +
      (tokenOutOk ? "" : ` -- EXPECTED symbol=${config.tokenOutSymbol}`)
  );

  console.log("\n=== DCA wallet balances ===");
  console.log(`address: ${account.address}`);
  const [polBalance, tokenInBalance, allowance] = await Promise.all([
    getNativeBalance(client, account.address),
    getErc20Balance(client, config.tokenIn, account.address),
    getErc20Allowance(client, config.tokenIn, account.address, PERMIT2_ADDRESS),
  ]);
  const polHuman = Number(polBalance) / 1e18;
  let minPol: number | null = null;
  try {
    minPol = loadSettings(db).minPolBalance;
  } catch (err) {
    console.log(`(settings not available: ${err instanceof Error ? err.message : err})`);
  }
  console.log(
    `POL: ${polHuman.toFixed(4)} ${minPol === null ? "(no threshold -- settings not configured)" : polHuman >= minPol ? "✓" : `✗ -- below min POL balance (${minPol})`}`
  );
  console.log(`${config.tokenInSymbol}: ${(Number(tokenInBalance) / 10 ** tokenInMeta.decimals).toFixed(tokenInMeta.decimals)}`);
  console.log(`Allowance -> Permit2: ${(Number(allowance) / 10 ** tokenInMeta.decimals).toFixed(tokenInMeta.decimals)}`);

  console.log("\n=== Chainlink feeds ===");
  const [btcUsd, usdtUsd, polUsd] = await Promise.all([
    getChainlinkPrice(client, CHAINLINK_FEEDS.btcUsd),
    getChainlinkPrice(client, CHAINLINK_FEEDS.usdtUsd),
    getChainlinkPrice(client, CHAINLINK_FEEDS.polUsd),
  ]);
  const now = Math.floor(Date.now() / 1000);
  for (const [label, feed] of [
    ["BTC/USD", btcUsd],
    ["USDT/USD", usdtUsd],
    ["POL/USD", polUsd],
  ] as const) {
    const age = now - feed.updatedAt;
    const fresh = age <= MAX_ORACLE_AGE_SECONDS;
    console.log(`${fresh ? "✓" : "✗ STALE"} ${label} ("${feed.description}"): $${feed.price.toFixed(6)}, age ${fmtAge(age)}`);
  }

  console.log("\n=== WBTC DESTINATION ===");
  console.log(`DCA wallet itself: ${account.address} (OUTPUT_RECIPIENT removed, DECISIONS.md #23)`);

  console.log("\n=== eth_simulateV1 support (used in the pre-broadcast simulation, D1) ===");
  const simulateSupported = await supportsSimulateV1(client);
  console.log(
    simulateSupported
      ? "✓ RPC_URL supports eth_simulateV1"
      : "✗ RPC_URL does NOT support eth_simulateV1 -- the pre-broadcast simulation will run against the fallback (see DECISIONS.md #8)"
  );
  } finally {
    db.close();
  }
}

main().catch((err) => {
  logger.error("npm run check failed", { error: err });
  process.exit(1);
});
