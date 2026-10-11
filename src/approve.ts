// npm run approve -- <amount> -- approve(PERMIT2, amount) on the input token.
// One-shot top-up: the next scheduled run shrinks it back to the cap
// (day total x approval_days) when it's above (needsApproval, DECISIONS.md #28).
// To keep a larger allowance, raise approval_days in the app instead.

import { loadConfig, loadMasterKey } from "./config.js";
import { openDb } from "./db.js";
import { loadPrivateKey } from "./setup.js";
import {
  createRpcClient,
  getAccount,
  getChainId,
  getTokenMeta,
  getErc20Allowance,
  buildApproveTx,
  simulate,
  getNonce,
  signTx,
  sendRaw,
  waitReceipt,
} from "./wallet.js";
import { assertApprovalTx, parseApproveAmount, toBaseUnits } from "./validation.js";
import { PERMIT2_ADDRESS } from "./tokens.js";
import { logger } from "./logger.js";

async function main(): Promise<void> {
  const amount = parseApproveAmount(process.argv[2]);
  const config = loadConfig();
  const masterKey = loadMasterKey();

  const db = openDb(config.dbFile);
  try {
    const account = getAccount(loadPrivateKey(db, masterKey));
    const client = createRpcClient(config.rpcUrl, config.rpcUrlFallback);

    const chainId = await getChainId(client);
    if (chainId !== 137) throw new Error(`unexpected chainId: ${chainId}`);

    const meta = await getTokenMeta(client, config.tokenIn);
    if (meta.symbol !== config.tokenInSymbol) throw new Error(`TOKEN_IN symbol mismatch: expected ${config.tokenInSymbol}, got ${meta.symbol}`);
    const target = toBaseUnits(amount, meta.decimals);
    const before = await getErc20Allowance(client, config.tokenIn, account.address, PERMIT2_ADDRESS);
    console.log(`allowance ${config.tokenInSymbol} -> Permit2 before: ${before}, requested: ${target}`);

    const tx = buildApproveTx(config.tokenIn, account.address, PERMIT2_ADDRESS, target);
    assertApprovalTx(tx, {
      chainId: 137,
      fromAddress: account.address,
      tokenAddress: config.tokenIn,
      expectedSpender: PERMIT2_ADDRESS,
      maxAmount: target,
    });
    await simulate(client, account.address, [tx]);

    const nonce = await getNonce(client, account.address, "pending");
    const signed = await signTx(client, account, { ...tx, nonce });
    await sendRaw(client, signed.raw);
    console.log(`approve broadcast: ${signed.hash}`);

    const receipt = await waitReceipt(client, signed.hash, 3 * 60 * 1000);
    if (!receipt || receipt.status !== "success") {
      throw new Error(`approve ${signed.hash} ${receipt ? "reverted" : "no receipt within 3 min -- check on Polygonscan"}`);
    }
    const after = await getErc20Allowance(client, config.tokenIn, account.address, PERMIT2_ADDRESS);
    console.log(`allowance after: ${after}`);
    if (after !== target) throw new Error(`allowance is ${after}, expected ${target}`);
  } finally {
    db.close();
  }
}

main().catch((err) => {
  logger.error("approve failed", { error: err });
  process.exitCode = 1;
});
