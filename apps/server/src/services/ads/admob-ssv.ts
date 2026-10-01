import { ADMOB_KEYS_URL, base64UrlDecode, derToP1363, type AdMobCallback } from "@revenuedot/core/ads";
import { guardedFetch } from "../outbound.js";

/**
 * AdMob server-side verification (https://developers.google.com/admob/android/ssv): checks the callback's ECDSA P-256
 * signature with Google's published verifier keys. The keys are fetched through the outbound guard (public https, no
 * redirects) and kept for 24 hours per isolate; an unknown key id fetches them again, at most once a minute, so a key
 * rotation is picked up without letting junk callbacks hammer Google. With no keys yet (a cold isolate while Google is
 * unreachable) the fetch is also tried at most once a minute; callbacks in between answer 503 and Google retries them.
 */

const TTL_MS = 24 * 60 * 60_000;
const REFETCH_MS = 60_000;

let cache: { keys: Map<string, CryptoKey>; fetchedAt: number; lastAttempt: number } = { keys: new Map(), fetchedAt: 0, lastAttempt: 0 };

/** Tests start from an empty cache. */
export const clearAdMobKeys = () => { cache = { keys: new Map(), fetchedAt: 0, lastAttempt: 0 }; };

export class KeysUnavailable extends Error {}

function b64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/\s+/g, ""));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/**
 * Fetches the keys. `lastAttempt` is set before the fetch, so callbacks arriving meanwhile answer 503 (Google retries)
 * instead of fetching too; a promise is not shared across requests, which Workers does not allow.
 */
async function loadKeys(fetchFn: typeof fetch, now: number) {
  cache.lastAttempt = now;
  let res: Response;
  try {
    res = await guardedFetch(fetchFn, ADMOB_KEYS_URL, { headers: { accept: "application/json" } });
  } catch (e) {
    throw new KeysUnavailable(`Google's verifier keys could not be loaded: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) throw new KeysUnavailable(`Google's verifier keys answered HTTP ${res.status}.`);
  const j = await res.json().catch(() => null) as { keys?: { keyId?: number | string; base64?: string; pem?: string }[] } | null;
  const keys = new Map<string, CryptoKey>();
  for (const k of (Array.isArray(j?.keys) ? j!.keys : []).slice(0, 50)) {
    if (k?.keyId === undefined || k.keyId === null) continue;
    try {
      const der = k.base64 ? b64(k.base64) : k.pem ? b64(k.pem.replace(/-----[^-]+-----/g, "")) : null;
      if (der) keys.set(String(k.keyId), await crypto.subtle.importKey("spki", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]));
    } catch { /* a key we cannot read is skipped */ }
  }
  if (!keys.size) throw new KeysUnavailable("Google's verifier keys response had no usable keys.");
  cache = { keys, fetchedAt: now, lastAttempt: now };
}

/** "ok", "bad_signature" or "unknown_key". Throws KeysUnavailable when Google's keys cannot be loaded (answer 5xx so Google retries). */
export async function verifyAdMobCallback(cb: AdMobCallback, fetchFn: typeof fetch, now: number): Promise<"ok" | "bad_signature" | "unknown_key"> {
  const mayFetch = () => now - cache.lastAttempt > REFETCH_MS || cache.lastAttempt === 0;
  if (!cache.keys.size) {
    // No keys yet: one attempt a minute, so junk callbacks during an outage do not each call Google.
    if (!mayFetch()) throw new KeysUnavailable("Google's verifier keys are not loaded yet.");
    await loadKeys(fetchFn, now);
  } else if (now - cache.fetchedAt > TTL_MS && mayFetch()) {
    // Stale keys still verify while Google's endpoint is down.
    try { await loadKeys(fetchFn, now); } catch (e) { console.warn(`AdMob SSV: keeping cached keys: ${e instanceof Error ? e.message : String(e)}`); }
  }
  let key = cache.keys.get(cb.keyId);
  if (!key && mayFetch()) {
    // A key id we have not seen: Google may have rotated its keys. A failed refetch keeps the cached keys and answers 503.
    await loadKeys(fetchFn, now);
    key = cache.keys.get(cb.keyId);
  }
  if (!key) return "unknown_key";
  let sig: Uint8Array<ArrayBuffer> | null;
  try { sig = derToP1363(base64UrlDecode(cb.signature)); } catch { sig = null; }
  if (!sig) return "bad_signature";
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, new TextEncoder().encode(cb.message));
  return ok ? "ok" : "bad_signature";
}
