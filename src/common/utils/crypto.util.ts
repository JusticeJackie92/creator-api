import { createHash, createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'crypto';

/**
 * Cryptographic helpers.
 *
 *  - sha256(): one-way hash used for refresh / verification tokens so a DB
 *    leak never exposes usable tokens.
 *  - encrypt()/decrypt(): AES-256-GCM (authenticated encryption) for
 *    sensitive-at-rest fields like TOTP secrets. Key derived via scrypt.
 *  - generateOpaqueToken(): 256-bit CSPRNG token, URL-safe.
 *  - safeEqual(): constant-time comparison to prevent timing attacks.
 */

const key = () => scryptSync(process.env.ENCRYPTION_KEY as string, 'cp-static-salt-v1', 32);

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function generateOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.');
}

export function decrypt(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split('.');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
