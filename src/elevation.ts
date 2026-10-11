// After one valid TOTP code the app stops asking for 15 minutes (spec F1,
// "Elevation window"). Tokens live in memory only: a restart ends every
// window, which is the safe direction. Fixed expiry, never extended by use.
//
// TotpLockout is GLOBAL, not per IP: six digits is a small space, and an
// attacker holding the password can spread guesses over many IPs. 5 wrong
// codes in a row from anywhere -> TOTP refused for 15 min. DECISIONS.md #19.
import { randomBytes } from "node:crypto";

export const ELEVATION_TTL_MS = 15 * 60 * 1000;
export const TOTP_MAX_FAILURES = 5;
export const TOTP_LOCKOUT_MS = 15 * 60 * 1000;

export class Elevations {
  private readonly tokens = new Map<string, number>();

  open(nowMs: number): { token: string; expiresAt: number } {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = nowMs + ELEVATION_TTL_MS;
    this.tokens.set(token, expiresAt);
    return { token, expiresAt };
  }

  expiresAt(token: string | undefined, nowMs: number): number | null {
    if (token === undefined) return null;
    const expiresAt = this.tokens.get(token);
    if (expiresAt === undefined) return null;
    if (nowMs >= expiresAt) {
      this.tokens.delete(token);
      return null;
    }
    return expiresAt;
  }

  close(token: string | undefined): void {
    if (token !== undefined) this.tokens.delete(token);
  }
}

export class TotpLockout {
  private failures = 0;
  private until = 0;

  lockedUntil(nowMs: number): number | null {
    return nowMs < this.until ? this.until : null;
  }

  fail(nowMs: number): void {
    if (this.until !== 0 && nowMs < this.until) return;
    if (this.until !== 0 && nowMs >= this.until) {
      this.failures = 0;
      this.until = 0;
    }
    this.failures += 1;
    if (this.failures >= TOTP_MAX_FAILURES) this.until = nowMs + TOTP_LOCKOUT_MS;
  }

  succeed(): void {
    this.failures = 0;
    this.until = 0;
  }
}
