import { fromBase64, toBase64 } from "./signing.js";

/**
 * Sealed secrets for integrations and data exports (API keys, tokens, service-account JSON): AES-256-GCM with WebCrypto,
 * so the same code runs on Node and Cloudflare Workers.
 *
 * The key comes from REVENUEDOT_ENCRYPTION_KEY (base64 of 32 random bytes). Without it, the key is derived with HKDF
 * from REVENUEDOT_SIGNING_KEY, so RevenueDot Cloud (which always has a signing key) encrypts with no extra setup.
 * A server with neither stores the secrets as plain JSON marked `plain:`; they are still never returned by the API.
 * Stored format: `v1:<key id>:<base64 iv>:<base64 ciphertext>` or `plain:<base64 json>`.
 */

export type SecretMap = Record<string, string>;

export interface SecretKey {
  id: string;
  key: CryptoKey;
  /**
   * Older keys that may still open stored secrets: with REVENUEDOT_ENCRYPTION_KEY set, the key derived from
   * REVENUEDOT_SIGNING_KEY, so a server that adds a dedicated key later keeps reading what it sealed before.
   */
  previous?: SecretKey[];
}

const cache = new Map<string, Promise<SecretKey | null>>();

const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", b as Uint8Array<ArrayBuffer>));
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

async function aesKey(raw: Uint8Array<ArrayBuffer>): Promise<SecretKey> {
  const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  return { id: hex(await sha256(raw)).slice(0, 8), key };
}

async function derivedFromSigningKey(signingKey: string): Promise<SecretKey> {
  const ikm = await crypto.subtle.importKey("raw", fromBase64(signingKey), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("revenuedot"), info: new TextEncoder().encode("integration secrets v1") }, ikm, 256);
  return aesKey(new Uint8Array(bits));
}

/** Resolves the sealing key: an explicit encryption key wins, else one derived from the signing key, else none. */
export function secretKeyFrom(encryptionKey?: string | null, signingKey?: string | null): Promise<SecretKey | null> {
  const enc = encryptionKey?.trim() || "", sign = signingKey?.trim() || "";
  const id = `${enc}|${sign}`;
  let p = cache.get(id);
  if (!p) {
    p = (async () => {
      if (enc) {
        const raw = fromBase64(enc);
        if (raw.length !== 32) throw new Error("REVENUEDOT_ENCRYPTION_KEY must be the base64 of 32 random bytes (openssl rand -base64 32).");
        const primary = await aesKey(raw);
        if (sign) primary.previous = [await derivedFromSigningKey(sign)];
        return primary;
      }
      return sign ? derivedFromSigningKey(sign) : null;
    })();
    // A bad key fails every call the same way; do not keep the rejected promise around.
    p.catch(() => cache.delete(id));
    cache.set(id, p);
  }
  return p;
}

/** The key the server runs with: the Deps values, else the process environment (Node). */
export const depsSecretKey = (d: { encryptionKey?: string; signingKey?: string }) => {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  return secretKeyFrom(d.encryptionKey ?? env.REVENUEDOT_ENCRYPTION_KEY, d.signingKey || env.REVENUEDOT_SIGNING_KEY);
};

export async function seal(secrets: SecretMap, key: SecretKey | null): Promise<string | null> {
  const clean = Object.fromEntries(Object.entries(secrets).filter(([, v]) => typeof v === "string" && v !== ""));
  if (!Object.keys(clean).length) return null;
  const json = new TextEncoder().encode(JSON.stringify(clean));
  if (!key) return `plain:${toBase64(json)}`;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key.key, json));
  return `v1:${key.id}:${toBase64(iv)}:${toBase64(ct)}`;
}

export class SecretsError extends Error {}

export async function unseal(stored: string | null | undefined, key: SecretKey | null): Promise<SecretMap> {
  if (!stored) return {};
  if (stored.startsWith("plain:")) return JSON.parse(new TextDecoder().decode(fromBase64(stored.slice(6))));
  const [v, id, iv, ct] = stored.split(":");
  if (v !== "v1" || !iv || !ct) throw new SecretsError("The stored credentials are in an unknown format. Enter them again.");
  if (!key) throw new SecretsError("The credentials are encrypted, but this server has no REVENUEDOT_ENCRYPTION_KEY or REVENUEDOT_SIGNING_KEY to decrypt them.");
  const match = [key, ...(key.previous ?? [])].find((k) => k.id === id);
  if (!match) throw new SecretsError("The credentials were encrypted with a different key (REVENUEDOT_ENCRYPTION_KEY or REVENUEDOT_SIGNING_KEY changed). Enter them again.");
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(iv) }, match.key, fromBase64(ct));
    return JSON.parse(new TextDecoder().decode(pt));
  } catch {
    throw new SecretsError("The stored credentials could not be decrypted. Enter them again.");
  }
}

/** What the dashboard shows for a saved secret: its last four characters (a service-account JSON shows its client_email). */
export function hintOf(name: string, value: string): string {
  if (value.trim().startsWith("{")) {
    try { const j = JSON.parse(value) as { client_email?: string }; if (j.client_email) return j.client_email; } catch { /* not JSON */ }
  }
  if (name.endsWith("url")) {
    try { const u = new URL(value); return `${u.host}/…${value.slice(-4)}`; } catch { /* not a URL */ }
  }
  return value.length <= 8 ? "••••" : `••••${value.slice(-4)}`;
}

/**
 * Merges a write into the stored secrets: a string sets the field, null removes it, a missing field keeps the saved one.
 * Returns the sealed text and the new hints.
 */
export async function mergeSecrets(stored: string | null, update: Record<string, string | null | undefined>, key: SecretKey | null) {
  const current = await unseal(stored, key).catch(() => ({} as SecretMap));
  for (const [k, v] of Object.entries(update)) {
    if (v === undefined) continue;
    if (v === null || v === "") delete current[k];
    else current[k] = v;
  }
  const hints = Object.fromEntries(Object.entries(current).map(([k, v]) => [k, hintOf(k, v)]));
  return { sealed: await seal(current, key), hints, values: current };
}
