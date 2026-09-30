import type { Context, MiddlewareHandler } from "hono";

/**
 * Response signing that the RevenueCat SDKs verify ("Trusted Entitlements").
 *
 * The SDKs read the `X-Signature` response header: base64 of 180 bytes laid out as
 *   [0..32)    intermediate Ed25519 public key (raw)
 *   [32..36)   intermediate key expiration, little-endian uint32, days since 1970-01-01
 *   [36..100)  root key signature over (expiration ‖ intermediate public key)
 *   [100..116) random salt
 *   [116..180) intermediate key signature over the payload message
 * The payload message is salt ‖ API key ‖ nonce ‖ request path ‖ X-Post-Params-Hash ‖ X-Headers-Hash
 * ‖ X-RevenueCat-Request-Time ‖ X-RevenueCat-ETag ‖ response body.
 * Wire format from purchases-ios Sources/Security/Signing.swift and purchases-android SigningManager.kt (MIT).
 *
 * The root key is `REVENUEDOT_SIGNING_KEY` (base64 of a 32-byte Ed25519 seed). Apps pin its public key in the SDK.
 * Everything uses WebCrypto so it runs on Node 22 and Cloudflare Workers.
 */

export const SIGNATURE_HEADER = "X-Signature";
export const REQUEST_TIME_HEADER = "X-RevenueCat-Request-Time";
export const SIGNING_KEY_PATH = "/.well-known/revenuedot-signing-key";
export const SIGNATURE_SIZE = 180;

const DAY_MS = 86_400_000;
// PKCS#8 wrapper for a raw Ed25519 seed (RFC 8410): SEQUENCE { version 0, AlgorithmIdentifier id-Ed25519, OCTET STRING { OCTET STRING seed } }.
const PKCS8_ED25519_PREFIX = hex("302e020100300506032b657004220420");
const ED25519 = { name: "Ed25519" } as const;

function hex(s: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export const toBase64 = (u: Uint8Array) => {
  let s = "";
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s);
};

export function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  const clean = s.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const bin = atob(clean.padEnd(Math.ceil(clean.length / 4) * 4, "="));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const utf8 = (s: string) => new TextEncoder().encode(s);

/** Decodes and checks a base64 Ed25519 seed. Throws a message that says how to fix the setting. */
export function parseSeed(seedB64: string): Uint8Array<ArrayBuffer> {
  let seed: Uint8Array<ArrayBuffer> | null = null;
  try { seed = fromBase64(seedB64.trim()); } catch { seed = null; }
  if (!seed || seed.length !== 32) {
    throw new Error("REVENUEDOT_SIGNING_KEY must be the base64 of a 32-byte Ed25519 private key seed. Generate one with `pnpm tsx scripts/signing-keygen.ts`.");
  }
  return seed;
}

function importSeed(seed: Uint8Array, extractable: boolean): Promise<CryptoKey> {
  return crypto.subtle.importKey("pkcs8", concat([PKCS8_ED25519_PREFIX, seed]), ED25519, extractable, ["sign"]);
}

/** The raw 32-byte public key (base64) for a base64 seed. */
export async function publicKeyFromSeed(seedB64: string): Promise<string> {
  const jwk = await crypto.subtle.exportKey("jwk", await importSeed(parseSeed(seedB64), true));
  if (!jwk.x) throw new Error("Could not derive the Ed25519 public key.");
  return toBase64(fromBase64(jwk.x));
}

/** A fresh root key pair: `privateKey` is the base64 seed for REVENUEDOT_SIGNING_KEY, `publicKey` the raw public key to pin in apps. */
export async function generateSigningKeyPair(): Promise<{ privateKey: string; publicKey: string }> {
  const privateKey = toBase64(crypto.getRandomValues(new Uint8Array(32)));
  return { privateKey, publicKey: await publicKeyFromSeed(privateKey) };
}

/** Everything the SDK folds into the signed payload besides the salt. */
export interface SignatureParts {
  /** Bearer token from the request's Authorization header; empty when there is none. */
  apiKey: string;
  /** Raw nonce bytes (base64-decoded X-Nonce); empty when absent. */
  nonce: Uint8Array;
  /** Raw, still percent-encoded URL path without the query string. */
  path: string;
  postParamsHash: string;
  headersHash: string;
  requestTime: string;
  etag: string;
  body: Uint8Array;
}

/** salt ‖ apiKey ‖ nonce ‖ path ‖ X-Post-Params-Hash ‖ X-Headers-Hash ‖ request time ‖ etag ‖ body. */
export function signedMessage(salt: Uint8Array, p: SignatureParts): Uint8Array<ArrayBuffer> {
  return concat([salt, utf8(p.apiKey), p.nonce, utf8(p.path), utf8(p.postParamsHash), utf8(p.headersHash), utf8(p.requestTime), utf8(p.etag), p.body]);
}

interface Intermediate {
  privateKey: CryptoKey;
  /** public key ‖ expiration ‖ root signature: the first 100 bytes of every signature. */
  header: Uint8Array;
  expiresAtMs: number;
}

export interface SignerOptions {
  now?: () => Date;
  /** Days an intermediate key stays valid. Default 30. */
  intermediateLifetimeDays?: number;
  /** Mint a new intermediate key when fewer than this many days remain. Default 7. */
  renewWithinDays?: number;
}

/** Signs responses with an in-memory intermediate key that the root key certifies. */
export class ResponseSigner {
  private readonly seed: Uint8Array<ArrayBuffer>;
  private readonly now: () => Date;
  private readonly lifetimeDays: number;
  private readonly renewMs: number;
  private root: Promise<CryptoKey> | null = null;
  private current: Intermediate | null = null;
  private minting: Promise<Intermediate> | null = null;
  private pub: Promise<string> | null = null;

  constructor(seedB64: string, opts: SignerOptions = {}) {
    this.seed = parseSeed(seedB64);
    this.now = opts.now ?? (() => new Date());
    this.lifetimeDays = opts.intermediateLifetimeDays ?? 30;
    this.renewMs = (opts.renewWithinDays ?? 7) * DAY_MS;
  }

  /** Base64 raw root public key. */
  publicKey(): Promise<string> {
    return (this.pub ??= publicKeyFromSeed(toBase64(this.seed)));
  }

  private async mint(nowMs: number): Promise<Intermediate> {
    const root = await (this.root ??= importSeed(this.seed, false));
    const pair = await crypto.subtle.generateKey(ED25519, true, ["sign", "verify"]) as CryptoKeyPair;
    const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    const days = Math.floor(nowMs / DAY_MS) + this.lifetimeDays;
    const expiration = new Uint8Array(4);
    new DataView(expiration.buffer).setUint32(0, days, true);
    const rootSig = new Uint8Array(await crypto.subtle.sign(ED25519, root, concat([expiration, pub])));
    return { privateKey: pair.privateKey, header: concat([pub, expiration, rootSig]), expiresAtMs: days * DAY_MS };
  }

  private async intermediate(): Promise<Intermediate> {
    const nowMs = this.now().getTime();
    if (this.current && this.current.expiresAtMs - nowMs >= this.renewMs) return this.current;
    this.minting ??= this.mint(nowMs).then((i) => { this.current = i; return i; }).finally(() => { this.minting = null; });
    return this.minting;
  }

  /** The base64 X-Signature value for a response. */
  async signMessage(parts: SignatureParts): Promise<string> {
    const im = await this.intermediate();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const payload = new Uint8Array(await crypto.subtle.sign(ED25519, im.privateKey, signedMessage(salt, parts)));
    return toBase64(concat([im.header, salt, payload]));
  }
}

/** The signer from `deps.signingKey`, falling back to REVENUEDOT_SIGNING_KEY; undefined (signing off) when neither is set or the value is empty. */
export function resolveSigner(signingKey: string | undefined, now: () => Date): ResponseSigner | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const key = signingKey ?? env?.REVENUEDOT_SIGNING_KEY;
  return key && key.trim() ? new ResponseSigner(key, { now }) : undefined;
}

const NULL_BODY = new Set([101, 204, 205, 304]);

/** Signs 2xx/3xx responses after the route runs. Without a signer it passes straight through. */
export function responseSigning(signer: ResponseSigner | undefined, now: () => Date): MiddlewareHandler {
  if (!signer) return async (_c, next) => { await next(); };
  return async (c, next) => {
    await next();
    const res = c.res;
    if (res.status < 200 || res.status >= 400 || c.req.method === "OPTIONS" || c.req.method === "HEAD") return;
    let nonce: Uint8Array;
    try { nonce = fromBase64(c.req.header("x-nonce") ?? ""); } catch { return; }
    const headers = new Headers(res.headers);
    let requestTime = headers.get(REQUEST_TIME_HEADER);
    if (!requestTime) { requestTime = String(now().getTime()); headers.set(REQUEST_TIME_HEADER, requestTime); }
    const body = new Uint8Array(await res.clone().arrayBuffer());
    const bearer = /^Bearer (.*)$/i.exec(c.req.header("authorization") ?? "");
    headers.set(SIGNATURE_HEADER, await signer.signMessage({
      apiKey: bearer?.[1] ?? "",
      nonce,
      // The raw path the SDK sent (percent-encoding intact); Hono's c.req.path is decoded.
      path: new URL(c.req.url).pathname,
      postParamsHash: c.req.header("x-post-params-hash") ?? "",
      headersHash: c.req.header("x-headers-hash") ?? "",
      requestTime,
      etag: headers.get("X-RevenueCat-ETag") ?? "",
      body,
    }));
    c.res = undefined;
    c.res = new Response(NULL_BODY.has(res.status) ? null : body, { status: res.status, statusText: res.statusText, headers });
  };
}

/** GET /.well-known/revenuedot-signing-key: the public key apps pin to verify responses. */
export function signingKeyHandler(signer: ResponseSigner | undefined) {
  return async (c: Context) => {
    if (!signer) return c.json({ code: 7259, message: "Response signing is not configured on this server. Set REVENUEDOT_SIGNING_KEY." }, 404);
    return c.json({ algorithm: "Ed25519", public_key: await signer.publicKey(), encoding: "base64", header: SIGNATURE_HEADER, docs: "https://revenuedot.app/docs" });
  };
}
