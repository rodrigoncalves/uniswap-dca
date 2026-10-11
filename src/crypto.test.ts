import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { encryptSecret, decryptSecret, SecretDecryptError } from "./crypto.js";

const KEY = randomBytes(32);

test("encryptSecret/decryptSecret: round-trip returns the plaintext", () => {
  const blob = encryptSecret(KEY, "totp_secret", "JBSWY3DPEHPK3PXP");
  assert.equal(decryptSecret(KEY, "totp_secret", blob), "JBSWY3DPEHPK3PXP");
});

test("encryptSecret: same plaintext twice gives different blobs (random IV)", () => {
  assert.notEqual(encryptSecret(KEY, "n", "same"), encryptSecret(KEY, "n", "same"));
});

test("encryptSecret: blob never contains the plaintext", () => {
  const blob = encryptSecret(KEY, "n", "0x" + "ab".repeat(32));
  assert.ok(!Buffer.from(blob, "base64").toString("latin1").includes("abab"));
});

test("decryptSecret: wrong master key is refused", () => {
  const blob = encryptSecret(KEY, "n", "secret");
  assert.throws(() => decryptSecret(randomBytes(32), "n", blob), SecretDecryptError);
});

test("decryptSecret: a flipped ciphertext byte is refused (GCM tag)", () => {
  const raw = Buffer.from(encryptSecret(KEY, "n", "secret"), "base64");
  raw[raw.length - 1]! ^= 0x01;
  assert.throws(() => decryptSecret(KEY, "n", raw.toString("base64")), SecretDecryptError);
});

test("decryptSecret: a blob stored under another name is refused (AAD)", () => {
  const blob = encryptSecret(KEY, "totp_secret", "secret");
  assert.throws(() => decryptSecret(KEY, "private_key", blob), SecretDecryptError);
});

test("decryptSecret: truncated or empty blob is refused, not a raw crypto error", () => {
  assert.throws(() => decryptSecret(KEY, "n", ""), SecretDecryptError);
  assert.throws(() => decryptSecret(KEY, "n", Buffer.alloc(20).toString("base64")), SecretDecryptError);
});

test("SecretDecryptError message names the secret and MASTER_KEY, never the key bytes", () => {
  try {
    decryptSecret(randomBytes(32), "totp_secret", encryptSecret(KEY, "totp_secret", "s"));
    assert.fail("should throw");
  } catch (err) {
    assert.ok(err instanceof SecretDecryptError);
    assert.match(err.message, /totp_secret/);
    assert.match(err.message, /MASTER_KEY/);
    assert.ok(!err.message.includes(KEY.toString("base64")));
  }
});
