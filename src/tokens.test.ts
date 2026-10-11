import { test } from "node:test";
import assert from "node:assert/strict";
import { getAddress } from "viem";
import { CHAIN_ID, PERMIT2_ADDRESS, UNIVERSAL_ROUTERS, CHAINLINK_FEEDS, isAllowedRouter } from "./tokens.js";

// No network -- only pins the exact values verified in DECISIONS.md #9, so
// that a future one-character edit breaks here, not in production.

test("CHAIN_ID is Polygon", () => {
  assert.equal(CHAIN_ID, 137);
});

test("PERMIT2_ADDRESS matches the verified value", () => {
  assert.equal(PERMIT2_ADDRESS, getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3"));
});

// Checksum computed here via getAddress() from the hex verified in
// DECISIONS.md #9, not typed by hand -- the first version of this file had
// the checksum typed manually and got several characters wrong. The test
// stays independent of what tokens.ts claims, instead of just restating it.
test("UNIVERSAL_ROUTERS has exactly the three verified addresses (2.0, 2.1.1, 2.1.2)", () => {
  assert.deepEqual(UNIVERSAL_ROUTERS, [
    getAddress("0x1095692a6237d83c6a72f3f5efedb9a670c49223"),
    getAddress("0x8b844f885672f333bc0042cb669255f93a4c1e6b"),
    getAddress("0xDc264714F68d84CF29BC605589405E78bDBE7C9f"),
  ]);
});

test("CHAINLINK_FEEDS matches the verified values", () => {
  assert.equal(CHAINLINK_FEEDS.btcUsd, getAddress("0xc907E116054Ad103354f2D350FD2514433D57F6f"));
  assert.equal(CHAINLINK_FEEDS.usdtUsd, getAddress("0x0A6513e40db6EB1b165753AD52E80663aeA50545"));
  assert.equal(CHAINLINK_FEEDS.polUsd, getAddress("0xAB594600376Ec9fD91F8e885dADF0CE036862dE0"));
});

test("isAllowedRouter accepts the known routers", () => {
  assert.equal(isAllowedRouter(UNIVERSAL_ROUTERS[0]), true);
  assert.equal(isAllowedRouter(UNIVERSAL_ROUTERS[1]), true);
});

test("isAllowedRouter normalizes case -- accepts the same address in lowercase", () => {
  assert.equal(isAllowedRouter(UNIVERSAL_ROUTERS[0].toLowerCase()), true);
});

test("isAllowedRouter rejects a valid address outside the allowlist", () => {
  assert.equal(isAllowedRouter(PERMIT2_ADDRESS), false);
});

test("isAllowedRouter throws (doesn't return false) on malformed hex -- fails loud, not silent", () => {
  assert.throws(() => isAllowedRouter("0x1234"));
});
