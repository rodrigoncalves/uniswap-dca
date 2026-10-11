// Reads and validates the environment variables. Fails at boot with a clear
// message for each problem found -- all at once, not one by one.
//
// PRIVATE_KEY lives encrypted in the database -- setup.ts loadPrivateKey.
// Secrets (UNISWAP_API_KEY, RPC_URL, RPC_URL_FALLBACK, APP_PASSWORD)
// never show up in console.log(config) or in
// JSON.stringify(config): they are non-enumerable properties, and toJSON()
// returns only the safe fields regardless -- see the comment above
// freezeConfig().
//
// DCA settings (slippage, price impact, oracle deviation, approval days, min
// POL, run time) live in the database since F1c (DECISIONS.md #23); their old
// env vars only seed it once (setup.ts). OUTPUT_RECIPIENT is gone.

import { getAddress, isAddress } from "viem";
import { registerSecret, logger } from "./logger.js";

export class ConfigError extends Error {
  constructor(problems: string[]) {
    super(`${problems.length} configuration problem(s):\n` + problems.map((p) => `  - ${p}`).join("\n"));
    this.name = "ConfigError";
  }
}

export interface Config {
  // secrets -- never logged, never in JSON.stringify(config)
  readonly uniswapApiKey: string;
  readonly rpcUrl: string;
  readonly rpcUrlFallback: string | null;
  readonly appPassword: string;

  // tokens (operational addresses, configurable via env -- see DECISIONS.md #1)
  readonly tokenIn: `0x${string}`;
  readonly tokenInSymbol: string;
  readonly tokenOut: `0x${string}`;
  readonly tokenOutSymbol: string;

  // database and app
  readonly dbFile: string;
  readonly appPort: number;

  // optional email report after each scheduled run (F3). Hidden like the
  // secrets: it holds the Resend API key and the user's address.
  readonly report: ReportConfig | null;
}

export interface ReportConfig {
  readonly apiKey: string;
  readonly to: string;
  readonly from: string;
}

/**
 * RESEND_API_KEY + REPORT_EMAIL_TO, or reporting off. Never a ConfigError:
 * a half-configured email must not stop the bot from buying -- it warns
 * and turns reporting off instead.
 */
function reportConfigFrom(env: Env): ReportConfig | null {
  const apiKey = env.RESEND_API_KEY?.trim() || "";
  const to = env.REPORT_EMAIL_TO?.trim() || "";
  if (!apiKey && !to) return null;
  if (!apiKey || !to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    logger.warn("email report disabled: set both RESEND_API_KEY and a valid REPORT_EMAIL_TO");
    return null;
  }
  registerSecret(apiKey);
  return { apiKey, to, from: env.REPORT_EMAIL_FROM?.trim() || "DCA bot <onboarding@resend.dev>" };
}

type Env = Record<string, string | undefined>;

function requireNonEmpty(env: Env, key: string, problems: string[]): string | undefined {
  const value = env[key];
  if (value === undefined || value.trim() === "") {
    problems.push(`${key}: required and missing`);
    return undefined;
  }
  return value;
}

function requireAddress(env: Env, key: string, problems: string[]): `0x${string}` | undefined {
  const value = requireNonEmpty(env, key, problems);
  if (value === undefined) return undefined;
  // Regex first to tell "malformed hex" apart from "wrong checksum" in the
  // message -- isAddress() would have caught both, but with the same
  // generic message. All-lowercase passes (EIP-55 convention for "no
  // checksum declared"); the real protection for TOKEN_IN/TOKEN_OUT is the
  // symbol()/decimals() checked on-chain at boot (B2), not the checksum.
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    problems.push(`${key}: "${value}" is not a valid address (must be 0x followed by 40 hex characters)`);
    return undefined;
  }
  if (!isAddress(value, { strict: true })) {
    problems.push(
      `${key}: "${value}" has an invalid EIP-55 checksum for this address -- check for a typo or copy error`
    );
    return undefined;
  }
  return getAddress(value);
}

function requireNumber(
  env: Env,
  key: string,
  problems: string[],
  opts: { min?: number; max?: number; integer?: boolean } = {}
): number | undefined {
  const raw = requireNonEmpty(env, key, problems);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    problems.push(`${key}: "${raw}" is not a valid number`);
    return undefined;
  }
  if (opts.integer && !Number.isInteger(value)) {
    problems.push(`${key}: "${raw}" must be an integer`);
    return undefined;
  }
  if (opts.min !== undefined && value < opts.min) {
    problems.push(`${key}: ${value} is below the minimum allowed (${opts.min})`);
    return undefined;
  }
  if (opts.max !== undefined && value > opts.max) {
    problems.push(`${key}: ${value} is above the maximum allowed (${opts.max})`);
    return undefined;
  }
  return value;
}

const APP_PASSWORD_MIN_LENGTH = 12;

/**
 * Freezes the config and makes the secrets non-enumerable: they vanish
 * from console.log(config), Object.keys(config) and for...in. toJSON() is a
 * second layer -- it covers even serialization via Object.getOwnPropertyNames,
 * which sees non-enumerable properties (the first layer alone would not
 * cover that case).
 */
function freezeConfig(config: Config): Config {
  const secretKeys: (keyof Config)[] = ["uniswapApiKey", "rpcUrl", "rpcUrlFallback", "appPassword", "report"];
  const result = { ...config } as Config;
  for (const key of secretKeys) {
    Object.defineProperty(result, key, {
      value: config[key],
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }
  Object.defineProperty(result, "toJSON", {
    value: () => ({
      tokenIn: config.tokenIn,
      tokenInSymbol: config.tokenInSymbol,
      tokenOut: config.tokenOut,
      tokenOutSymbol: config.tokenOutSymbol,
      dbFile: config.dbFile,
      appPort: config.appPort,
      // secrets deliberately omitted
    }),
    enumerable: false,
  });
  return Object.freeze(result);
}

export interface AppConfig {
  readonly appPassword: string;
  readonly appPort: number;
  readonly dbFile: string;
}

/**
 * Subset of Config for entrypoints that only serve/read the history
 * (server.ts, control.ts, export.ts, seed-history.ts) -- they don't need
 * UNISWAP_API_KEY, RPC_URL or PRIVATE_KEY.
 */
export function loadAppConfig(env: Env = process.env): AppConfig {
  const problems: string[] = [];

  const appPassword = requireNonEmpty(env, "APP_PASSWORD", problems);
  if (appPassword !== undefined && appPassword.length < APP_PASSWORD_MIN_LENGTH) {
    problems.push(`APP_PASSWORD: must be at least ${APP_PASSWORD_MIN_LENGTH} characters -- the app is exposed to the internet via Coolify`);
  }
  const appPort = requireNumber(env, "APP_PORT", problems, { min: 1, max: 65535, integer: true });
  const dbFile = requireNonEmpty(env, "DB_FILE", problems);

  if (problems.length > 0) throw new ConfigError(problems);

  const config: AppConfig = { appPassword: appPassword!, appPort: appPort!, dbFile: dbFile! };
  registerSecret(config.appPassword);

  const result = { dbFile: config.dbFile, appPort: config.appPort } as AppConfig;
  Object.defineProperty(result, "appPassword", { value: config.appPassword, enumerable: false, writable: false, configurable: false });
  Object.defineProperty(result, "toJSON", {
    value: () => ({ dbFile: config.dbFile, appPort: config.appPort }),
    enumerable: false,
  });
  return Object.freeze(result);
}

/**
 * MASTER_KEY: 32 random bytes in base64 -- encrypts the `secrets` table
 * (crypto.ts). Round-trip check (decode, re-encode, compare) rejects
 * strings that Buffer.from(..., "base64") would silently half-decode.
 * Only the entrypoints that touch secrets call this (server.ts, and from F1d
 * the bot), so pause/export keep working without it.
 */
export function loadMasterKey(env: Env = process.env): Buffer {
  const raw = env.MASTER_KEY?.trim() ?? "";
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32 || key.toString("base64") !== raw) {
    throw new ConfigError(["MASTER_KEY: required, 32 random bytes in base64 -- generate with: openssl rand -base64 32"]);
  }
  registerSecret(raw);
  return key;
}

export function loadConfig(env: Env = process.env): Config {
  const problems: string[] = [];

  const uniswapApiKey = requireNonEmpty(env, "UNISWAP_API_KEY", problems);

  const rpcUrl = requireNonEmpty(env, "RPC_URL", problems);
  // http only on loopback: local anvil fork (D1/D2). Regex anchored at the
  // port/end so "http://127.0.0.1.evil.com" doesn't pass.
  if (rpcUrl !== undefined && !rpcUrl.startsWith("https://") && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(rpcUrl)) {
    problems.push(`RPC_URL: must start with "https://" (http only for 127.0.0.1/localhost)`);
  }

  const rpcUrlFallbackRaw = env.RPC_URL_FALLBACK;
  let rpcUrlFallback: string | null = null;
  if (rpcUrlFallbackRaw !== undefined && rpcUrlFallbackRaw.trim() !== "") {
    if (!rpcUrlFallbackRaw.startsWith("https://")) {
      problems.push(`RPC_URL_FALLBACK: must start with "https://"`);
    } else {
      rpcUrlFallback = rpcUrlFallbackRaw;
    }
  }

  const appPassword = requireNonEmpty(env, "APP_PASSWORD", problems);
  if (appPassword !== undefined && appPassword.length < APP_PASSWORD_MIN_LENGTH) {
    problems.push(`APP_PASSWORD: must be at least ${APP_PASSWORD_MIN_LENGTH} characters -- the app is exposed to the internet via Coolify`);
  }

  const tokenIn = requireAddress(env, "TOKEN_IN", problems);
  const tokenInSymbol = requireNonEmpty(env, "TOKEN_IN_SYMBOL", problems);
  const tokenOut = requireAddress(env, "TOKEN_OUT", problems);
  const tokenOutSymbol = requireNonEmpty(env, "TOKEN_OUT_SYMBOL", problems);
  if (tokenIn !== undefined && tokenOut !== undefined && tokenIn === tokenOut) {
    problems.push("TOKEN_IN and TOKEN_OUT cannot be the same address");
  }

  const dbFile = requireNonEmpty(env, "DB_FILE", problems);
  const appPort = requireNumber(env, "APP_PORT", problems, { min: 1, max: 65535, integer: true });

  if (problems.length > 0) {
    throw new ConfigError(problems);
  }

  // At this point, problems.length === 0 guarantees every required field
  // was validated successfully -- the "!" below reflect that guarantee,
  // they don't bypass it.
  const config: Config = {
    uniswapApiKey: uniswapApiKey!,
    rpcUrl: rpcUrl!,
    rpcUrlFallback,
    appPassword: appPassword!,
    tokenIn: tokenIn!,
    tokenInSymbol: tokenInSymbol!,
    tokenOut: tokenOut!,
    tokenOutSymbol: tokenOutSymbol!,
    dbFile: dbFile!,
    appPort: appPort!,
    report: reportConfigFrom(env),
  };

  registerSecret(config.uniswapApiKey);
  registerSecret(config.rpcUrl);
  registerSecret(config.rpcUrlFallback);
  registerSecret(config.appPassword);

  return freezeConfig(config);
}
