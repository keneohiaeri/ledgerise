import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

import { isRecord } from './http.js';

// AES-256-GCM application-layer credential encryption.
// Requires LEDGERISE_CREDENTIALS_KEY = 32 bytes (64 hex chars or 44 base64url chars).
// Absent key = plaintext passthrough (development only).
const credentialsKey = ((): Buffer | null => {
  const raw = process.env.LEDGERISE_CREDENTIALS_KEY;
  if (!raw) return null;
  const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error('LEDGERISE_CREDENTIALS_KEY must be exactly 32 bytes (64 hex chars or 44 base64url chars)');
  return buf;
})();

export function encryptConfig(config: unknown): unknown {
  if (!credentialsKey) return config;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', credentialsKey, iv);
  const plaintext = Buffer.from(JSON.stringify(config), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const encoded = Buffer.concat([iv, ciphertext, authTag]).toString('base64url');
  return { _enc: 1, d: encoded };
}

export function decryptConfig(config: unknown): unknown {
  if (!credentialsKey || !isRecord(config) || config._enc !== 1) return config;
  const encoded = typeof config.d === 'string' ? config.d : null;
  if (!encoded) return config;
  try {
    const buf = Buffer.from(encoded, 'base64url');
    const iv = buf.subarray(0, 12);
    const authTag = buf.subarray(buf.length - 16);
    const ciphertext = buf.subarray(12, buf.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', credentialsKey, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8')) as unknown;
  } catch {
    process.stdout.write(JSON.stringify({ timestamp: new Date().toISOString(), level: 'error', event: 'credentials_decrypt_failed' }) + '\n');
    return config;
  }
}

export function createApiKeySecret(): string {
  return `lr_live_sk_${randomBytes(24).toString('base64url')}`;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('base64url');
  const key = scryptSync(password, salt, 64).toString('base64url');
  return `scrypt:${salt}:${key}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const [scheme, salt, expectedKey] = storedHash.split(':');
  if (scheme !== 'scrypt' || !salt || !expectedKey) return false;
  const actual = Buffer.from(scryptSync(password, salt, 64).toString('base64url'));
  const expected = Buffer.from(expectedKey);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
