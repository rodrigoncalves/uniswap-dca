// TOTP (RFC 6238) for the app's sensitive actions -- HMAC-SHA1, 6 digits,
// 30 s, the parameters Authy and Google Authenticator use by default.
// Base32 (RFC 4648) by hand: ~20 lines, not worth a dependency. Pure: the
// caller passes "now" (same discipline as validation.ts). Replay protection
// (a code used once is dead) lives in db.ts claimTotpStep, because it has
// to survive restarts. DECISIONS.md #19.
import { createHmac, timingSafeEqual } from "node:crypto";

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`invalid base32 character "${char}"`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function stepAt(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
}

export function totpAt(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", secret).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** TOTP_DIGITS;
  return code.toString().padStart(TOTP_DIGITS, "0");
}

/**
 * The step whose code matches (now-1, now, now+1 -- one step of clock drift
 * either way), or null. Only a string of exactly six digits is considered;
 * every candidate is compared in constant time.
 */
export function matchTotp(secret: Buffer, code: unknown, nowMs: number): number | null {
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) return null;
  const now = stepAt(nowMs);
  let match: number | null = null;
  for (const step of [now - 1, now, now + 1]) {
    if (timingSafeEqual(Buffer.from(totpAt(secret, step)), Buffer.from(code))) match = step;
  }
  return match;
}

export function otpauthUri(secretBase32: string): string {
  return `otpauth://totp/DCA%20bot?secret=${secretBase32}&issuer=DCA%20bot&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
}
