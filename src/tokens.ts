// Static data for fixed infrastructure: Permit2, the Universal Router
// allowlist, Chainlink feeds. Hardcoded, NEVER read from env -- unlike
// TOKEN_IN/TOKEN_OUT (config.ts), which are operational and configurable.
// This isn't reconfigurable because it's exactly what the security
// allowlist in validation.ts exists to protect: whoever controls a
// deploy's env vars must not be able to change where the bot can send
// approvals or calldata.
//
// No network here -- see DECISIONS.md #9 for the on-chain verification
// evidence gathered before writing these constants, and tokens.test.ts for
// the permanent assertion that they don't change by accident.
//
// getAddress() on every constant: if a character is wrong (malformed hex),
// boot breaks immediately when the module loads, instead of silently
// becoming a wrong address in a security allowlist.

import { getAddress } from "viem";

export const CHAIN_ID = 137;

export const PERMIT2_ADDRESS = getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3");

/**
 * Allowlist of permitted destinations for `to` (swap transaction) and
 * `spender` (Permit2 message). Any address outside it is grounds to
 * abort -- see validation.ts assertSwapTx/assertPermit.
 */
export const UNIVERSAL_ROUTERS = [
  getAddress("0x1095692a6237d83c6a72f3f5efedb9a670c49223"), // 2.0
  getAddress("0x8b844f885672f333bc0042cb669255f93a4c1e6b"), // 2.1.1
  getAddress("0xDc264714F68d84CF29BC605589405E78bDBE7C9f"), // 2.1.2 -- API default when x-universal-router-version isn't pinned (see DECISIONS.md #9)
] as const;

export function isAllowedRouter(address: string): boolean {
  const normalized = getAddress(address);
  return UNIVERSAL_ROUTERS.includes(normalized as (typeof UNIVERSAL_ROUTERS)[number]);
}

/**
 * Chainlink feeds on Polygon. The quote's implied price (input/output) is
 * compared against BTC/USD ÷ USDT/USD -- using the USDT feed instead of
 * assuming USDT0 = $1 absorbs a depeg without loosening the tolerance.
 *
 * Note: the POL feed still reports description()="MATIC / USD" (the
 * token's legacy name before the rebrand); the address and price are
 * correct, only the on-chain description string wasn't updated.
 */
export const CHAINLINK_FEEDS = {
  btcUsd: getAddress("0xc907E116054Ad103354f2D350FD2514433D57F6f"),
  usdtUsd: getAddress("0x0A6513e40db6EB1b165753AD52E80663aeA50545"),
  polUsd: getAddress("0xAB594600376Ec9fD91F8e885dADF0CE036862dE0"),
} as const;
