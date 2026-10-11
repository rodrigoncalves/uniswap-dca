// History app: native http, no framework. Reads APP_PASSWORD/APP_PORT/
// DB_FILE (loadAppConfig) and MASTER_KEY (loadMasterKey, F1a). The wallet key
// lives encrypted in the database. RPC only for the F7 balance
// panel, and only when the full bot config loads (it does in the container,
// which also runs the scheduled task). Serves public/index.html plus public/app.js and
// public/vendor/qrcode.js (no CDN, invariant 5 extended to the browser).
//
// Binds on 0.0.0.0: on Coolify the proxy exposes this to the internet -- so
// login is mandatory (the process won't even start without APP_PASSWORD,
// see config.ts). Without a session only /health, /api/login and the static
// page + scripts answer -- none carries data. F6, DECISIONS.md #21.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { createHash, timingSafeEqual, randomBytes } from "node:crypto";
import { join } from "node:path";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadAppConfig, loadMasterKey, loadConfig } from "./config.js";
import { createRpcClient, getNativeBalance, getErc20Balance, getErc20Allowance } from "./wallet.js";
import { PERMIT2_ADDRESS } from "./tokens.js";
import { balanceHealth, averageGasWei, GAS_SAMPLE_RUNS } from "./health.js";
import { openDb, createSession, sessionExpiresAt, deleteSession, deleteAllSessions, SESSION_TTL_MS, listAllRuns, getControl, setPaused, getSecret, putSecret, claimTotpStep, listStrategies, getStrategy, createStrategy, updateStrategy, deleteStrategy, listStrategyHistory, activeAmounts, recentGasCostsPol, getSettings, saveSettings, getReportMode, setReportMode, getAlertDays, setAlertDays, REPORT_MODES, type ReportMode, completeReachedStrategies, strategyUnits, manualBuyUnits, type Run } from "./db.js";
import { encryptSecret, decryptSecret } from "./crypto.js";
import { base32Encode, base32Decode, matchTotp, otpauthUri } from "./totp.js";
import { Elevations, TotpLockout, ELEVATION_TTL_MS } from "./elevation.js";
import { summarize } from "./report.js";
import { parseStrategyInput, parsePrivateKey, assertRunTotal, amountToUnits, formatUnits, limitReached, AMOUNT_DECIMALS, MAX_RUN_TOTAL, ValidationError, validateSettings, SETTINGS_CAPS } from "./validation.js";
import { seedFromEnv, loadPrivateKey, storePrivateKey, SetupError, setupIssues } from "./setup.js";
import { logger, registerSecret } from "./logger.js";

// Decimals for display only -- the real on-chain check is B1/B2. If the
// input/output token ever changes, this number has to follow (no way to
// derive it here without RPC, which server.ts deliberately doesn't use).

const config = loadAppConfig();
const db = openDb(config.dbFile);

// F1a: MASTER_KEY is required, like APP_PASSWORD (README.md invariant #7). And a
// stored secret that doesn't decrypt with it stops the boot right here --
// a wrong key must fail the deploy (health check never goes green, Coolify
// rolls back), not start an app that 500s on every TOTP request.
const masterKey = loadMasterKey();
seedFromEnv(db, process.env, new Date().toISOString(), masterKey);
for (const name of ["totp_secret", "private_key"] as const) {
  const blob = getSecret(db, name);
  if (blob !== undefined) registerSecret(decryptSecret(masterKey, name, blob));
}

// F7 balance panel. No RPC config -> the panel says "unavailable", the app
// still starts (history/control never needed RPC). loadConfig registers
// RPC_URL as a secret, so a network error logged below is sanitized.
const rpc = (() => {
  try {
    const bot = loadConfig();
    return { client: createRpcClient(bot.rpcUrl, bot.rpcUrlFallback), tokenIn: bot.tokenIn };
  } catch {
    logger.warn("balance panel unavailable: bot config (RPC_URL, ...) incomplete in this environment");
    return null;
  }
})();
const BALANCE_CACHE_MS = 60_000;
let balanceCache: { walletAddress: string; at: number; reads: { tokenIn: bigint; pol: bigint; allowance: bigint } | null } | null = null;

/** Derive the current address from the database; replacing the key changes it immediately. */
function walletAddress(): `0x${string}` | null {
  return getSecret(db, "private_key") === undefined ? null : parsePrivateKey(loadPrivateKey(db, masterKey)).address;
}

async function balanceResponse() {
  if (rpc === null) return { available: false };
  const address = walletAddress();
  if (address === null) return { available: false };
  // failures are cached too: an RPC outage must not turn every page load into more RPC calls
  if (balanceCache === null || balanceCache.walletAddress !== address || Date.now() - balanceCache.at >= BALANCE_CACHE_MS) {
    let reads = null;
    try {
      const [tokenIn, pol, allowance] = await Promise.all([
        getErc20Balance(rpc.client, rpc.tokenIn, address),
        getNativeBalance(rpc.client, address),
        getErc20Allowance(rpc.client, rpc.tokenIn, address, PERMIT2_ADDRESS),
      ]);
      reads = { tokenIn, pol, allowance };
    } catch (err) {
      logger.warn("balance read failed", { error: err });
    }
    // The key route can replace the wallet while RPC is pending. Discard that result.
    if (walletAddress() !== address) return { available: false };
    balanceCache = { walletAddress: address, at: Date.now(), reads };
  }
  const reads = balanceCache.reads;
  if (reads === null) return { available: false };
  const nowIso = new Date().toISOString();
  const today = nowIso.slice(0, 10);
  const dailyNeedUnits = activeAmounts(db, today).reduce((sum, amount) => sum + amountToUnits(amount), 0n);
  const avgGasWei = averageGasWei(recentGasCostsPol(db, GAS_SAMPLE_RUNS));
  const settings = getSettings(db);
  const minPolWei = BigInt(Math.round((settings?.minPolBalance ?? 0) * 1e18)); // same conversion as dca.ts
  return {
    available: true,
    readAt: new Date(balanceCache.at).toISOString(),
    tokenIn: formatUnits(reads.tokenIn, AMOUNT_DECIMALS),
    pol: formatUnits(reads.pol, 18),
    allowance: formatUnits(reads.allowance, AMOUNT_DECIMALS),
    dailyNeed: formatUnits(dailyNeedUnits, AMOUNT_DECIMALS),
    avgGasPol: avgGasWei === null ? null : formatUnits(avgGasWei, 18),
    minPol: formatUnits(minPolWei, 18),
    health: balanceHealth({ tokenInUnits: reads.tokenIn, dailyNeedUnits, polWei: reads.pol, minPolWei, avgGasWei, allowanceUnits: reads.allowance, nowIso, runTime: settings?.runTime ?? "00:00" }),
  };
}

// process.cwd(), not __dirname -- in dev (tsx src/server.ts) the file is
// in src/, going up 1 level reaches the root; compiled (dist/src/server.js)
// it would need to go up 2 levels, a real asymmetry that only showed up
// running inside the Docker container (500 from ENOENT), not in local dev.
// cwd() is the same in both cases -- whoever starts the process (npm run
// app, or WORKDIR /app in the Dockerfile) always does it from the project
// root, same convention DB_FILE already uses (relative path resolved by cwd).
const INDEX_HTML_PATH = join(process.cwd(), "public", "index.html");

// Everything the page loads comes from here -- no CDN (the page shows the
// TOTP secret and, from F1d, accepts the private key). Explicit map, so no
// path from the URL ever reaches the filesystem.
const PUBLIC_DIR = join(process.cwd(), "public");
const STATIC_FILES: Record<string, { file: string; type: string }> = {
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/vendor/qrcode.js": { file: "vendor/qrcode.js", type: "text/javascript; charset=utf-8" },
  "/sw.js": { file: "sw.js", type: "text/javascript; charset=utf-8" },
  "/manifest.webmanifest": { file: "manifest.webmanifest", type: "application/manifest+json" },
  "/icons/icon-192.png": { file: "icons/icon-192.png", type: "image/png" },
  "/icons/icon-512.png": { file: "icons/icon-512.png", type: "image/png" },
  "/icons/icon-maskable-512.png": { file: "icons/icon-maskable-512.png", type: "image/png" },
  "/icons/apple-touch-icon.png": { file: "icons/apple-touch-icon.png", type: "image/png" },
};

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

// ============================================================
// authentication: password + TOTP once at login -> 30-day session cookie;
// constant-time password comparison, per-IP throttle
// ============================================================

function sha256(input: string): Buffer {
  return createHash("sha256").update(input, "utf8").digest();
}

const expectedPasswordHash = sha256(config.appPassword);

function passwordMatches(password: unknown): boolean {
  if (typeof password !== "string") return false;
  const hash = sha256(password);
  // Lengths always match (sha256 is fixed-size), but timingSafeEqual
  // requires it explicitly -- redundant check on purpose, documenting the
  // invariant instead of relying on it silently.
  return hash.length === expectedPasswordHash.length && timingSafeEqual(hash, expectedPasswordHash);
}

interface ThrottleEntry {
  failures: number;
  blockedUntil: number;
}
const throttle = new Map<string, ThrottleEntry>();
// Separate map for wrong TOTP codes -- a correct login password clears
// `throttle`, which would otherwise wipe out TOTP failures before they could
// accumulate. verifyCode uses this map.
const totpThrottle = new Map<string, ThrottleEntry>();
const MAX_THROTTLE_ENTRIES = 10_000; // sanity cap against memory leak from IP spam

function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0]!.trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

function isThrottled(ip: string, map: Map<string, ThrottleEntry> = throttle): boolean {
  const entry = map.get(ip);
  return entry !== undefined && Date.now() < entry.blockedUntil;
}

function recordAuthFailure(ip: string, map: Map<string, ThrottleEntry> = throttle): void {
  const entry = map.get(ip) ?? { failures: 0, blockedUntil: 0 };
  entry.failures += 1;
  // exponential backoff, capped at 30s -- enough to discourage brute force
  // without locking out a legitimate user who mistyped the password once.
  entry.blockedUntil = Date.now() + Math.min(2 ** entry.failures * 200, 30_000);
  if (map.size >= MAX_THROTTLE_ENTRIES && !map.has(ip)) {
    map.delete(map.keys().next().value!);
  }
  map.set(ip, entry);
}

function clearAuthFailures(ip: string, map: Map<string, ThrottleEntry> = throttle): void {
  map.delete(ip);
}

// ============================================================
// CSRF guard for the write routes
//
// SameSite=Strict already keeps the session cookie off cross-site requests;
// requiring JSON + a custom header also forces a CORS preflight the
// malicious origin can't satisfy (defence in depth).
// ============================================================

function hasCsrfGuard(req: IncomingMessage): boolean {
  const contentType = req.headers["content-type"];
  const marker = req.headers["x-dca-app"];
  return typeof contentType === "string" && contentType.includes("application/json") && marker !== undefined;
}

// ============================================================
// TOTP + elevation window (F1a, DECISIONS.md #19)
//
// Dangerous actions (buy, resume, strategy changes) need a TOTP code or an
// open 15-min elevation window, on top of the session -- the elevation
// cookie is never a replacement for the login.
// ============================================================

const elevations = new Elevations();
const lockout = new TotpLockout();
const ENROLMENT_TTL_MS = 10 * 60 * 1000;
let pendingEnrolment: { secret: Buffer; expiresAt: number } | null = null;

function totpSecret(): Buffer | null {
  const blob = getSecret(db, "totp_secret");
  if (blob === undefined) return null;
  const b32 = decryptSecret(masterKey, "totp_secret", blob);
  registerSecret(b32);
  return base32Decode(b32);
}

function readCookie(req: IncomingMessage, name: string): string | undefined {
  return new RegExp(`(?:^|;\\s*)${name}=([A-Za-z0-9_-]+)`).exec(req.headers.cookie ?? "")?.[1];
}

const elevationToken = (req: IncomingMessage) => readCookie(req, "dca_elevated");
const sessionToken = (req: IncomingMessage) => readCookie(req, "dca_session");

/** Appends, so login can set the session and elevation cookies in one response. */
function addCookie(res: ServerResponse, name: string, value: string, path: string, maxAgeSeconds: number): void {
  const previous = res.getHeader("Set-Cookie");
  const cookie = `${name}=${value}; HttpOnly; Secure; SameSite=Strict; Path=${path}; Max-Age=${maxAgeSeconds}`;
  res.setHeader("Set-Cookie", [...(Array.isArray(previous) ? previous : []), cookie]);
}

function setElevationCookie(res: ServerResponse, token: string, maxAgeSeconds: number): void {
  addCookie(res, "dca_elevated", token, "/api", maxAgeSeconds);
}

/** Checks `code` against `secret`, burns the step (replay). Sends the error response itself on failure. */
function verifyCode(req: IncomingMessage, res: ServerResponse, secret: Buffer, code: unknown): boolean {
  const now = Date.now();
  const locked = lockout.lockedUntil(now);
  if (locked !== null) {
    sendJson(res, 429, { error: `too many wrong codes -- TOTP locked until ${new Date(locked).toISOString()}` });
    return false;
  }
  const ip = clientIp(req);
  if (isThrottled(ip, totpThrottle)) {
    sendJson(res, 429, { error: "too many attempts -- wait before trying again" });
    return false;
  }
  const step = matchTotp(secret, code, now);
  if (step === null || !claimTotpStep(db, step)) {
    lockout.fail(now);
    recordAuthFailure(ip, totpThrottle);
    sendJson(res, 403, { error: step === null ? "wrong code" : "code already used -- wait for the next one" });
    return false;
  }
  clearAuthFailures(ip, totpThrottle);
  lockout.succeed();
  return true;
}

/** Opens the elevation window and sets the cookie. Call only after whatever the code was verifying has succeeded. */
function openElevationWindow(res: ServerResponse): void {
  const { token } = elevations.open(Date.now());
  setElevationCookie(res, token, ELEVATION_TTL_MS / 1000);
}

/** Verifies `code` against `secret` and opens an elevation window on success. Sends the error response itself. */
function acceptCode(req: IncomingMessage, res: ServerResponse, secret: Buffer, code: unknown): boolean {
  if (!verifyCode(req, res, secret, code)) return false;
  openElevationWindow(res);
  return true;
}

/** Gate for TOTP-protected routes (F1b on): open window, or a valid `totp` in the body. */
function requireElevation(req: IncomingMessage, res: ServerResponse, body: { totp?: unknown }): boolean {
  if (elevations.expiresAt(elevationToken(req), Date.now()) !== null) return true;
  const locked = lockout.lockedUntil(Date.now());
  if (locked !== null) {
    sendJson(res, 429, { error: `too many wrong codes -- TOTP locked until ${new Date(locked).toISOString()}` });
    return false;
  }
  const secret = totpSecret();
  if (secret === null) {
    sendJson(res, 409, { error: "set up the authenticator first" });
    return false;
  }
  if (body.totp === undefined) {
    sendJson(res, 403, { error: "authenticator code required", totpRequired: true });
    return false;
  }
  return acceptCode(req, res, secret, body.totp);
}

function authState(req: IncomingMessage) {
  const now = Date.now();
  const elevatedUntil = elevations.expiresAt(elevationToken(req), now);
  const lockedUntil = lockout.lockedUntil(now);
  const sessionUntil = sessionExpiresAt(db, sessionToken(req), now);
  return {
    serverNow: new Date(now).toISOString(),
    sessionExpiresAt: sessionUntil === null ? null : new Date(sessionUntil).toISOString(),
    totpEnrolled: getSecret(db, "totp_secret") !== undefined,
    elevatedUntil: elevatedUntil === null ? null : new Date(elevatedUntil).toISOString(),
    lockedUntil: lockedUntil === null ? null : new Date(lockedUntil).toISOString(),
  };
}

// ============================================================
// responses
// ============================================================

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

// No throttle here: a session token is 256 random bits, guessing it is not
// a thing. The password (the guessable part) is throttled in /api/login.
function requireAuth(req: IncomingMessage, res: ServerResponse): boolean {
  if (sessionExpiresAt(db, sessionToken(req), Date.now()) !== null) return true;
  sendJson(res, 401, { error: "unauthorized" });
  return false;
}

/** Password, then (once enrolled) a TOTP code -> session + an elevation window. */
function login(req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>): void {
  const ip = clientIp(req);
  if (isThrottled(ip)) return sendJson(res, 429, { error: "too many attempts -- wait before trying again" });
  // Password first: a password guesser never reaches the TOTP check, so it
  // can't trip the global TotpLockout and lock the real user out.
  if (!passwordMatches(body.password)) {
    recordAuthFailure(ip);
    return sendJson(res, 401, { error: "wrong password" });
  }
  clearAuthFailures(ip);
  // ponytail: before enrolment the password alone logs in (bootstrap, same as pre-F6); enrolment is the first thing the page offers.
  const secret = totpSecret();
  if (secret !== null) {
    if (body.totp === undefined || body.totp === "") return sendJson(res, 403, { error: "authenticator code required", totpRequired: true });
    if (!acceptCode(req, res, secret, body.totp)) return;
  }
  const { token } = createSession(db, Date.now());
  addCookie(res, "dca_session", token, "/", SESSION_TTL_MS / 1000);
  logger.info("logged in");
  sendJson(res, 200, { ok: true });
}

function buildHistoryResponse(runs: Run[], control: ReturnType<typeof getControl>) {
  return {
    tiles: summarize(runs),
    control: control
      ? { paused: control.paused, pausedAt: control.pausedAt, pausedUntil: control.pausedUntil, reason: control.reason }
      : { paused: false, pausedAt: null, pausedUntil: null, reason: null },
    runs,
  };
}

// ============================================================
// manual buy from the app -- runs the exact CLI path (dca.ts --manual) in a
// child process, so every check, the BROADCAST-before-send and recovery are
// the same code. One at a time; the child inherits env and loader flags
// (fork), and logs straight to the app's output. DECISIONS.md #17.
// ============================================================

const DCA_ENTRY = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./dca.ts" : "./dca.js", import.meta.url));
const buyState = { running: false, amount: null as string | null, strategyId: null as number | null, startedAt: null as string | null, exitCode: null as number | null };

function startBuy(amount: string, strategyId: number): void {
  Object.assign(buyState, { running: true, amount, strategyId, startedAt: new Date().toISOString(), exitCode: null });
  const child = fork(DCA_ENTRY, ["--manual", "--strategy", String(strategyId)]);
  child.on("exit", (code) => {
    Object.assign(buyState, { running: false, exitCode: code ?? 1 });
    logger.info("manual buy from the app finished", { amount, exitCode: code });
  });
}

function dailyTotal(): string {
  const amounts = activeAmounts(db, new Date().toISOString().slice(0, 10));
  return formatUnits(amounts.reduce((sum, amount) => sum + amountToUnits(amount), 0n), AMOUNT_DECIMALS);
}

function readJsonBody(req: IncomingMessage, maxBytes = 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk;
      if (body.length > maxBytes) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

/** CSRF guard + JSON object body, then `handler`. Every write route from F1a on goes through here. */
function postJson(req: IncomingMessage, res: ServerResponse, handler: (body: Record<string, unknown>) => void): void {
  if (!hasCsrfGuard(req)) {
    sendJson(res, 400, { error: "request needs Content-Type: application/json and an X-Dca-App header" });
    return;
  }
  readJsonBody(req).then(
    (body) => {
      if (body === null || typeof body !== "object" || Array.isArray(body)) return sendJson(res, 400, { error: "JSON object expected" });
      try {
        handler(body as Record<string, unknown>);
      } catch (err) {
        logger.error("request handler failed", { path: req.url, error: err });
        if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      }
    },
    () => sendJson(res, 400, { error: "invalid JSON body" })
  );
}

// ============================================================
// server
// ============================================================

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { status: "ok" });
    return;
  }

  // Older browsers ask for /favicon.ico on their own (the page's icon is an
  // inline data URI). Answering before auth avoids a second password prompt.
  if (req.method === "GET" && url.pathname === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/login") {
    postJson(req, res, (body) => login(req, res, body));
    return;
  }

  // The page and its scripts carry no data -- served without a session so
  // the page can show its own login form.
  if (req.method === "GET" && url.pathname === "/") {
    let html: string;
    try {
      html = readFileSync(INDEX_HTML_PATH, "utf8");
    } catch (err) {
      logger.error("failed to read public/index.html", { error: err });
      sendJson(res, 500, { error: "internal error" });
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff" });
    res.end(html);
    return;
  }

  const staticFile = req.method === "GET" ? STATIC_FILES[url.pathname] : undefined;
  if (staticFile) {
    let body: Buffer;
    try {
      body = readFileSync(join(PUBLIC_DIR, staticFile.file));
    } catch (err) {
      logger.error("failed to read static file", { path: url.pathname, error: err });
      sendJson(res, 500, { error: "internal error" });
      return;
    }
    // sw.js must revalidate every time so a new worker version is picked up.
    res.writeHead(200, { "Content-Type": staticFile.type, "X-Content-Type-Options": "nosniff", ...(url.pathname === "/sw.js" ? { "Cache-Control": "no-cache" } : {}) });
    res.end(body);
    return;
  }

  if (!requireAuth(req, res)) return;

  if (req.method === "POST" && (url.pathname === "/api/logout" || url.pathname === "/api/logout-all")) {
    postJson(req, res, () => {
      if (url.pathname === "/api/logout-all") deleteAllSessions(db);
      else deleteSession(db, sessionToken(req));
      elevations.close(elevationToken(req));
      addCookie(res, "dca_session", "", "/", 0);
      setElevationCookie(res, "", 0);
      logger.info(url.pathname === "/api/logout-all" ? "logged out everywhere" : "logged out");
      sendJson(res, 200, { ok: true });
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/history") {
    const id = url.searchParams.get("strategy");
    if (id !== null && (!/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id)))) return sendJson(res, 400, { error: "invalid strategy id" });
    const runs = id === null ? listAllRuns(db) : listStrategyHistory(db, Number(id));
    sendJson(res, 200, buildHistoryResponse(runs, getControl(db)));
    return;
  }

  // Pause needs no TOTP (the safe direction, README.md invariant #6); resume does.
  if (req.method === "POST" && (url.pathname === "/api/pause" || url.pathname === "/api/resume")) {
    postJson(req, res, (body) => {
      const paused = url.pathname === "/api/pause";
      if (!paused && !requireElevation(req, res, body)) return;
      setPaused(db, { paused, reason: paused ? "paused from the app" : null, until: null });
      logger.info(paused ? "DCA paused via app" : "DCA resumed via app");
      sendJson(res, 200, { paused });
    });
    return;
  }

  // F1c: shared settings; caps come from validation.ts and the frontend
  // only mirrors them in min/max/step -- every save is validated here.
  if (req.method === "GET" && url.pathname === "/api/settings") {
    sendJson(res, 200, { settings: getSettings(db) ?? null, caps: SETTINGS_CAPS, setupIssues: setupIssues(db), walletAddress: walletAddress(), reportMode: getReportMode(db), alertDays: getAlertDays(db), reportConfigured: Boolean(process.env.RESEND_API_KEY?.trim() && process.env.REPORT_EMAIL_TO?.trim()) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/key") {
    postJson(req, res, (body) => {
      if (typeof body.privateKey === "string") {
        registerSecret(body.privateKey);
        registerSecret(body.privateKey.trim());
      }
      if (!requireElevation(req, res, body)) return;
      let parsed;
      try {
        parsed = parsePrivateKey(body.privateKey);
      } catch (err) {
        return sendJson(res, 400, { error: err instanceof ValidationError ? err.message : "invalid private key" });
      }
      const previousAddress = walletAddress();
      try {
        storePrivateKey(db, masterKey, parsed.key);
      } catch (err) {
        if (err instanceof SetupError) return sendJson(res, 409, { error: err.message });
        throw err;
      }
      balanceCache = null;
      logger.warn("private key replaced from the app", { previousAddress, newAddress: parsed.address });
      sendJson(res, 200, { walletAddress: parsed.address });
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/settings") {
    postJson(req, res, (body) => {
      if (!requireElevation(req, res, body)) return;
      let settings;
      try {
        settings = validateSettings(body);
      } catch (err) {
        return sendJson(res, 400, { error: err instanceof ValidationError ? err.message : "invalid settings" });
      }
      saveSettings(db, settings, new Date().toISOString());
      logger.info("settings saved from the app", { settings });
      sendJson(res, 200, { settings });
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/report") {
    postJson(req, res, (body) => { // session + CSRF only, no TOTP: a notification preference can't move funds (DECISIONS.md #26)
      if (body.alertDays !== undefined) {
        const days = body.alertDays;
        if (typeof days !== "number" || !Number.isInteger(days) || days < 0 || days > 30) return sendJson(res, 400, { error: "alert days must be a whole number from 0 to 30" });
        setAlertDays(db, days);
        logger.info("low-funds alert days changed from the app", { alertDays: days });
        return sendJson(res, 200, { alertDays: days });
      }
      const mode = REPORT_MODES.find((m) => m === body.mode);
      if (!mode) return sendJson(res, 400, { error: `mode must be one of: ${REPORT_MODES.join(", ")}` });
      setReportMode(db, mode);
      logger.info("email report mode changed from the app", { mode });
      sendJson(res, 200, { reportMode: mode });
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/balance") {
    balanceResponse().then(
      (body) => sendJson(res, 200, body),
      (err) => {
        logger.error("balance handler failed", { error: err });
        sendJson(res, 200, { available: false });
      }
    );
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/buy") {
    sendJson(res, 200, buyState);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/buy") {
    if (!hasCsrfGuard(req)) {
      sendJson(res, 400, { error: "request needs Content-Type: application/json and an X-Dca-App header" });
      return;
    }
    if (buyState.running) {
      sendJson(res, 409, { error: "a manual buy is already running" });
      return;
    }
    postJson(req, res, (body) => {
      if (!requireElevation(req, res, body)) return;
      // F8: the strategy's own amount; the child's claimManualRun re-derives it under the write lock.
      if (body.amount !== undefined) return sendJson(res, 400, { error: "no amount: a manual buy spends the strategy's configured amount" });
      const strategyId = Number(body.strategyId);
      const strategy = Number.isInteger(strategyId) ? getStrategy(db, strategyId) : undefined;
      const nowIso = new Date().toISOString();
  const today = nowIso.slice(0, 10);
      if (!strategy || strategy.status === "completed" || (strategy.endDate !== null && strategy.endDate < today)) {
        sendJson(res, 400, { error: "choose an active or paused strategy that hasn't ended" });
        return;
      }
      const units = manualBuyUnits(db, strategy, AMOUNT_DECIMALS);
      if (units <= 0n) return sendJson(res, 400, { error: "nothing left of the strategy's max total" });
      const amount = formatUnits(units, AMOUNT_DECIMALS);
      if (buyState.running) return sendJson(res, 409, { error: "a manual buy is already running" });
      logger.info("manual buy started from the app", { amount, strategyId });
      startBuy(amount, strategyId);
      sendJson(res, 202, buyState);
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/auth") {
    res.setHeader("Cache-Control", "no-store");
    sendJson(res, 200, authState(req));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/totp/setup") {
    postJson(req, res, () => {
      if (getSecret(db, "totp_secret") !== undefined) {
        return sendJson(res, 409, { error: "authenticator already set up -- reset it with npm run totp-reset on the server" });
      }
      pendingEnrolment = { secret: randomBytes(20), expiresAt: Date.now() + ENROLMENT_TTL_MS };
      const secret = base32Encode(pendingEnrolment.secret);
      sendJson(res, 200, { secret, uri: otpauthUri(secret) });
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/totp/confirm") {
    postJson(req, res, (body) => {
      if (getSecret(db, "totp_secret") !== undefined) return sendJson(res, 409, { error: "authenticator already set up" });
      if (pendingEnrolment === null || Date.now() >= pendingEnrolment.expiresAt) {
        pendingEnrolment = null;
        return sendJson(res, 409, { error: "no enrolment in progress (or it expired) -- start again" });
      }
      const secret = pendingEnrolment.secret;
      if (!verifyCode(req, res, secret, body.totp)) return;
      const b32 = base32Encode(secret);
      registerSecret(b32);
      putSecret(db, "totp_secret", encryptSecret(masterKey, "totp_secret", b32));
      pendingEnrolment = null;
      openElevationWindow(res);
      logger.info("authenticator set up");
      sendJson(res, 200, authState(req));
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/unlock") {
    postJson(req, res, (body) => {
      const secret = totpSecret();
      if (secret === null) return sendJson(res, 409, { error: "set up the authenticator first" });
      if (!acceptCode(req, res, secret, body.totp)) return;
      sendJson(res, 200, { ok: true });
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/lock") {
    postJson(req, res, () => {
      elevations.close(elevationToken(req));
      setElevationCookie(res, "", 0);
      sendJson(res, 200, { ok: true });
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/strategies") {
    const nowIso = new Date().toISOString();
    completeReachedStrategies(db, nowIso.slice(0, 10), nowIso, AMOUNT_DECIMALS);
    const strategies = listStrategies(db).map((strategy) => ({ ...strategy, tiles: summarize(listStrategyHistory(db, strategy.id)) }));
    sendJson(res, 200, { strategies, dailyTotal: dailyTotal(), maxRunTotal: MAX_RUN_TOTAL });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/strategies") {
    postJson(req, res, (body) => {
      if (!requireElevation(req, res, body)) return;
      const nowIso = new Date().toISOString();
  const today = nowIso.slice(0, 10);
      let input: ReturnType<typeof parseStrategyInput>;
      try {
        input = parseStrategyInput(body, today, "create");
        assertRunTotal([...activeAmounts(db, today), input.amount!]);
      } catch (err) {
        const status = err instanceof ValidationError ? (err.message.includes("per-run cap") ? 409 : 400) : 500;
        return sendJson(res, status, { error: err instanceof ValidationError ? err.message : "internal error" });
      }
      const id = createStrategy(db, { label: input.label ?? null, amount: input.amount!, endDate: input.endDate ?? null, maxTotal: input.maxTotal ?? null, createdAt: new Date().toISOString() });
      logger.info("strategy created from the app", { id, amount: input.amount });
      sendJson(res, 201, getStrategy(db, id));
    });
    return;
  }

  const strategyRoute = /^\/api\/strategies\/(\d+)$/.exec(url.pathname);
  if (strategyRoute && (req.method === "PATCH" || req.method === "DELETE")) {
    const id = Number(strategyRoute[1]);
    if (!Number.isSafeInteger(id) || id < 1) return sendJson(res, 400, { error: "invalid strategy id" });
    postJson(req, res, (body) => {
      const current = getStrategy(db, id);
      if (!current) return sendJson(res, 404, { error: `strategy #${id} not found` });
      const nowIso = new Date().toISOString();
      const today = nowIso.slice(0, 10);

      if (req.method === "DELETE") {
        if (!requireElevation(req, res, body)) return;
        try {
          deleteStrategy(db, id);
        } catch (err) {
          return sendJson(res, 409, { error: err instanceof Error ? err.message : "cannot delete" });
        }
        logger.info("strategy deleted from the app", { id });
        return sendJson(res, 200, { deleted: id });
      }

      const status = body.status;
      if (status !== undefined && status !== "active" && status !== "paused" && status !== "completed") {
        return sendJson(res, 400, { error: 'status: "active", "paused" or "completed"' });
      }
      const onlyPause = Object.keys(body).every((key) => key === "status" || key === "totp") && status === "paused";
      if (!onlyPause && !requireElevation(req, res, body)) return;

      let input: ReturnType<typeof parseStrategyInput>;
      try {
        input = parseStrategyInput(body, today, "update");
        const next = { ...current, ...input };
        const invested = strategyUnits(db, id, "invested");
        const limit = limitReached({ endDate: next.endDate, maxTotalUnits: next.maxTotal === null ? null : amountToUnits(next.maxTotal) }, invested, today);
        const nextStatus = status ?? (current.status === "completed" && limit === null && (input.endDate !== undefined || input.maxTotal !== undefined) ? "active" : current.status);
        if (nextStatus === "active" && (next.endDate === null || next.endDate >= today)) {
          const others = listStrategies(db).filter((strategy) => strategy.id !== id && strategy.status === "active" && (strategy.endDate === null || strategy.endDate >= today)).map((strategy) => strategy.amount);
          assertRunTotal([...others, next.amount]);
        }
      } catch (err) {
        const status = err instanceof ValidationError ? (err.message.includes("per-run cap") ? 409 : 400) : 500;
        return sendJson(res, status, { error: err instanceof ValidationError ? err.message : "internal error" });
      }
      try {
        updateStrategy(db, id, { ...input, ...(status !== undefined ? { status } : {}) }, nowIso, today, AMOUNT_DECIMALS);
      } catch (err) {
        return sendJson(res, 409, { error: err instanceof Error ? err.message : "cannot update" });
      }
      logger.info("strategy updated from the app", { id, fields: Object.keys(body).filter((key) => key !== "totp") });
      sendJson(res, 200, getStrategy(db, id));
    });
    return;
  }

  sendJson(res, 404, { error: "not found" });
});

server.listen(config.appPort, "0.0.0.0", () => {
  logger.info(`app listening on 0.0.0.0:${config.appPort}`);
});
