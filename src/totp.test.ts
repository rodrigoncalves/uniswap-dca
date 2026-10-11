// src/totp.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { base32Encode, base32Decode, stepAt, totpAt, matchTotp, otpauthUri } from "./totp.js";

// RFC 6238 appendix B, SHA-1 seed = ASCII "12345678901234567890". The RFC
// prints 8 digits; a 6-digit TOTP is the same value mod 10^6 (last 6).
const RFC_SECRET = Buffer.from("12345678901234567890", "ascii");
const RFC_VECTORS: [number, string][] = [
  [59, "287082"],
  [1111111109, "081804"],
  [1111111111, "050471"],
  [1234567890, "005924"],
  [2000000000, "279037"],
  [20000000000, "353130"],
];

test("totpAt: RFC 6238 SHA-1 test vectors (6-digit truncation)", () => {
  for (const [seconds, code] of RFC_VECTORS) {
    assert.equal(totpAt(RFC_SECRET, stepAt(seconds * 1000)), code, `t=${seconds}`);
  }
});

test("base32Encode/base32Decode: RFC 4648 vectors, no padding", () => {
  const vectors: [string, string][] = [
    ["", ""], ["f", "MY"], ["fo", "MZXQ"], ["foo", "MZXW6"],
    ["foob", "MZXW6YQ"], ["fooba", "MZXW6YTB"], ["foobar", "MZXW6YTBOI"],
  ];
  for (const [plain, encoded] of vectors) {
    assert.equal(base32Encode(Buffer.from(plain)), encoded);
    assert.equal(base32Decode(encoded).toString(), plain);
  }
});

test("base32Decode: accepts lowercase, spaces and padding (how people paste secrets)", () => {
  assert.equal(base32Decode("mzxw 6ytb oi======").toString(), "foobar");
});

test("base32Decode: refuses characters outside the alphabet", () => {
  assert.throws(() => base32Decode("MZXW1"), /base32/);
});

test("base32: 20 random bytes survive a round-trip", () => {
  const bytes = Buffer.from("0123456789abcdefghij");
  assert.deepEqual(base32Decode(base32Encode(bytes)), bytes);
});

test("matchTotp: accepts the current step and one step either side (clock drift)", () => {
  const now = 1111111111 * 1000;
  const step = stepAt(now);
  assert.equal(matchTotp(RFC_SECRET, totpAt(RFC_SECRET, step), now), step);
  assert.equal(matchTotp(RFC_SECRET, totpAt(RFC_SECRET, step - 1), now), step - 1);
  assert.equal(matchTotp(RFC_SECRET, totpAt(RFC_SECRET, step + 1), now), step + 1);
});

test("matchTotp: refuses a code two steps away", () => {
  const now = 1111111111 * 1000;
  assert.equal(matchTotp(RFC_SECRET, totpAt(RFC_SECRET, stepAt(now) - 2), now), null);
  assert.equal(matchTotp(RFC_SECRET, totpAt(RFC_SECRET, stepAt(now) + 2), now), null);
});

test("matchTotp: refuses anything that isn't exactly six digits as a string", () => {
  const now = 1111111111 * 1000;
  const good = totpAt(RFC_SECRET, stepAt(now));
  for (const bad of [Number(good), `${good.slice(0, 3)} ${good.slice(3)}`, good.slice(1), `${good}0`, "", null, undefined, {}]) {
    assert.equal(matchTotp(RFC_SECRET, bad, now), null, `input ${JSON.stringify(bad)}`);
  }
});

test("otpauthUri: standard key URI that Authy and Google Authenticator scan", () => {
  assert.equal(
    otpauthUri("JBSWY3DPEHPK3PXP"),
    "otpauth://totp/DCA%20bot?secret=JBSWY3DPEHPK3PXP&issuer=DCA%20bot&algorithm=SHA1&digits=6&period=30"
  );
});
