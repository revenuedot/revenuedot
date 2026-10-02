/**
 * Two-factor authentication with an authenticator app (prd/account-settings/PRD.md §3): TOTP, RFC 6238 over HOTP
 * (RFC 4226), HMAC-SHA1, 30-second steps, 6 digits, which every authenticator app reads from an otpauth:// URI.
 * WebCrypto only, so it runs on Workers and Node alike. Recovery codes: 10 random codes of 50 bits, shown once,
 * stored as SHA-256.
 */

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Steps of clock drift accepted either way. */
export const TOTP_WINDOW = 1;
export const RECOVERY_CODE_COUNT = 10;

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32, upper case, no padding (the form authenticator apps expect). */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** Reads base32 with or without padding, spaces and lower case. Throws on other characters. */
export function base32Decode(s: string): Uint8Array {
  const clean = s.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error("Not base32.");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}

export type HmacAlg = "SHA-1" | "SHA-256" | "SHA-512";

/** HOTP (RFC 4226): the `digits`-digit code for `counter`. */
export async function hotp(secret: Uint8Array, counter: number, digits = TOTP_DIGITS, alg: HmacAlg = "SHA-1"): Promise<string> {
  const key = await crypto.subtle.importKey("raw", secret as Uint8Array<ArrayBuffer>, { name: "HMAC", hash: alg }, false, ["sign"]);
  const msg = new Uint8Array(8);
  // 8-byte big-endian counter; JavaScript numbers are exact up to 2^53, far beyond any time step.
  let c = counter;
  for (let i = 7; i >= 0; i--) { msg[i] = c % 256; c = Math.floor(c / 256); }
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const off = mac[mac.length - 1]! & 0xf;
  const bin = ((mac[off]! & 0x7f) << 24) | (mac[off + 1]! << 16) | (mac[off + 2]! << 8) | mac[off + 3]!;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export const totpStep = (timeMs: number, step = TOTP_STEP_SECONDS) => Math.floor(timeMs / 1000 / step);

/** TOTP (RFC 6238) at a time. */
export const totp = (secret: Uint8Array, timeMs: number, o: { digits?: number; alg?: HmacAlg; step?: number } = {}) =>
  hotp(secret, totpStep(timeMs, o.step), o.digits ?? TOTP_DIGITS, o.alg ?? "SHA-1");

/** Constant-time comparison of two short strings. */
function same(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/**
 * Checks a 6-digit code at `nowMs` with ±TOTP_WINDOW steps. Returns the matching time step, or null. A step at or
 * before `lastStep` (already used) never matches, so a code cannot be replayed.
 */
export async function verifyTotp(secretB32: string, code: string, nowMs: number, lastStep: number | null = null): Promise<number | null> {
  const c = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(c)) return null;
  let secret: Uint8Array;
  try { secret = base32Decode(secretB32); } catch { return null; }
  const now = totpStep(nowMs);
  let found: number | null = null;
  // Every candidate is computed, so the time taken does not say which step matched.
  for (let s = now - TOTP_WINDOW; s <= now + TOTP_WINDOW; s++) {
    const ok = same(await hotp(secret, s), c);
    if (ok && (lastStep === null || s > lastStep) && found === null) found = s;
  }
  return found;
}

/** A new secret: 20 random bytes (160 bits, RFC 4226's recommended length) in base32. */
export const newTotpSecret = () => base32Encode(crypto.getRandomValues(new Uint8Array(20)));

/** The otpauth:// URI authenticator apps scan (Key Uri Format). */
export function otpauthUrl(secretB32: string, account: string, issuer = "RevenueDot"): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
}

const RC_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no 0/o, 1/l/i: easy to read back from paper
/** 10 one-time recovery codes, `xxxxx-xxxxx` (about 49.5 bits each). */
export function newRecoveryCodes(n = RECOVERY_CODE_COUNT): string[] {
  const codes: string[] = [];
  while (codes.length < n) {
    const r = crypto.getRandomValues(new Uint8Array(10));
    const s = Array.from(r, (b) => RC_ALPHABET[b % RC_ALPHABET.length]).join("");
    const code = `${s.slice(0, 5)}-${s.slice(5)}`;
    if (!codes.includes(code)) codes.push(code);
  }
  return codes;
}

/** What is hashed: lower case without spaces or dashes, so "ABCDE FGHIJ" and "abcde-fghij" match. */
export const normalizeRecoveryCode = (s: string) => s.toLowerCase().replace(/[\s-]+/g, "");
export const looksLikeRecoveryCode = (s: string) => /^[a-z0-9]{10}$/.test(normalizeRecoveryCode(s));
