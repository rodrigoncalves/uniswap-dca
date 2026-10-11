// Encryption at rest for the `secrets` table (F1): AES-256-GCM via
// node:crypto, no dependency. Blob = base64(iv[12] || tag[16] || ciphertext).
// The secret's name is the AAD, so a blob copied onto another name (e.g. a
// TOTP secret pasted over the private key) fails the tag check instead of
// decrypting. The master key comes from MASTER_KEY (config.ts loadMasterKey);
// it protects database files, exports and backups -- not a compromised
// server, which holds both. DECISIONS.md #19.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_BYTES = 12;
const TAG_BYTES = 16;

export class SecretDecryptError extends Error {
  constructor(name: string) {
    super(`cannot decrypt secret "${name}": wrong MASTER_KEY or tampered data`);
    this.name = "SecretDecryptError";
  }
}

export function encryptSecret(masterKey: Buffer, name: string, plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
  cipher.setAAD(Buffer.from(name, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}

export function decryptSecret(masterKey: Buffer, name: string, blob: string): string {
  const raw = Buffer.from(blob, "base64");
  if (raw.length <= IV_BYTES + TAG_BYTES) throw new SecretDecryptError(name);
  try {
    const decipher = createDecipheriv("aes-256-gcm", masterKey, raw.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(name, "utf8"));
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
  } catch {
    throw new SecretDecryptError(name);
  }
}
