import { test } from "node:test";
import assert from "node:assert/strict";
import { Elevations, TotpLockout, ELEVATION_TTL_MS, TOTP_MAX_FAILURES, TOTP_LOCKOUT_MS } from "./elevation.js";

test("Elevations: an opened token is valid until exactly ELEVATION_TTL_MS later, then gone", () => {
  const e = new Elevations();
  const { token, expiresAt } = e.open(1_000);
  assert.equal(expiresAt, 1_000 + ELEVATION_TTL_MS);
  assert.equal(e.expiresAt(token, 1_000 + ELEVATION_TTL_MS - 1), expiresAt);
  assert.equal(e.expiresAt(token, 1_000 + ELEVATION_TTL_MS), null);
  assert.equal(e.expiresAt(token, 1_000), null, "expired token is deleted, not revived");
});

test("Elevations: fixed expiry -- checking a token does not extend it", () => {
  const e = new Elevations();
  const { token, expiresAt } = e.open(0);
  e.expiresAt(token, ELEVATION_TTL_MS - 10);
  assert.equal(e.expiresAt(token, ELEVATION_TTL_MS - 5), expiresAt);
});

test("Elevations: unknown, undefined and closed tokens are not elevated", () => {
  const e = new Elevations();
  const { token } = e.open(0);
  assert.equal(e.expiresAt(undefined, 0), null);
  assert.equal(e.expiresAt("nope", 0), null);
  e.close(token);
  assert.equal(e.expiresAt(token, 0), null);
});

test("Elevations: tokens are random, url-safe and long", () => {
  const e = new Elevations();
  const a = e.open(0).token;
  const b = e.open(0).token;
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
});

test("TotpLockout: locks after TOTP_MAX_FAILURES consecutive failures, for TOTP_LOCKOUT_MS", () => {
  const l = new TotpLockout();
  for (let i = 0; i < TOTP_MAX_FAILURES - 1; i++) l.fail(100);
  assert.equal(l.lockedUntil(100), null);
  l.fail(100);
  assert.equal(l.lockedUntil(100), 100 + TOTP_LOCKOUT_MS);
  assert.equal(l.lockedUntil(100 + TOTP_LOCKOUT_MS), null);
});

test("TotpLockout: a success resets the count", () => {
  const l = new TotpLockout();
  for (let i = 0; i < TOTP_MAX_FAILURES - 1; i++) l.fail(0);
  l.succeed();
  l.fail(0);
  assert.equal(l.lockedUntil(0), null);
});

test("TotpLockout: after a lock expires, one more failure doesn't instantly re-lock", () => {
  const l = new TotpLockout();
  for (let i = 0; i < TOTP_MAX_FAILURES; i++) l.fail(0);
  l.fail(TOTP_LOCKOUT_MS + 1);
  assert.equal(l.lockedUntil(TOTP_LOCKOUT_MS + 1), null);
});

test("TotpLockout: while locked, fail() is a no-op (lock does not extend)", () => {
  const l = new TotpLockout();
  for (let i = 0; i < TOTP_MAX_FAILURES; i++) l.fail(0);
  // Locked until TOTP_LOCKOUT_MS
  l.fail(1000);
  assert.equal(l.lockedUntil(1000), TOTP_LOCKOUT_MS);
  l.fail(TOTP_LOCKOUT_MS - 1);
  assert.equal(l.lockedUntil(TOTP_LOCKOUT_MS - 1), TOTP_LOCKOUT_MS);
  assert.equal(l.lockedUntil(TOTP_LOCKOUT_MS), null);
});
