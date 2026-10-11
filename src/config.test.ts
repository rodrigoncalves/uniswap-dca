import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, loadAppConfig, loadMasterKey, ConfigError } from "./config.js";
import { logger } from "./logger.js";

const WBTC = "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6";
const USDT0 = "0xc2132D05D31c914a87C6611C10748AEb04B58e8F";

const GOOD_ENV: Record<string, string> = {
  UNISWAP_API_KEY: "abc123",
  RPC_URL: "https://polygon-mainnet.infura.io/v3/deadbeef",
  RPC_URL_FALLBACK: "https://polygon.drpc.org",
  APP_PASSWORD: "long-enough-password-123",
  TOKEN_IN: USDT0,
  TOKEN_IN_SYMBOL: "USDT0",
  TOKEN_OUT: WBTC,
  TOKEN_OUT_SYMBOL: "WBTC",
  DB_FILE: "./data/dca.db",
  APP_PORT: "8787",
};

function withEnv(overrides: Record<string, string | undefined>): Record<string, string | undefined> {
  return { ...GOOD_ENV, ...overrides };
}

function rejectedWith(fn: () => unknown, substring: string): void {
  assert.throws(
    fn,
    (err: unknown) => err instanceof ConfigError && err.message.includes(substring),
    `expected ConfigError containing "${substring}"`
  );
}

test("empty env: lists every missing required field, all at once", () => {
  try {
    loadConfig({});
    assert.fail("should have thrown ConfigError");
  } catch (err) {
    assert.ok(err instanceof ConfigError);
    assert.match(err.message, /APP_PORT/);
    assert.equal((err.message.match(/\n {2}- /g) ?? []).length, 9);
  }
});

test("valid config: loads and fields match", () => {
  const c = loadConfig(GOOD_ENV);
  assert.equal(c.tokenIn, USDT0);
  assert.equal(c.tokenOut, WBTC);
});

test("secrets don't show up in console.log (non-enumerable)", () => {
  const c = loadConfig(GOOD_ENV);
  assert.deepEqual(Object.keys(c), Object.keys(c).filter((k) => !["uniswapApiKey", "rpcUrl", "rpcUrlFallback", "appPassword"].includes(k)));
});

test("secrets don't show up in JSON.stringify (explicit toJSON)", () => {
  const c = loadConfig(GOOD_ENV);
  const json = JSON.stringify(c);
  assert.doesNotMatch(json, /uniswapApiKey|rpcUrl|appPassword/i);
});

test("empty APP_PASSWORD is rejected", () => {
  rejectedWith(() => loadConfig(withEnv({ APP_PASSWORD: "" })), "APP_PASSWORD");
});

test("short APP_PASSWORD is rejected (app is exposed via Coolify)", () => {
  rejectedWith(() => loadConfig(withEnv({ APP_PASSWORD: "123" })), "at least 12 characters");
});

// --- TOKEN_IN / TOKEN_OUT: no extra mixed-case requirement, because the
// real protection is symbol()/decimals() checked on-chain at boot (B2).

test("all-lowercase TOKEN_IN is accepted", () => {
  const c = loadConfig(withEnv({ TOKEN_IN: USDT0.toLowerCase() }));
  assert.equal(c.tokenIn, USDT0);
});

test("TOKEN_IN with wrong checksum (mixed case) is rejected", () => {
  const wrongChecksum = "0xC2132d05D31c914a87C6611C10748AEb04B58e8F";
  rejectedWith(() => loadConfig(withEnv({ TOKEN_IN: wrongChecksum })), "invalid EIP-55 checksum");
});

test("TOKEN_IN equal to TOKEN_OUT is rejected", () => {
  rejectedWith(() => loadConfig(withEnv({ TOKEN_OUT: USDT0 })), "cannot be the same address");
});

// --- numbers ---

test("DCA_AMOUNT is no longer read by loadConfig (strategies live in the database)", () => {
  assert.doesNotThrow(() => loadConfig(withEnv({ DCA_AMOUNT: undefined })));
});

test("loadConfig: DCA parameters and OUTPUT_RECIPIENT are no longer read (settings live in the database)", () => {
  const c = loadConfig(withEnv({ MAX_SLIPPAGE_PCT: "999", OUTPUT_RECIPIENT: "junk" }));
  assert.equal("maxSlippagePct" in c, false);
  assert.equal("outputRecipient" in c, false);
});

test("config no longer reads PRIVATE_KEY (it lives encrypted in the database)", () => {
  const c = loadConfig(withEnv({ PRIVATE_KEY: undefined }));
  assert.equal("privateKey" in c, false);
  assert.equal("walletAddress" in loadAppConfig(withEnv({ PRIVATE_KEY: undefined })), false);
});

test("RPC_URL without https is rejected", () => {
  rejectedWith(() => loadConfig(withEnv({ RPC_URL: "http://foo.com" })), "https://");
});

test("RPC_URL http only on loopback (local anvil fork)", () => {
  assert.equal(loadConfig(withEnv({ RPC_URL: "http://127.0.0.1:8545" })).rpcUrl, "http://127.0.0.1:8545");
  assert.equal(loadConfig(withEnv({ RPC_URL: "http://localhost:8545" })).rpcUrl, "http://localhost:8545");
  rejectedWith(() => loadConfig(withEnv({ RPC_URL: "http://127.0.0.1.evil.com" })), "https://");
  rejectedWith(() => loadConfig(withEnv({ RPC_URL: "http://localhost.evil.com:8545" })), "https://");
});

test("empty RPC_URL_FALLBACK is accepted, becomes null", () => {
  const c = loadConfig(withEnv({ RPC_URL_FALLBACK: "" }));
  assert.equal(c.rpcUrlFallback, null);
});

// --- logger: content-based redaction ---

test("logger redacts registered secrets in any field, including inside an Error", () => {
  const c = loadConfig(withEnv({}));
  const originalLog = console.error;
  let captured = "";
  console.error = (line: string) => {
    captured = line;
  };
  try {
    const err = new Error(`fetch failed: url=${c.rpcUrl}`);
    logger.error("RPC call failed", { error: err, key: c.uniswapApiKey });
  } finally {
    console.error = originalLog;
  }
  assert.doesNotMatch(captured, new RegExp(GOOD_ENV.RPC_URL!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(captured, new RegExp(GOOD_ENV.UNISWAP_API_KEY!));
  assert.match(captured, /<redacted>/);
});

// ============================================================
// loadAppConfig -- subset for server.ts/export.ts/seed-history.ts, which
// don't need PRIVATE_KEY/UNISWAP_API_KEY/RPC_URL to exist. Without it,
// "npm run app" would be blocked until the whole bot's credentials were
// configured -- contradicting Phase 0.5 (app with synthetic data, no
// credentials at all).
// ============================================================

const GOOD_APP_ENV: Record<string, string> = {
  APP_PASSWORD: "long-enough-password-123",
  APP_PORT: "8787",
  DB_FILE: "./data/dca.db",
};

test("loadAppConfig: loads with only the app fields, without requiring UNISWAP_API_KEY/RPC_URL/etc", () => {
  const c = loadAppConfig(GOOD_APP_ENV);
  assert.equal(c.appPort, 8787);
  assert.equal(c.dbFile, "./data/dca.db");
});

test("loadAppConfig: refuses empty or short APP_PASSWORD, same rule as the bot", () => {
  assert.throws(() => loadAppConfig({ ...GOOD_APP_ENV, APP_PASSWORD: "" }), ConfigError);
  assert.throws(() => loadAppConfig({ ...GOOD_APP_ENV, APP_PASSWORD: "123" }), ConfigError);
});

test("loadAppConfig: appPassword does not show up in console.log or JSON.stringify", () => {
  const c = loadAppConfig(GOOD_APP_ENV);
  assert.equal(Object.keys(c).includes("appPassword"), false);
  assert.doesNotMatch(JSON.stringify(c), /long-enough-password/);
});

// ============================================================
// email report (F3) -- optional, and a half-configured report must never
// stop the bot from buying: it turns reporting off instead of throwing.
// ============================================================

test("report: neither RESEND_API_KEY nor REPORT_EMAIL_TO -- reporting off, no error", () => {
  const c = loadConfig(GOOD_ENV);
  assert.equal(c.report, null);
});

test("report: both set -- on, default sender is Resend's test address", () => {
  const c = loadConfig(withEnv({ RESEND_API_KEY: "re_secret_123456", REPORT_EMAIL_TO: "me@example.com" }));
  assert.equal(c.report?.to, "me@example.com");
  assert.equal(c.report?.from, "DCA bot <onboarding@resend.dev>");
  assert.equal(c.report?.apiKey, "re_secret_123456");
});

test("report: REPORT_EMAIL_FROM overrides the sender", () => {
  const c = loadConfig(withEnv({ RESEND_API_KEY: "re_x", REPORT_EMAIL_TO: "me@example.com", REPORT_EMAIL_FROM: "bot@mydomain.dev" }));
  assert.equal(c.report?.from, "bot@mydomain.dev");
});

test("report: only one of the two, or a malformed address -- off, no throw", () => {
  assert.equal(loadConfig(withEnv({ RESEND_API_KEY: "re_x" })).report, null);
  assert.equal(loadConfig(withEnv({ REPORT_EMAIL_TO: "me@example.com" })).report, null);
  assert.equal(loadConfig(withEnv({ RESEND_API_KEY: "re_x", REPORT_EMAIL_TO: "not-an-email" })).report, null);
});

test("report: the API key and the address never show up in JSON.stringify(config)", () => {
  const c = loadConfig(withEnv({ RESEND_API_KEY: "re_secret_123456", REPORT_EMAIL_TO: "me@example.com" }));
  const json = JSON.stringify(c);
  assert.doesNotMatch(json, /re_secret_123456/);
  assert.doesNotMatch(json, /me@example\.com/);
});

// ============================================================
// loadMasterKey -- 32-byte base64 key for encrypting stored secrets
// ============================================================

test("loadMasterKey: 32 bytes of base64 is accepted and returned as a 32-byte Buffer", () => {
  const raw = Buffer.alloc(32, 7).toString("base64");
  const key = loadMasterKey({ MASTER_KEY: raw });
  assert.equal(key.length, 32);
  assert.equal(key.toString("base64"), raw);
});

test("loadMasterKey: surrounding whitespace is tolerated", () => {
  assert.equal(loadMasterKey({ MASTER_KEY: `  ${Buffer.alloc(32, 1).toString("base64")}  ` }).length, 32);
});

test("loadMasterKey: missing, wrong length, or not base64 -> ConfigError naming the fix", () => {
  for (const bad of [undefined, "", "   ", Buffer.alloc(16).toString("base64"), Buffer.alloc(33).toString("base64"), "not base64 at all !!", "0x" + "a".repeat(64)]) {
    rejectedWith(() => loadMasterKey({ MASTER_KEY: bad }), "openssl rand -base64 32");
  }
});

test("loadMasterKey: the key never appears in a log line", () => {
  const raw = Buffer.alloc(32, 9).toString("base64");
  loadMasterKey({ MASTER_KEY: raw });
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: string) => void lines.push(line);
  try {
    logger.info("leak test", { value: raw });
  } finally {
    console.log = original;
  }
  assert.ok(!lines.join("").includes(raw));
});
