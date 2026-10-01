/**
 * Google service-account sign-in with WebCrypto only (Node and Cloudflare Workers): an RS256 JWT assertion exchanged for
 * an OAuth access token (https://developers.google.com/identity/protocols/oauth2/service-account#httprest).
 * Used by the BigQuery integration and Google Cloud Storage exports. Tokens are cached per private key and scope until a
 * minute before they expire, so a key pasted into one project can never pick up a token minted for another.
 * The key file's `token_uri` is ignored: the assertion always goes to Google's token endpoint, never to a URL a
 * customer could point at the server's own network.
 */

export interface ServiceAccountKey { client_email: string; private_key: string; private_key_id?: string; token_uri?: string; project_id?: string }

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export class GoogleAuthError extends Error {
  constructor(message: string, public transient = false) { super(message); }
}

export function parseServiceAccount(raw: string | undefined | null): ServiceAccountKey {
  if (!raw) throw new GoogleAuthError("No service account key is saved.");
  let j: Partial<ServiceAccountKey>;
  try { j = JSON.parse(raw); } catch { throw new GoogleAuthError("The service account key is not valid JSON."); }
  if (typeof j.client_email !== "string" || typeof j.private_key !== "string") throw new GoogleAuthError("The service account key must contain client_email and private_key.");
  return j as ServiceAccountKey;
}

const b64url = (b: Uint8Array | string) => {
  const bytes = typeof b === "string" ? new TextEncoder().encode(b) : b;
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem.replace(/\\n/g, "\n").replace(/-----(BEGIN|END) [A-Z ]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const keys = new Map<string, Promise<CryptoKey>>();
const tokens = new Map<string, { token: string; expiresAt: number }>();

function importKey(pem: string): Promise<CryptoKey> {
  let k = keys.get(pem);
  if (!k) {
    k = crypto.subtle.importKey("pkcs8", pemToDer(pem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"])
      .catch(() => { keys.delete(pem); throw new GoogleAuthError("The service account private_key is not a valid PKCS#8 RSA key."); });
    keys.set(pem, k);
  }
  return k;
}

/** The signed JWT assertion for the token request. */
export async function serviceAccountAssertion(sa: ServiceAccountKey, scope: string, nowMs: number): Promise<string> {
  const iat = Math.floor(nowMs / 1000);
  const header = { alg: "RS256", typ: "JWT", ...(sa.private_key_id ? { kid: sa.private_key_id } : {}) };
  const claims = { iss: sa.client_email, scope, aud: GOOGLE_TOKEN_URL, iat, exp: iat + 3600 };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await importKey(sa.private_key), new TextEncoder().encode(input)));
  return `${input}.${b64url(sig)}`;
}

async function keyFingerprint(pem: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pem));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function googleAccessToken(sa: ServiceAccountKey, scope: string, fetchImpl: typeof fetch, nowMs = Date.now()): Promise<string> {
  const cacheKey = `${sa.client_email}|${await keyFingerprint(sa.private_key)}|${scope}`;
  const hit = tokens.get(cacheKey);
  if (hit && hit.expiresAt > nowMs + 60_000) return hit.token;
  const assertion = await serviceAccountAssertion(sa, scope, nowMs);
  let res: Response;
  try {
    res = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
    });
  } catch (e) {
    throw new GoogleAuthError(`Google's token endpoint did not answer: ${e instanceof Error ? e.message : String(e)}`, true);
  }
  const body = await res.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !body.access_token) {
    throw new GoogleAuthError(`Google rejected the service account (${body.error ?? res.status}${body.error_description ? `: ${body.error_description}` : ""}).`, res.status >= 500 || res.status === 429);
  }
  tokens.set(cacheKey, { token: body.access_token, expiresAt: nowMs + (body.expires_in ?? 3600) * 1000 });
  return body.access_token;
}

/** Tests: forget cached tokens. */
export const clearGoogleTokens = () => tokens.clear();
