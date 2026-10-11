// npm run revoke -- approve(PERMIT2, 0) on the input token. Emergency exit:
// with no allowance, Permit2 can't pull any USDT0, regardless of permits
// already signed.
//
// Also PAUSES the DCA: without that, the next run would see allowance 0 <
// DCA_AMOUNT and approve again (needsApproval), undoing the revoke.
// To come back: npm run resume -- the next DCA redoes the capped approve.

import { loadConfig, loadMasterKey } from "./config.js";
import { openDb, setPaused } from "./db.js";
import { loadPrivateKey } from "./setup.js";
import {
  createRpcClient,
  getAccount,
  getChainId,
  getErc20Allowance,
  buildApproveTx,
  simulate,
  getNonce,
  signTx,
  sendRaw,
  waitReceipt,
} from "./wallet.js";
import { assertApprovalTx } from "./validation.js";
import { PERMIT2_ADDRESS } from "./tokens.js";
import { logger } from "./logger.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const masterKey = loadMasterKey();

  // Pause first: even if the revoke fails, the bot stops buying.
  const db = openDb(config.dbFile);
  try {
    setPaused(db, { paused: true, reason: "npm run revoke" });
    const account = getAccount(loadPrivateKey(db, masterKey));
    const client = createRpcClient(config.rpcUrl, config.rpcUrlFallback);
    console.log("DCA paused.");

  const chainId = await getChainId(client);
  if (chainId !== 137) throw new Error(`unexpected chainId: ${chainId}`);

  const before = await getErc20Allowance(client, config.tokenIn, account.address, PERMIT2_ADDRESS);
  console.log(`allowance ${config.tokenInSymbol} -> Permit2 before: ${before}`);
  if (before === 0n) {
    console.log("already zero, nothing to broadcast.");
    return;
  }

  const tx = buildApproveTx(config.tokenIn, account.address, PERMIT2_ADDRESS, 0n);
  assertApprovalTx(tx, {
    chainId: 137,
    fromAddress: account.address,
    tokenAddress: config.tokenIn,
    expectedSpender: PERMIT2_ADDRESS,
    maxAmount: 0n,
  });
  await simulate(client, account.address, [tx]);

  const nonce = await getNonce(client, account.address, "pending");
  const signed = await signTx(client, account, { ...tx, nonce });
  await sendRaw(client, signed.raw);
  console.log(`revoke broadcast: ${signed.hash}`);

  const receipt = await waitReceipt(client, signed.hash, 3 * 60 * 1000);
  if (!receipt || receipt.status !== "success") {
    throw new Error(`revoke ${signed.hash} ${receipt ? "reverted" : "no receipt within 3 min -- check on Polygonscan"}`);
  }
  const after = await getErc20Allowance(client, config.tokenIn, account.address, PERMIT2_ADDRESS);
  console.log(`allowance after: ${after}`);
  if (after !== 0n) throw new Error(`allowance did not reach zero: ${after}`);
  } finally {
    db.close();
  }
}

main().catch((err) => {
  logger.error("revoke failed", { error: err });
  process.exitCode = 1;
});
