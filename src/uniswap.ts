// Thin client for the Uniswap Trading API: checkApproval, getQuote,
// buildSwap. Decides nothing -- validation.ts does that. Essentially I/O,
// so no unit TDD (README.md invariant #8); verified against the real API.
//
// x-universal-router-version pinned explicitly instead of relying on the
// API default -- which already changed from 2.1.1 to 2.1.2 without notice
// (DECISIONS.md #9, addendum). Pinning here makes that default irrelevant to us.

import { logger } from "./logger.js";

const BASE_URL = "https://trade-api.gateway.uniswap.org/v1";
const UNIVERSAL_ROUTER_VERSION = "2.1.2";
const MAX_ATTEMPTS = 3;

export class UniswapApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown
  ) {
    super(message);
    this.name = "UniswapApiError";
  }
}

interface ErrorBody {
  errorCode?: string;
  detail?: string;
  message?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Exponential backoff on 429/5xx. On 404, only retries when errorCode is
 * exactly "UpstreamTimeoutError" -- every other value is deterministic
 * (invalid address, no route, etc.) and retrying without changing the
 * request would fail the same way (see the API troubleshooting, common-errors).
 */
async function postJson<T>(path: string, apiKey: string, body: unknown): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await fetch(`${BASE_URL}${path}`, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "application/json",
          "x-universal-router-version": UNIVERSAL_ROUTER_VERSION,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      // network failure (DNS, connection timeout) -- worth retrying
      lastError = err;
      await sleep(2 ** attempt * 1000);
      continue;
    }

    if (response.ok) {
      return (await response.json()) as T;
    }

    const errorBody = (await response.json().catch(() => ({}))) as ErrorBody;

    if (response.status === 429 || response.status >= 500) {
      lastError = new UniswapApiError(`${path}: ${response.status} ${errorBody.message ?? errorBody.detail ?? ""}`, response.status, errorBody);
      await sleep(2 ** attempt * 1000);
      continue;
    }

    if (response.status === 404 && errorBody.errorCode === "UpstreamTimeoutError") {
      lastError = new UniswapApiError(`${path}: 404 UpstreamTimeoutError`, 404, errorBody);
      await sleep(2 ** attempt * 1000);
      continue;
    }

    // Every other error is deterministic -- no point retrying without changing
    // the request (400 validation, 401 auth, 404 no route, etc.)
    throw new UniswapApiError(`${path}: ${response.status} ${JSON.stringify(errorBody)}`, response.status, errorBody);
  }

  throw lastError instanceof Error ? lastError : new Error(`${path}: exhausted ${MAX_ATTEMPTS} attempts`);
}

// ============================================================
// types (only the fields this project uses -- not the whole OAS)
// ============================================================

export interface QuoteRequest {
  type: "EXACT_INPUT" | "EXACT_OUTPUT";
  amount: string;
  tokenInChainId: number;
  tokenOutChainId: number;
  tokenIn: string;
  tokenOut: string;
  swapper: string;
  slippageTolerance: number;
  routingPreference?: "BEST_PRICE" | "FASTEST";
  permitAmount?: "FULL" | "EXACT";
  recipient?: string;
  deadline?: number;
}

export interface PermitTypedData {
  domain: Record<string, unknown>;
  types: Record<string, { name: string; type: string }[]>;
  values: Record<string, unknown>;
}

export interface QuoteOutput {
  amount: string;
  token: string;
  recipient?: string;
  minimumAmount?: string;
}

export interface ClassicQuoteData {
  input: { amount: string; token: string };
  output: QuoteOutput;
  swapper: string;
  chainId: number;
  slippage: number;
  priceImpact?: number;
  txFailureReasons?: unknown[];
  routeString?: string;
  quoteId?: string;
  gasFee?: string;
}

export interface QuoteResponse {
  requestId: string;
  quote: ClassicQuoteData;
  routing: string;
  permitData: PermitTypedData | null;
}

export async function getQuote(apiKey: string, request: QuoteRequest): Promise<QuoteResponse> {
  return postJson<QuoteResponse>("/quote", apiKey, request);
}

export interface CreateSwapRequest {
  quote: ClassicQuoteData;
  signature?: string;
  permitData?: PermitTypedData;
  deadline?: number;
  safetyMode?: "SAFE";
  simulateTransaction?: boolean;
}

export interface TransactionRequestData {
  to: string;
  from: string;
  data: string;
  value: string;
  chainId: number;
  gasLimit?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  gasPrice?: string;
}

export interface CreateSwapResponse {
  requestId: string;
  swap: TransactionRequestData;
}

export async function buildSwap(apiKey: string, request: CreateSwapRequest): Promise<CreateSwapResponse> {
  return postJson<CreateSwapResponse>("/swap", apiKey, request);
}

export interface ApprovalRequest {
  walletAddress: string;
  token: string;
  amount: string;
  chainId: number;
  tokenOut?: string;
  tokenOutChainId?: number;
}

export interface ApprovalResponse {
  requestId: string;
  approval: TransactionRequestData | null;
  cancel?: TransactionRequestData;
}

export async function checkApproval(apiKey: string, request: ApprovalRequest): Promise<ApprovalResponse> {
  return postJson<ApprovalResponse>("/check_approval", apiKey, request);
}
