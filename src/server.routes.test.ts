import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { openDb, createStrategy, getSecret, insertManualRun, updateManualRun } from "./db.js";
import { base32Decode, stepAt, totpAt } from "./totp.js";
import { parsePrivateKey } from "./validation.js";
import { storePrivateKey } from "./setup.js";

test("routes enforce login sessions, CSRF, TOTP and the cap when a completed strategy revives", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dca-route-test-"));
  const dbFile = join(dir, "test.db");
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const db = openDb(dbFile);
  createStrategy(db, { id: 1, label: null, amount: "900", endDate: null, createdAt: new Date().toISOString() });
  createStrategy(db, { id: 2, label: null, amount: "200", endDate: yesterday, createdAt: new Date().toISOString() });
  db.close();

  const port = await new Promise<number>((resolve) => {
    const socket = createServer().listen(0, "127.0.0.1", () => {
      const address = socket.address();
      const value = typeof address === "object" && address ? address.port : 0;
      socket.close(() => resolve(value));
    });
  });
  const password = "test-password-only";
  const initialKey = `0x${"1".repeat(64)}`;
  const replacementKey = `0x${"2".repeat(64)}`;
  let session = "";
  const app = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? "",
      APP_PASSWORD: password,
      APP_PORT: String(port),
      DB_FILE: dbFile,
      PRIVATE_KEY: initialKey,
      MASTER_KEY: Buffer.alloc(32, 1).toString("base64"),
    },
    stdio: "ignore",
  });
  const base = `http://127.0.0.1:${port}`;
  const request = (path: string, method = "GET", body?: object, extra: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method,
      headers: { ...(body ? { "Content-Type": "application/json", "X-Dca-App": "1" } : {}), ...extra, Cookie: [session, extra.Cookie].filter(Boolean).join("; ") },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (app.exitCode !== null) throw new Error(`app exited: ${app.exitCode}`);
      try {
        const response = await fetch(`${base}/health`);
        ready = response.ok;
        if (ready) break;
      } catch { /* waiting for startup */ }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(ready, "server started");

    assert.equal((await fetch(`${base}/api/strategies`)).status, 401);
    assert.equal((await fetch(`${base}/api/key`, { method: "POST" })).status, 401, "key replacement needs a login session");
    assert.equal((await fetch(`${base}/`)).status, 200, "the page itself needs no session (it shows the login form)");
    for (const [path, type] of [["/manifest.webmanifest", "application/manifest+json"], ["/sw.js", "text/javascript"], ["/icons/icon-192.png", "image/png"], ["/icons/icon-512.png", "image/png"], ["/icons/icon-maskable-512.png", "image/png"], ["/icons/apple-touch-icon.png", "image/png"]]) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 200, `${path} needs no session`);
      assert.ok(res.headers.get("content-type")?.startsWith(type!), `${path} content type`);
    }
    assert.equal((await fetch(`${base}/sw.js`)).headers.get("cache-control"), "no-cache", "worker revalidates");
    assert.equal((await request("/api/login", "POST", { password: "wrong" })).status, 401);
    assert.equal((await request("/api/login", "POST", { password })).status, 429, "wrong password throttles the IP");
    await new Promise((resolve) => setTimeout(resolve, 450));
    let response = await request("/api/login", "POST", { password });
    assert.equal(response.status, 200, "before enrolment the password alone logs in");
    const sessionCookie = response.headers.get("set-cookie") ?? "";
    assert.match(sessionCookie, /dca_session=[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=2592000/);
    session = sessionCookie.split(";")[0]!;

    response = await request("/api/balance");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { available: false }, "no RPC config -> unavailable, not an error");

    response = await request("/api/strategies");
    assert.equal(response.status, 200);
    const listing = await response.json() as { dailyTotal: string; strategies: { id: number; status: string }[] };
    assert.equal(listing.dailyTotal, "900.000000");
    assert.equal(listing.strategies.find((s) => s.id === 2)?.status, "completed");

    assert.equal((await request("/api/strategies/2", "PATCH", { endDate: null })).status, 409);
    assert.equal((await request("/api/strategies/2", "PATCH", undefined, { "Content-Type": "application/json" })).status, 400);
    response = await request("/api/totp/setup", "POST", {});
    const { secret } = await response.json() as { secret: string };
    assert.equal(response.status, 200);
    const key = base32Decode(secret);
    // each accepted code burns its step (replay guard): use now-1, now, now+1 in order
    response = await request("/api/totp/confirm", "POST", { totp: totpAt(key, stepAt(Date.now()) - 1) });
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    assert.equal((await request("/api/key", "POST", { privateKey: replacementKey })).status, 403, "key replacement needs TOTP");
    response = await fetch(`${base}/api/key`, { method: "POST", headers: { Cookie: session, "Content-Type": "application/json" }, body: JSON.stringify({ privateKey: replacementKey }) });
    assert.equal(response.status, 400, "key replacement needs the CSRF marker");
    response = await request("/api/key", "POST", { privateKey: "0x1234" }, { Cookie: cookie });
    assert.equal(response.status, 400);
    assert.ok(!(await response.text()).includes("0x1234"), "validation never echoes the submitted key");

    const runDb = openDb(dbFile);
    const inFlightId = insertManualRun(runDb, parsePrivateKey(initialKey).address, new Date().toISOString().slice(0, 10), new Date().toISOString(), 1);
    runDb.close();
    response = await request("/api/key", "POST", { privateKey: replacementKey }, { Cookie: cookie });
    assert.equal(response.status, 409, "key replacement refuses a purchase in progress");
    assert.equal((await (await request("/api/settings")).json() as { walletAddress: string }).walletAddress, parsePrivateKey(initialKey).address);

    const settledDb = openDb(dbFile);
    updateManualRun(settledDb, inFlightId, { status: "FAILED" });
    settledDb.close();
    response = await request("/api/key", "POST", { privateKey: replacementKey }, { Cookie: cookie });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { walletAddress: parsePrivateKey(replacementKey).address }, "response contains only the new address");
    const verifyDb = openDb(dbFile);
    assert.ok(!getSecret(verifyDb, "private_key")?.includes(replacementKey.slice(2)), "the database stores ciphertext");
    verifyDb.close();
    response = await request("/api/settings");
    assert.equal((await response.json() as { walletAddress: string }).walletAddress, parsePrivateKey(replacementKey).address);
    assert.equal((await request("/api/buy", "POST", { strategyId: 1 })).status, 403, "manual buy needs TOTP");
    response = await request("/api/settings");
    const settingsState = await response.json() as { settings: unknown; caps: { maxSlippagePct: { max: number } }; setupIssues: string[]; walletAddress: string | null };
    assert.equal(settingsState.settings, null);
    assert.equal(settingsState.walletAddress, parsePrivateKey(replacementKey).address);
    assert.equal(settingsState.caps.maxSlippagePct.max, 2);
    assert.ok(settingsState.setupIssues.includes("settings not configured"));
    assert.equal((await request("/api/settings", "POST", { runTime: "09:15", maxSlippagePct: "0.5", maxPriceImpactPct: 1, maxOracleDeviationPct: 2, approvalDays: 30, minPolBalance: 0.5 })).status, 403, "saving settings needs TOTP");
    response = await request("/api/settings", "POST", { ...{ runTime: "09:15", maxSlippagePct: "0.5", maxPriceImpactPct: 1, maxOracleDeviationPct: 2, approvalDays: 30, minPolBalance: 0.5 }, maxSlippagePct: 10 }, { Cookie: cookie });
    assert.equal(response.status, 400, "a cap bypassing the frontend is refused");
    assert.match((await response.json() as { error: string }).error, /maxSlippagePct/);
    response = await request("/api/settings", "POST", { runTime: "09:15", maxSlippagePct: "0.5", maxPriceImpactPct: 1, maxOracleDeviationPct: 2, approvalDays: 30, minPolBalance: 0.5 }, { Cookie: cookie });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { settings: { maxSlippagePct: number } }).settings.maxSlippagePct, 0.5);
    assert.ok(!((await (await request("/api/settings")).json()) as { setupIssues: string[] }).setupIssues.includes("settings not configured"));
    assert.equal((await request("/api/settings").then((r) => r.json()) as { reportMode: string }).reportMode, "all", "reports start as all");
    assert.equal((await request("/api/report", "POST", { mode: "sometimes" })).status, 400, "unknown mode refused");
    assert.equal((await request("/api/report", "POST", { mode: "errors" })).status, 200, "report mode needs no TOTP");
    assert.equal((await request("/api/settings").then((r) => r.json()) as { reportMode: string }).reportMode, "errors", "choice stored");
    assert.equal((await request("/api/report", "POST", { alertDays: 31 })).status, 400, "alert days capped at 30");
    assert.equal((await request("/api/report", "POST", { alertDays: 1.5 })).status, 400, "whole days only");
    assert.equal((await request("/api/report", "POST", { alertDays: 4 })).status, 200, "alert days need no TOTP");
    const stored = await request("/api/settings").then((r) => r.json()) as { reportMode: string; alertDays: number };
    assert.deepEqual([stored.reportMode, stored.alertDays], ["errors", 4], "days stored, mode kept");
    assert.equal((await request("/api/pause", "POST", {})).status, 200, "pause needs no TOTP");
    response = await request("/api/resume", "POST", {});
    assert.equal(response.status, 403, "resume needs TOTP");
    assert.equal((await response.json() as { totpRequired: boolean }).totpRequired, true);
    assert.equal((await request("/api/resume", "POST", {}, { Cookie: cookie })).status, 200);

    const loginAgain = (body: object) => fetch(`${base}/api/login`, { method: "POST", headers: { "Content-Type": "application/json", "X-Dca-App": "1" }, body: JSON.stringify(body) });
    response = await loginAgain({ password });
    assert.equal(response.status, 403, "once enrolled, login needs the code too");
    assert.equal((await response.json() as { totpRequired: boolean }).totpRequired, true);
    response = await loginAgain({ password, totp: totpAt(key, stepAt(Date.now())) });
    assert.equal(response.status, 200);
    const cookies = response.headers.getSetCookie();
    assert.ok(cookies.some((c) => c.startsWith("dca_elevated=")), "login with a code opens the elevation window too");
    const second = cookies.find((c) => c.startsWith("dca_session="))!.split(";")[0]!;
    response = await fetch(`${base}/api/auth`, { headers: { Cookie: cookies.map((c) => c.split(";")[0]).join("; ") } });
    assert.equal(response.headers.get("cache-control"), "no-store");
    const elevatedState = await response.json() as { elevatedUntil: string | null; serverNow: string };
    assert.ok(elevatedState.elevatedUntil, "auth status reflects the active elevation cookie");
    assert.ok(Date.parse(elevatedState.elevatedUntil) > Date.parse(elevatedState.serverNow), "server time lets the UI show remaining elevation despite client clock skew");
    response = await fetch(`${base}/api/auth`, { headers: { Cookie: second } });
    assert.equal((await response.json() as { elevatedUntil: string | null }).elevatedUntil, null, "auth status reflects a missing elevation cookie");
    response = await fetch(`${base}/api/logout`, { method: "POST", headers: { Cookie: second, "Content-Type": "application/json", "X-Dca-App": "1" }, body: "{}" });
    assert.equal(response.status, 200);
    assert.equal((await fetch(`${base}/api/auth`, { headers: { Cookie: second } })).status, 401, "logout revokes this device");
    assert.equal((await request("/api/auth")).status, 200, "...and only this device");
    assert.equal((await request("/api/strategies/2", "PATCH", { endDate: null })).status, 403);
    assert.equal((await request("/api/strategies", "POST", { amount: "50" })).status, 403);
    assert.equal((await request("/api/strategies", "POST", { amount: "200" }, { Cookie: cookie })).status, 409);

    response = await request("/api/strategies/2", "PATCH", { endDate: null }, { Cookie: cookie });
    assert.equal(response.status, 409);
    assert.match((await response.json() as { error: string }).error, /per-run cap/);
    response = await request("/api/strategies/2", "PATCH", { status: "paused" });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { status: string }).status, "paused");
    response = await request("/api/history?strategy=2");
    assert.equal(response.status, 200);
    assert.ok(Array.isArray((await response.json() as { runs: unknown[] }).runs));
    assert.equal((await request("/api/history?strategy=bad")).status, 400);
    assert.equal((await request("/api/buy", "POST", { strategyId: 999 }, { Cookie: cookie })).status, 400);
    response = await request("/api/buy", "POST", { amount: "1", strategyId: 1 }, { Cookie: cookie });
    assert.equal(response.status, 400, "a client-chosen amount is refused (F8)");
    assert.match((await response.json() as { error: string }).error, /configured amount/);
    assert.equal((await request("/api/strategies/2", "PATCH", { status: "completed" })).status, 403);
    assert.equal((await request("/api/strategies/2", "PATCH", { status: "completed" }, { Cookie: cookie })).status, 200);
    assert.equal((await request("/api/strategies/2", "DELETE", {}, { Cookie: cookie })).status, 200);
    for (let i = 0; i < 5; i++) {
      assert.equal((await request("/api/unlock", "POST", { totp: "invalid" }, { "X-Forwarded-For": `192.0.2.${i + 1}` })).status, 403);
    }
    assert.equal((await request("/api/strategies", "POST", { amount: "1" })).status, 429);
    assert.equal((await request("/api/logout-all", "POST", {})).status, 200);
    assert.equal((await request("/api/auth")).status, 401, "logout everywhere revokes every session");
  } finally {
    app.kill();
    if (app.exitCode === null) await new Promise((resolve) => app.once("close", resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server refuses to boot when the stored private key cannot be decrypted", () => {
  const dir = mkdtempSync(join(tmpdir(), "dca-key-boot-test-"));
  const dbFile = join(dir, "test.db");
  const key = `0x${"3".repeat(64)}`;
  try {
    const db = openDb(dbFile);
    storePrivateKey(db, Buffer.alloc(32, 3), parsePrivateKey(key).key);
    db.close();
    const app = spawnSync(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "", APP_PASSWORD: "test-password", APP_PORT: "39123", DB_FILE: dbFile, MASTER_KEY: Buffer.alloc(32, 4).toString("base64") },
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.notEqual(app.status, 0);
    assert.match(app.stderr, /cannot decrypt secret "private_key"/);
    assert.ok(!app.stderr.includes(key), "startup errors do not disclose the key");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
