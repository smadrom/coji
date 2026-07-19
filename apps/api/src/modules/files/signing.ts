/**
 * Signed file URLs for browser-loadable storage objects.
 *
 * The local-filesystem StorageProvider has no public HTTP URL, and a Bearer-
 * guarded route can't be used from an <img src>. So we mint short-lived signed
 * URLs (`/files?key&exp&sig`) — the HMAC signature (over `key:exp`, keyed by
 * BETTER_AUTH_SECRET) IS the capability, so no Authorization header is needed.
 * Works for any StorageProvider via getBytes(key).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../../env.ts';

const DEFAULT_TTL_SEC = 3600;

function sign(key: string, exp: number): string {
  return createHmac('sha256', env.betterAuthSecret).update(`${key}:${exp}`).digest('hex');
}

/** Build a signed, browser-loadable URL for a storage key. */
export function signFileUrl(key: string, ttlSec: number = DEFAULT_TTL_SEC): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const sig = sign(key, exp);
  return `/files?key=${encodeURIComponent(key)}&exp=${exp}&sig=${sig}`;
}

/** Verify a signed file URL's key/exp/sig (constant-time). */
export function verifyFileUrl(key: string, exp: number, sig: string): boolean {
  if (!key || !Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const expected = sign(key, exp);
  if (expected.length !== sig.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'));
  } catch {
    return false;
  }
}
