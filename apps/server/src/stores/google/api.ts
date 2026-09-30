import { importPKCS8, SignJWT, type KeyLike } from "jose";
import { Codes, RCError } from "../../errors.js";
import type { AppRow } from "../types.js";

/** Google Play Developer API (androidpublisher v3) client: service-account OAuth, purchases, voided purchases, orders. */

export const ANDROID_PUBLISHER = "https://androidpublisher.googleapis.com/androidpublisher/v3";
export const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const ANDROID_PUBLISHER_SCOPE = "https://www.googleapis.com/auth/androidpublisher";

export interface ServiceAccount { client_email: string; private_key: string; private_key_id?: string; token_uri?: string }

export interface Money { currencyCode?: string; units?: string; nanos?: number }

/** purchases.subscriptionsv2 resource (only the fields RevenueDot reads). */
export interface SubscriptionPurchaseV2 {
  kind?: string;
  regionCode?: string;
  startTime?: string;
  subscriptionState?: string;
  latestOrderId?: string;
  linkedPurchaseToken?: string;
  acknowledgementState?: string;
  testPurchase?: Record<string, unknown>;
  pausedStateContext?: { autoResumeTime?: string };
  canceledStateContext?: {
    userInitiatedCancellation?: { cancelTime?: string; cancelSurveyResult?: unknown };
    systemInitiatedCancellation?: Record<string, unknown>;
    developerInitiatedCancellation?: Record<string, unknown>;
    replacementCancellation?: Record<string, unknown>;
  };
  externalAccountIdentifiers?: { externalAccountId?: string; obfuscatedExternalAccountId?: string; obfuscatedExternalProfileId?: string };
  lineItems?: Array<{
    productId: string;
    expiryTime?: string;
    latestSuccessfulOrderId?: string;
    autoRenewingPlan?: { autoRenewEnabled?: boolean; recurringPrice?: Money };
    prepaidPlan?: { allowExtendAfterTime?: string };
    offerDetails?: { basePlanId?: string; offerId?: string; offerTags?: string[] };
    offerPhase?: { freeTrial?: object; introductoryPrice?: object; basePrice?: object; prorationPeriod?: object };
    deferredItemReplacement?: { productId?: string };
  }>;
}

/** purchases.products resource. */
export interface ProductPurchase {
  purchaseTimeMillis?: string;
  /** 0 purchased, 1 canceled, 2 pending */
  purchaseState?: number;
  /** 0 yet to be consumed, 1 consumed */
  consumptionState?: number;
  orderId?: string;
  /** 0 test (license tester), 1 promo, 2 rewarded; absent for a normal purchase */
  purchaseType?: number;
  /** 0 yet to be acknowledged, 1 acknowledged */
  acknowledgementState?: number;
  purchaseToken?: string;
  productId?: string;
  quantity?: number;
  regionCode?: string;
  obfuscatedExternalAccountId?: string;
}

export interface VoidedPurchase {
  purchaseToken: string;
  purchaseTimeMillis?: string;
  voidedTimeMillis?: string;
  orderId?: string;
  voidedSource?: number;
  voidedReason?: number;
  kind?: string;
  voidedQuantity?: number;
}

/** Why a Google call failed, which decides the HTTP answer: bad token → 400, our setup → 400/500, Google down → 503. */
export type GoogleErrorKind = "invalid_token" | "credentials" | "transient";

export class GoogleApiError extends Error {
  constructor(public kind: GoogleErrorKind, message: string, public status = 0, public reason?: string) { super(message); }
}

/** The RevenueCat-compatible error for a failed Google call. Transient failures are 5xx so the SDK retries. */
export function toRCError(e: unknown): RCError {
  if (e instanceof RCError) return e;
  if (e instanceof GoogleApiError) {
    if (e.kind === "invalid_token") return new RCError(400, Codes.INVALID_RECEIPT, `The Google Play purchase token is not valid: ${e.message}`);
    if (e.kind === "credentials") return new RCError(503, Codes.STORE_PROBLEM, `Google Play credentials problem: ${e.message}`);
    return new RCError(503, Codes.STORE_PROBLEM, `There was a problem with Google Play: ${e.message}`);
  }
  return new RCError(503, Codes.STORE_PROBLEM, `There was a problem with Google Play: ${e instanceof Error ? e.message : String(e)}`);
}

/** Reads `credentials.service_account` (object or JSON string). */
export function serviceAccountOf(app: Pick<AppRow, "credentials">): ServiceAccount {
  let raw = (app.credentials?.play_service_account_credentials_json ?? app.credentials?.service_account) as unknown;
  if (raw === undefined || raw === null || raw === "") {
    throw new GoogleApiError("credentials", "no service account is configured for this Play app (credentials.service_account).");
  }
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { throw new GoogleApiError("credentials", "credentials.service_account is not valid JSON."); }
  }
  const sa = raw as Partial<ServiceAccount>;
  if (!sa || typeof sa.client_email !== "string" || typeof sa.private_key !== "string") {
    throw new GoogleApiError("credentials", "the service account JSON must contain client_email and private_key.");
  }
  return { client_email: sa.client_email, private_key: sa.private_key, private_key_id: sa.private_key_id, token_uri: sa.token_uri };
}

export function packageNameOf(app: Pick<AppRow, "bundleId">): string {
  if (!app.bundleId) throw new GoogleApiError("credentials", "the Play app has no package name (bundle id) configured.");
  return app.bundleId;
}

export interface GoogleClientOptions {
  fetch?: typeof fetch;
  /** Per-request timeout; a timeout is a transient failure (503). */
  timeoutMs?: number;
}

const enc = encodeURIComponent;

export class GooglePlayClient {
  private tokens = new Map<string, { token: string; expiresAt: number }>();
  private keys = new Map<string, KeyLike>();
  readonly customFetch: boolean;

  constructor(private opts: GoogleClientOptions = {}) { this.customFetch = !!opts.fetch; }

  /** fetch with a timeout; network errors and timeouts become transient GoogleApiErrors. */
  async http(url: string, init: RequestInit = {}): Promise<Response> {
    const f = this.opts.fetch ?? globalThis.fetch;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? 15_000);
    // Race the abort too: a fetch that ignores its signal must still time out.
    const aborted = new Promise<never>((_, reject) => ctl.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    try {
      return await Promise.race([f(url, { ...init, signal: ctl.signal }), aborted]);
    } catch (e) {
      const msg = ctl.signal.aborted ? "request timed out" : e instanceof Error ? e.message : String(e);
      throw new GoogleApiError("transient", msg);
    } finally {
      clearTimeout(timer);
    }
  }

  /** OAuth 2.0 JWT bearer grant with the service account; tokens are cached until a minute before expiry. */
  async accessToken(sa: ServiceAccount): Promise<string> {
    const cacheKey = `${sa.client_email}|${sa.private_key_id ?? ""}`;
    const nowMs = Date.now();
    const cached = this.tokens.get(cacheKey);
    if (cached && cached.expiresAt > nowMs + 60_000) return cached.token;
    let key = this.keys.get(sa.private_key);
    if (!key) {
      try { key = await importPKCS8(sa.private_key.replace(/\\n/g, "\n"), "RS256"); } catch {
        throw new GoogleApiError("credentials", "the service account private_key is not a valid PKCS#8 RSA key.");
      }
      this.keys.set(sa.private_key, key);
    }
    const signingKey: KeyLike = key;
    const aud = sa.token_uri ?? OAUTH_TOKEN_URL;
    const iat = Math.floor(nowMs / 1000);
    const assertion = await new SignJWT({ scope: ANDROID_PUBLISHER_SCOPE })
      .setProtectedHeader({ alg: "RS256", typ: "JWT", ...(sa.private_key_id ? { kid: sa.private_key_id } : {}) })
      .setIssuer(sa.client_email).setAudience(aud).setIssuedAt(iat).setExpirationTime(iat + 3600)
      .sign(signingKey);
    const res = await this.http(aud, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
    });
    const body = await res.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok || !body.access_token) {
      if (res.status >= 500 || res.status === 429) throw new GoogleApiError("transient", `token endpoint answered ${res.status}`, res.status);
      throw new GoogleApiError("credentials", `Google rejected the service account (${body.error ?? res.status}${body.error_description ? `: ${body.error_description}` : ""}).`, res.status, body.error);
    }
    this.tokens.set(cacheKey, { token: body.access_token, expiresAt: nowMs + (body.expires_in ?? 3600) * 1000 });
    return body.access_token;
  }

  /** One authorised call to the Play Developer API. Returns parsed JSON ({} for empty bodies). */
  async call<T = any>(app: Pick<AppRow, "credentials" | "bundleId">, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const sa = serviceAccountOf(app);
    const token = await this.accessToken(sa);
    const res = await this.http(`${ANDROID_PUBLISHER}/applications/${enc(packageNameOf(app))}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : method === "POST" ? "" : undefined,
    });
    const text = await res.text();
    let json: any = {};
    if (text) { try { json = JSON.parse(text); } catch { json = {}; } }
    if (res.ok) return json as T;
    const err = json?.error ?? {};
    const reason: string | undefined = err.errors?.[0]?.reason ?? err.status;
    const message = `${res.status} ${err.message ?? res.statusText ?? "error"}`.trim();
    if (res.status === 401) {
      this.tokens.clear();
      throw new GoogleApiError("credentials", `${message}. Check the service account.`, res.status, reason);
    }
    if (res.status === 403) {
      if (reason && /rate|quota|limit/i.test(reason)) throw new GoogleApiError("transient", message, res.status, reason);
      throw new GoogleApiError("credentials", `${message}. Grant the service account access to this app in Play Console.`, res.status, reason);
    }
    if (res.status === 429 || res.status >= 500) throw new GoogleApiError("transient", message, res.status, reason);
    if (reason === "applicationNotFound") throw new GoogleApiError("credentials", `${message}. No Play app has the package name ${app.bundleId}.`, res.status, reason);
    if (res.status === 400 || res.status === 404 || res.status === 410) throw new GoogleApiError("invalid_token", message, res.status, reason);
    throw new GoogleApiError("transient", message, res.status, reason);
  }

  getSubscriptionV2(app: AppRow, token: string) {
    return this.call<SubscriptionPurchaseV2>(app, "GET", `/purchases/subscriptionsv2/tokens/${enc(token)}`);
  }
  /** v1 subscriptions.get: only used for `autoResumeTimeMillis` of a scheduled pause, which v2 does not report. */
  getSubscriptionV1(app: AppRow, subscriptionId: string, token: string) {
    return this.call<{ autoResumeTimeMillis?: string; expiryTimeMillis?: string }>(app, "GET", `/purchases/subscriptions/${enc(subscriptionId)}/tokens/${enc(token)}`);
  }
  acknowledgeSubscription(app: AppRow, subscriptionId: string, token: string) {
    return this.call(app, "POST", `/purchases/subscriptions/${enc(subscriptionId)}/tokens/${enc(token)}:acknowledge`, {});
  }
  getProduct(app: AppRow, productId: string, token: string) {
    return this.call<ProductPurchase>(app, "GET", `/purchases/products/${enc(productId)}/tokens/${enc(token)}`);
  }
  acknowledgeProduct(app: AppRow, productId: string, token: string) {
    return this.call(app, "POST", `/purchases/products/${enc(productId)}/tokens/${enc(token)}:acknowledge`, {});
  }

  /** voidedpurchases.list, following pagination. Google keeps 30 days of voided purchases. */
  async listVoidedPurchases(app: AppRow, opts: { startTime?: Date; endTime?: Date; type?: 0 | 1; maxPages?: number } = {}): Promise<VoidedPurchase[]> {
    const out: VoidedPurchase[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < (opts.maxPages ?? 50); page++) {
      const q = new URLSearchParams();
      if (opts.startTime) q.set("startTime", String(opts.startTime.getTime()));
      if (opts.endTime) q.set("endTime", String(opts.endTime.getTime()));
      if (opts.type !== undefined) q.set("type", String(opts.type));
      q.set("maxResults", "1000");
      if (pageToken) q.set("token", pageToken);
      const r = await this.call<{ voidedPurchases?: VoidedPurchase[]; tokenPagination?: { nextPageToken?: string } }>(app, "GET", `/purchases/voidedpurchases?${q}`);
      out.push(...(r.voidedPurchases ?? []));
      pageToken = r.tokenPagination?.nextPageToken;
      if (!pageToken) break;
    }
    return out;
  }

  /** orders.batchget: order id → purchase token (and the rest of each Order). */
  async batchGetOrders(app: AppRow, orderIds: string[]): Promise<Array<{ orderId: string; purchaseToken?: string; [k: string]: unknown }>> {
    const out: Array<{ orderId: string; purchaseToken?: string }> = [];
    for (let i = 0; i < orderIds.length; i += 100) {
      const q = new URLSearchParams();
      for (const id of orderIds.slice(i, i + 100)) q.append("orderIds", id);
      const r = await this.call<{ orders?: Array<{ orderId: string; purchaseToken?: string }> }>(app, "GET", `/orders:batchGet?${q}`);
      out.push(...(r.orders ?? []));
    }
    return out;
  }
}
