import { importPKCS8, importSPKI, SignJWT, type KeyLike } from "jose";
import { Codes, RCError } from "../../errors.js";
import type { AppRow } from "../types.js";
import { guardedFetch, OutboundRefused } from "../../services/outbound.js";

/**
 * Samsung in-app purchase server APIs.
 *   Receipt (no auth):  GET https://iap.samsungapps.com/iap/v6/receipt?purchaseID=…
 *     https://developer.samsung.com/iap/programming-guide/samsung-iap-server-api.html
 *   Developer API:      https://devapi.samsungapps.com, with an access token from POST /auth/accessToken (an RS256 JWT
 *     signed with the service account's private key, scopes publishing and gss) and the `service-account-id` header.
 *     https://developer.samsung.com/galaxy-store/galaxy-store-developer-api/create-an-access-token.html
 *   Subscription:       GET|PATCH /iap/seller/v6/applications/{package}/purchases/subscriptions/{purchaseId}
 *     https://developer.samsung.com/iap/api/iap-subscription-api.html
 *   Items:              GET /iap/v6/applications/{package}/items?page=&size=   (in-app items only, no subscriptions)
 * Dates are GMT text: "2019-11-29 01:32:41" (receipts) or "2024-06-01 01:02:03 GMT" (subscriptions).
 */
export const SAMSUNG_RECEIPT = "https://iap.samsungapps.com/iap/v6/receipt";
export const SAMSUNG_DEVAPI = "https://devapi.samsungapps.com";

export interface GalaxyReceipt {
  itemId: string; paymentId?: string; orderId?: string; packageName?: string; itemName?: string; itemDesc?: string; itemType?: "Item" | "Subscription" | string;
  countryCode?: string | null; purchaseDate?: string; paymentAmount?: string; status: "success" | "fail" | "cancel" | string; paymentMethod?: string;
  mode?: "TEST" | "PRODUCTION" | string; consumeYN?: string; acknowledgeYN?: string; currencyCode?: string; currencyUnit?: string; cancelDate?: string | null;
  obfuscatedAccountId?: string | null; obfuscatedProfileId?: string | null; errorCode?: number; errorMessage?: string;
}
export interface GalaxySubscription {
  subscriptionPurchaseDate?: string; subscriptionEndDate?: string; subscriptionStatus?: "ACTIVE" | "CANCEL" | string; subscriptionFirstPurchaseID?: string;
  countryCode?: string | null; price?: { localCurrencyCode?: string; localPrice?: number | string; supplyPrice?: number | string } | null; itemID?: string; itemTitle?: string;
  freeTrial?: "Y" | "T" | "N" | string; realMode?: "Y" | "N" | string; latestOrderId?: string; latestRenewalDate?: string | null;
  totalNumberOfTieredPayment?: string | number; currentPaymentPlan?: "F" | "R" | "T" | string; totalNumberOfRenewalPayment?: string | number;
  cancelSubscriptionDate?: string | null; cancelSubscriptionReason?: string | null; gracePeriodYN?: "Y" | "N" | string; gracePeriodEndDate?: string | null;
  priceChange?: { agreeYN?: string } | null;
}
export interface GalaxyItem { id: string; title?: string; description?: string; type?: string; status?: string; usdPrice?: number | string; prices?: Array<{ countryId: string; currency: string; localPrice: string | number }> }

export class GalaxyApiError extends Error {
  constructor(public kind: "invalid" | "credentials" | "transient" | "not_found", message: string, public status = 0, public code?: string) { super(message); }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error("timed out"), { name: "TimeoutError" })), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
export interface GalaxyClientOptions { fetch?: FetchFn; timeoutMs?: number; now?: () => Date }

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
export const serviceAccountIdOf = (app: Pick<AppRow, "credentials">) => str((app.credentials ?? {}).galaxy_service_account_id);
export const serviceKeyOf = (app: Pick<AppRow, "credentials">) => str((app.credentials ?? {}).galaxy_service_account_private_key);
export const hasServiceAccount = (app: Pick<AppRow, "credentials">) => !!serviceAccountIdOf(app) && !!serviceKeyOf(app);

/** "2024-06-01 01:02:03", "2024-06-01 01:02:03 GMT", "20240601010203" or ISO 8601, all UTC. */
export function samsungDate(v: unknown): Date | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const s = v.trim().replace(/\s*(GMT|UTC)$/i, "");
  const compact = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(s);
  const iso = compact ? `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6]}Z` : /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s) ? `${s.replace(" ", "T")}Z` : s;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ---- Keys: PKCS#8 PEM, PKCS#1 PEM (BEGIN RSA PRIVATE KEY) or bare base64 ---------------------------------------------

const b64 = (s: string) => Uint8Array.from(atob(s.replace(/\s+/g, "")), (c) => c.charCodeAt(0));
const toB64 = (u: Uint8Array) => btoa(String.fromCharCode(...u)).replace(/(.{64})/g, "$1\n");
const derLen = (n: number) => (n < 128 ? [n] : n < 256 ? [0x81, n] : n < 65536 ? [0x82, n >> 8, n & 255] : [0x83, n >> 16, (n >> 8) & 255, n & 255]);
const der = (tag: number, body: Uint8Array) => Uint8Array.from([tag, ...derLen(body.length), ...body]);
/** A PKCS#1 RSAPrivateKey wrapped as PKCS#8 (version 0, rsaEncryption, NULL). */
function pkcs1To8(pkcs1: Uint8Array): Uint8Array {
  const alg = Uint8Array.from([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);
  const body = Uint8Array.from([0x02, 0x01, 0x00, ...alg, ...der(0x04, pkcs1)]);
  return der(0x30, body);
}

/** The service account's private key, whichever way Seller Portal's download is pasted. */
export async function importServiceKey(text: string): Promise<KeyLike> {
  const t = text.trim();
  try {
    if (/-----BEGIN PRIVATE KEY-----/.test(t)) return await importPKCS8(t, "RS256");
    const pkcs1 = /-----BEGIN RSA PRIVATE KEY-----([\s\S]+?)-----END RSA PRIVATE KEY-----/.exec(t);
    if (pkcs1) return await importPKCS8(`-----BEGIN PRIVATE KEY-----\n${toB64(pkcs1To8(b64(pkcs1[1]!)))}\n-----END PRIVATE KEY-----`, "RS256");
    if (/^[A-Za-z0-9+/=\s]+$/.test(t)) return await importPKCS8(`-----BEGIN PRIVATE KEY-----\n${toB64(b64(t))}\n-----END PRIVATE KEY-----`, "RS256");
  } catch { /* below */ }
  throw new GalaxyApiError("credentials", "The service account private key is not an RSA private key. Paste the key file Seller Portal gave you, unchanged.");
}

/** The seller's IAP public key (Seller Portal → Assistance → API Service → IAP Key), PEM or bare base64 (X.509 SubjectPublicKeyInfo). */
export async function importIapPublicKey(text: string): Promise<KeyLike> {
  const t = text.trim();
  try {
    if (/-----BEGIN PUBLIC KEY-----/.test(t)) return await importSPKI(t, "RS256");
    if (/^[A-Za-z0-9+/=\s]+$/.test(t)) return await importSPKI(`-----BEGIN PUBLIC KEY-----\n${toB64(b64(t))}\n-----END PUBLIC KEY-----`, "RS256");
  } catch { /* below */ }
  throw new GalaxyApiError("credentials", "The IAP public key is not an RSA public key. Copy it from Seller Portal → Assistance → API Service → IAP Key.");
}

export class GalaxyClient {
  readonly customFetch: boolean;
  readonly fetchImpl: FetchFn;
  readonly timeoutMs: number;
  readonly now: () => Date;
  /** Access tokens by service account id and key; Samsung's tokens last until revoked, renewed here after 50 minutes. */
  private tokens = new Map<string, { token: string; at: number }>();
  constructor(opts: GalaxyClientOptions = {}) {
    this.customFetch = !!opts.fetch;
    this.fetchImpl = opts.fetch ?? ((u, i) => fetch(u, i));
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.now = opts.now ?? (() => new Date());
  }

  private async send(url: string, init: RequestInit): Promise<{ status: number; body: any; text: string }> {
    let res: Response;
    try {
      res = await withTimeout(guardedFetch(this.fetchImpl, url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) }), this.timeoutMs);
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      throw new GalaxyApiError("transient", timedOut ? "Samsung timed out" : e instanceof OutboundRefused ? `The Samsung request was refused: ${e.message}` : "Samsung could not be reached");
    }
    const text = await res.text().catch(() => "");
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: res.status, body, text };
  }

  /** The receipt of one purchase (no credentials needed). */
  async receipt(purchaseId: string): Promise<GalaxyReceipt> {
    const { status, body } = await this.send(`${SAMSUNG_RECEIPT}?purchaseID=${encodeURIComponent(purchaseId)}`, { method: "GET", headers: { accept: "application/json" } });
    if (status === 429 || status >= 500) throw new GalaxyApiError("transient", `Samsung's receipt API answered ${status}`, status);
    if (!body || typeof body !== "object") throw new GalaxyApiError(status === 200 ? "transient" : "invalid", `Samsung's receipt API answered ${status} without JSON`, status);
    if (body.status === "fail" || status >= 400) {
      const code = Number(body.errorCode);
      // 9135 "not exist order", 9153 invalid purchaseID, 1000/1 general failures.
      if (code === 9135 || code === 9153 || status === 400 || status === 404) throw new GalaxyApiError("invalid", `Samsung does not know this purchase (${body.errorMessage ?? code}).`, status, String(code));
      throw new GalaxyApiError("transient", `Samsung's receipt API failed: ${body.errorMessage ?? code}`, status, String(code));
    }
    if (typeof body.itemId !== "string") throw new GalaxyApiError("transient", "Samsung's receipt API answered without an item", status);
    return body as GalaxyReceipt;
  }

  async accessToken(app: Pick<AppRow, "credentials">, refresh = false): Promise<string> {
    const id = serviceAccountIdOf(app), pem = serviceKeyOf(app);
    if (!id || !pem) throw new RCError(500, Codes.STORE_PROBLEM, "This Galaxy app has no service account yet. Add its id and private key in the app's settings (Seller Portal → Assistance → API Service).");
    const cacheKey = `${id}:${pem.length}:${pem.slice(-24)}`;
    const now = this.now().getTime();
    const hit = this.tokens.get(cacheKey);
    if (hit && !refresh && now - hit.at < 50 * 60_000) return hit.token;
    const key = await importServiceKey(pem);
    const iat = Math.floor(now / 1000);
    const jwt = await new SignJWT({ scopes: ["publishing", "gss"] }).setProtectedHeader({ alg: "RS256", typ: "JWT" }).setIssuer(id).setIssuedAt(iat).setExpirationTime(iat + 1200).sign(key);
    const { status, body } = await this.send(`${SAMSUNG_DEVAPI}/auth/accessToken`, { method: "POST", headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json", accept: "application/json" } });
    const token = body?.createdItem?.accessToken;
    if (status === 200 && body?.ok !== false && typeof token === "string" && token) {
      this.tokens.set(cacheKey, { token, at: now });
      return token;
    }
    if (status === 401 || status === 403 || status === 400) throw new GalaxyApiError("credentials", `Samsung refused the service account (${body?.code ?? status}: ${body?.message ?? "no access token"}). Check the service account id and its private key.`, status, body?.code);
    throw new GalaxyApiError("transient", `Samsung's access token API answered ${status}`, status);
  }

  /** A Developer API call with the app's access token; a 401 renews the token once. */
  async devapi(app: Pick<AppRow, "credentials">, method: "GET" | "PATCH" | "POST", path: string, json?: unknown): Promise<any> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.accessToken(app, attempt > 0);
      const { status, body } = await this.send(`${SAMSUNG_DEVAPI}${path}`, {
        method, headers: { authorization: `Bearer ${token}`, "service-account-id": serviceAccountIdOf(app)!, "content-type": "application/json", accept: "application/json" },
        body: json !== undefined ? JSON.stringify(json) : undefined,
      });
      if (status === 401 && attempt === 0) continue;
      if (status >= 200 && status < 300 && body) return body;
      const code = typeof body?.code === "string" ? body.code : typeof body?.errorCode === "string" ? body.errorCode : undefined;
      const message = typeof body?.message === "string" ? body.message : typeof body?.errorMessage === "string" ? body.errorMessage : `Samsung answered ${status}`;
      if (status === 401 || status === 403) throw new GalaxyApiError("credentials", `${code ?? status}: ${message}`, status, code);
      if (status === 404) throw new GalaxyApiError("not_found", message, status, code);
      if (status === 400 || status === 422 || status === 409) throw new GalaxyApiError("invalid", `${code ? `${code}: ` : ""}${message}`, status, code);
      throw new GalaxyApiError("transient", message, status, code);
    }
    throw new GalaxyApiError("credentials", "Samsung refused the access token twice.", 401);
  }

  subscription(app: Pick<AppRow, "credentials" | "bundleId">, purchaseId: string): Promise<GalaxySubscription> {
    return this.devapi(app, "GET", `/iap/seller/v6/applications/${encodeURIComponent(app.bundleId ?? "")}/purchases/subscriptions/${encodeURIComponent(purchaseId)}`);
  }
  /** Cancel, refund or revoke a subscription (`action`), as the seller. */
  subscriptionAction(app: Pick<AppRow, "credentials" | "bundleId">, purchaseId: string, action: "cancel" | "refund" | "revoke") {
    return this.devapi(app, "PATCH", `/iap/seller/v6/applications/${encodeURIComponent(app.bundleId ?? "")}/purchases/subscriptions/${encodeURIComponent(purchaseId)}`, { action, caller: "admin" });
  }
  /** Every in-app item of the app (Samsung's publish API lists no subscriptions). */
  async items(app: Pick<AppRow, "credentials" | "bundleId">, maxPages = 50): Promise<{ data: GalaxyItem[]; truncated: boolean }> {
    const out: GalaxyItem[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const r = await this.devapi(app, "GET", `/iap/v6/applications/${encodeURIComponent(app.bundleId ?? "")}/items?page=${page}&size=100`);
      const list: GalaxyItem[] = Array.isArray(r?.itemList) ? r.itemList : [];
      out.push(...list);
      const total = Number(r?.totalCount ?? out.length);
      if (!list.length || out.length >= total) return { data: out, truncated: false };
    }
    return { data: out, truncated: true };
  }
}

/** Samsung failures as the receipt endpoint must answer them: never 4xx for anything that can succeed later. */
export function toRCError(e: unknown): unknown {
  if (!(e instanceof GalaxyApiError)) return e;
  if (e.kind === "invalid" || e.kind === "not_found") return new RCError(400, Codes.INVALID_RECEIPT, `Galaxy Store: ${e.message}`);
  if (e.kind === "credentials") return new RCError(500, Codes.STORE_PROBLEM, `Galaxy credentials problem: ${e.message}`);
  return new RCError(503, Codes.STORE_PROBLEM, `Samsung is temporarily unavailable: ${e.message}. Try again later.`);
}
