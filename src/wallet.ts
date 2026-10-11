// On-chain I/O: viem clients, balances, allowance, Chainlink feeds, contract
// code, simulation, signing, broadcast and receipts. Thin layer -- decides
// nothing (decisions live in validation.ts). Essentially I/O, so no TDD
// here (README.md invariant #8): verified against real Polygon (check.ts, dry-run)
// and against a fork (anvil).

import {
  createPublicClient,
  http,
  fallback,
  encodeFunctionData,
  keccak256,
  TransactionReceiptNotFoundError,
  WaitForTransactionReceiptTimeoutError,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { polygon } from "viem/chains";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { chooseGasLimit } from "./validation.js";

const ERC20_ABI = [
  { type: "function", name: "balanceOf", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "allowance", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "decimals", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" },
  { type: "function", name: "symbol", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" },
  { type: "function", name: "approve", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
] as const;

const CHAINLINK_ABI = [
  { type: "function", name: "decimals", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" },
  { type: "function", name: "description", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" },
  {
    type: "function",
    name: "latestRoundData",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
    stateMutability: "view",
  },
] as const;

export function createRpcClient(rpcUrl: string, rpcUrlFallback: string | null): PublicClient {
  const transports = [http(rpcUrl)];
  if (rpcUrlFallback) transports.push(http(rpcUrlFallback));
  return createPublicClient({ chain: polygon, transport: fallback(transports) });
}

export function getAccount(privateKey: `0x${string}`): PrivateKeyAccount {
  return privateKeyToAccount(privateKey);
}

export async function getChainId(client: PublicClient): Promise<number> {
  return client.getChainId();
}

export async function getNativeBalance(client: PublicClient, address: `0x${string}`): Promise<bigint> {
  return client.getBalance({ address });
}

export async function getErc20Balance(client: PublicClient, token: `0x${string}`, owner: `0x${string}`): Promise<bigint> {
  return client.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [owner] });
}

export async function getErc20Allowance(
  client: PublicClient,
  token: `0x${string}`,
  owner: `0x${string}`,
  spender: `0x${string}`
): Promise<bigint> {
  return client.readContract({ address: token, abi: ERC20_ABI, functionName: "allowance", args: [owner, spender] });
}

export interface TokenMeta {
  symbol: string;
  decimals: number;
}

export async function getTokenMeta(client: PublicClient, token: `0x${string}`): Promise<TokenMeta> {
  const [symbol, decimals] = await Promise.all([
    client.readContract({ address: token, abi: ERC20_ABI, functionName: "symbol" }),
    client.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" }),
  ]);
  return { symbol, decimals };
}

export interface ChainlinkReading {
  description: string;
  price: number;
  decimals: number;
  updatedAt: number; // unix seconds
}

export async function getChainlinkPrice(client: PublicClient, feed: `0x${string}`): Promise<ChainlinkReading> {
  const [description, decimals, roundData] = await Promise.all([
    client.readContract({ address: feed, abi: CHAINLINK_ABI, functionName: "description" }),
    client.readContract({ address: feed, abi: CHAINLINK_ABI, functionName: "decimals" }),
    client.readContract({ address: feed, abi: CHAINLINK_ABI, functionName: "latestRoundData" }),
  ]);
  const [, answer, , updatedAt] = roundData;
  return { description, decimals, price: Number(answer) / 10 ** decimals, updatedAt: Number(updatedAt) };
}

export async function isContract(client: PublicClient, address: `0x${string}`): Promise<boolean> {
  const code = await client.getCode({ address });
  return code !== undefined && code !== "0x";
}

/**
 * Probes whether the configured RPC supports eth_simulateV1 (used in the
 * pre-broadcast simulation, D1). check.ts runs it on every call, so
 * switching RPC providers is verified automatically (DECISIONS.md #14).
 */
export async function supportsSimulateV1(client: PublicClient): Promise<boolean> {
  try {
    await client.request({
      method: "eth_simulateV1" as never,
      params: [{ blockStateCalls: [{ calls: [] }] }, "latest"] as never,
    });
    return true;
  } catch {
    return false;
  }
}

export interface CallTx {
  to: string;
  from: string;
  data: string;
  value: string;
  chainId: number;
}

/** approve(spender, amount) called ON the token. The caller validates with assertApprovalTx before signing. */
export function buildApproveTx(token: `0x${string}`, from: `0x${string}`, spender: `0x${string}`, amount: bigint): CallTx {
  return {
    to: token,
    from,
    data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [spender, amount] }),
    value: "0",
    chainId: 137,
  };
}

/**
 * Pre-broadcast simulation via eth_simulateV1: the calls in sequence, in
 * the same block (approve + swap when the allowance needs resetting).
 * Throws if any fails. Returns the last call's logs -- the caller checks
 * the output Transfer BEFORE signing.
 */
export async function simulate(client: PublicClient, from: string, calls: readonly Omit<CallTx, "from" | "chainId">[]) {
  const { results } = await client.simulateCalls({
    account: from as `0x${string}`,
    calls: calls.map((c) => ({ to: c.to as `0x${string}`, data: c.data as `0x${string}`, value: BigInt(c.value) })),
  });
  results.forEach((r, i) => {
    if (r.status !== "success") throw new Error(`simulation: call ${i} (${calls[i]!.to}) failed: ${r.error?.message ?? "revert"}`);
  });
  return results[results.length - 1]!.logs ?? [];
}

export async function getNonce(client: PublicClient, address: `0x${string}`, blockTag: "latest" | "pending"): Promise<number> {
  return client.getTransactionCount({ address, blockTag });
}

/**
 * Signs locally and returns the hash BEFORE broadcasting -- that's what lets
 * dca.ts record BROADCAST with nonce and hash before sending (README.md invariant #4).
 * Gas: max(API gasLimit, own estimate + 20%). Fees from the API when present.
 */
export async function signTx(
  client: PublicClient,
  account: PrivateKeyAccount,
  tx: CallTx & { nonce: number; gasLimit?: string; maxFeePerGas?: string; maxPriorityFeePerGas?: string }
): Promise<{ raw: `0x${string}`; hash: `0x${string}`; gas: bigint }> {
  const to = tx.to as `0x${string}`;
  const data = tx.data as `0x${string}`;
  const value = BigInt(tx.value);
  // Always estimate: the API's gasLimit can be a short fallback (chooseGasLimit).
  const estimated = await client.estimateGas({ account: account.address, to, data, value });
  const gas = chooseGasLimit(tx.gasLimit ? BigInt(tx.gasLimit) : null, estimated);
  const fees =
    tx.maxFeePerGas && tx.maxPriorityFeePerGas
      ? { maxFeePerGas: BigInt(tx.maxFeePerGas), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas) }
      : await client.estimateFeesPerGas();
  const raw = await account.signTransaction({
    type: "eip1559",
    chainId: tx.chainId,
    nonce: tx.nonce,
    to,
    data,
    value,
    gas,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  });
  return { raw, hash: keccak256(raw), gas };
}

export async function sendRaw(client: PublicClient, raw: `0x${string}`): Promise<void> {
  await client.sendRawTransaction({ serializedTransaction: raw });
}

/** null when not mined yet (or unknown to the node). */
export async function getReceipt(client: PublicClient, hash: `0x${string}`): Promise<TransactionReceipt | null> {
  try {
    return await client.getTransactionReceipt({ hash });
  } catch (err) {
    if (err instanceof TransactionReceiptNotFoundError) return null;
    throw err;
  }
}

/** null on timeout -- the caller decides what that means (decideRecovery). */
export async function waitReceipt(client: PublicClient, hash: `0x${string}`, timeoutMs: number): Promise<TransactionReceipt | null> {
  try {
    return await client.waitForTransactionReceipt({ hash, timeout: timeoutMs });
  } catch (err) {
    if (err instanceof WaitForTransactionReceiptTimeoutError) return null;
    throw err;
  }
}
