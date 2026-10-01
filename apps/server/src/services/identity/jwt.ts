/**
 * JSON Web Tokens with WebCrypto, for Auth (prd/auth): decoding, verifying an identity provider's signature with a JWK, and
 * signing RevenueDot's own tokens with Ed25519. Runs on Node 22+ and Workers.
 */

export const b64url = (bytes: Uint8Array) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
export const b64urlJson = (v: unknown) => b64url(new TextEncoder().encode(JSON.stringify(v)));
export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("not base64url");
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(pad.padEnd(Math.ceil(pad.length / 4) * 4, "="));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export interface DecodedJwt { header: Record<string, unknown>; payload: Record<string, unknown>; signingInput: Uint8Array<ArrayBuffer>; signature: Uint8Array<ArrayBuffer> }

/** Splits and parses a compact JWS. Throws on anything that is not three base64url parts with JSON objects. */
export function decodeJwt(token: string): DecodedJwt {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("not a JWT");
  const json = (s: string) => {
    const v = JSON.parse(new TextDecoder().decode(b64urlDecode(s)));
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not a JSON object");
    return v as Record<string, unknown>;
  };
  return { header: json(parts[0]!), payload: json(parts[1]!), signingInput: new TextEncoder().encode(`${parts[0]}.${parts[1]}`), signature: b64urlDecode(parts[2]!) };
}

/** Signature algorithms accepted from identity providers. Never `none` and never HMAC (a shared secret is not a public key). */
export const ALGS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "EdDSA"] as const;
export type Alg = (typeof ALGS)[number];

type Params = { key: RsaHashedImportParams | EcKeyImportParams | { name: "Ed25519" }; verify: AlgorithmIdentifier | RsaPssParams | EcdsaParams; kty: string; crv?: string };
function params(alg: Alg): Params {
  const bits = alg.slice(2);
  const hash = `SHA-${bits}`;
  if (alg.startsWith("RS")) return { kty: "RSA", key: { name: "RSASSA-PKCS1-v1_5", hash }, verify: { name: "RSASSA-PKCS1-v1_5" } };
  if (alg.startsWith("PS")) return { kty: "RSA", key: { name: "RSA-PSS", hash }, verify: { name: "RSA-PSS", saltLength: Number(bits) / 8 } };
  if (alg === "ES256") return { kty: "EC", crv: "P-256", key: { name: "ECDSA", namedCurve: "P-256" }, verify: { name: "ECDSA", hash: "SHA-256" } };
  if (alg === "ES384") return { kty: "EC", crv: "P-384", key: { name: "ECDSA", namedCurve: "P-384" }, verify: { name: "ECDSA", hash: "SHA-384" } };
  return { kty: "OKP", crv: "Ed25519", key: { name: "Ed25519" }, verify: { name: "Ed25519" } };
}

export interface Jwk { kty?: string; kid?: string; alg?: string; use?: string; crv?: string; n?: string; e?: string; x?: string; y?: string }

/** Whether a JWK can verify `alg` (key type, curve, and its own `alg` and `use` when it states them). */
export function jwkFits(jwk: Jwk, alg: Alg): boolean {
  const p = params(alg);
  if (jwk.kty !== p.kty) return false;
  if (p.crv && jwk.crv !== p.crv) return false;
  if (jwk.alg && jwk.alg !== alg) return false;
  return !jwk.use || jwk.use === "sig";
}

/** Imports only the public members, so a JWK's `key_ops` or `ext` cannot make the import fail. */
export function importJwk(jwk: Jwk, alg: Alg): Promise<CryptoKey> {
  const p = params(alg);
  const pub: JsonWebKey = jwk.kty === "RSA" ? { kty: "RSA", n: jwk.n, e: jwk.e } : jwk.kty === "EC" ? { kty: "EC", crv: jwk.crv, x: jwk.x, y: jwk.y } : { kty: "OKP", crv: jwk.crv, x: jwk.x };
  return crypto.subtle.importKey("jwk", pub, p.key, false, ["verify"]);
}

export async function verifySignature(d: DecodedJwt, alg: Alg, key: CryptoKey): Promise<boolean> {
  try { return await crypto.subtle.verify(params(alg).verify, key, d.signature, d.signingInput); } catch { return false; }
}

/** Signs a compact JWS with an Ed25519 key. */
export async function signEdDsa(header: Record<string, unknown>, payload: Record<string, unknown>, key: CryptoKey): Promise<string> {
  const input = `${b64urlJson({ alg: "EdDSA", ...header })}.${b64urlJson(payload)}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, new TextEncoder().encode(input)));
  return `${input}.${b64url(sig)}`;
}
