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
    userInitiatedCancellation?: { cancelTime?: string; cancelSurveyResult?: { reason?: string; reasonUserInput?: string } };
    systemInitiatedCancellation?: Record<string, unknown>;
    developerInitiatedCancellation?: Record<string, unknown>;
    replacementCancellation?: Record<string, unknown>;
  };
  externalAccountIdentifiers?: { externalAccountId?: string; obfuscatedExternalAccountId?: string; obfuscatedExternalProfileId?: string };
  /** Entity tag of the current state; Google requires it for defer. */
  etag?: string;
  lineItems?: Array<{
    productId: string;
    expiryTime?: string;
    latestSuccessfulOrderId?: string;
    autoRenewingPlan?: {
      autoRenewEnabled?: boolean;
      recurringPrice?: Money;
      /** The last price change since signup. PRICE_INCREASE needs the customer's consent; OPT_OUT_PRICE_INCREASE does not. */
      priceChangeDetails?: { newPrice?: Money; priceChangeMode?: string; priceChangeState?: string; expectedNewPriceChargeTime?: string };
      /** A price step-up that needs consent (state PENDING, CONFIRMED or COMPLETED). */
      priceStepUpConsentDetails?: { state?: string; consentDeadlineTime?: string; newPrice?: Money };
    };
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

/** orders resource (the fields RevenueDot reads). */
export interface Order {
  orderId: string;
  purchaseToken?: string;
  state?: string;
  lineItems?: Array<{
    productId?: string;
    productTitle?: string;
    subscriptionDetails?: { basePlanId?: string; offerId?: string };
    oneTimePurchaseDetails?: { quantity?: number; offerId?: string; purchaseOptionId?: string };
  }>;
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
  /** 1 full refund, 2 quantity-based partial refund. */
  refundType?: number;
}

/** A base plan's price in one region (monetization RegionalBasePlanConfig). */
export interface PlayRegionalConfig { regionCode: string; newSubscriberAvailability?: boolean; price?: Money }

/** monetization.subscriptions base plan (the fields RevenueDot reads; anything else is kept as read when patching). */
export interface PlayBasePlan {
  basePlanId: string;
  state?: string;
  autoRenewingBasePlanType?: { billingPeriodDuration?: string; legacyCompatible?: boolean; [k: string]: unknown };
  prepaidBasePlanType?: { billingPeriodDuration?: string; [k: string]: unknown };
  installmentsBasePlanType?: { billingPeriodDuration?: string; [k: string]: unknown };
  regionalConfigs?: PlayRegionalConfig[];
  otherRegionsConfig?: { usdPrice?: Money; eurPrice?: Money; newSubscriberAvailability?: boolean };
  [k: string]: unknown;
}

/** monetization.subscriptions resource (the fields the product import and the price reads use). */
export interface PlaySubscription {
  packageName?: string;
  productId: string;
  listings?: Array<{ languageCode?: string; title?: string; [k: string]: unknown }>;
  basePlans?: PlayBasePlan[];
  archived?: boolean;
  [k: string]: unknown;
}

/** Google's Money as micros of its currency: units plus nanos. */
export const moneyMicros = (m: Money | undefined | null): number | null => {
  if (!m || (m.units === undefined && m.nanos === undefined)) return null;
  const units = Number(m.units ?? 0);
  if (!Number.isFinite(units)) return null;
  return units * 1_000_000 + Math.round((m.nanos ?? 0) / 1000);
};
/** Micros of a currency as Google's Money. */
export const microsMoney = (micros: number, currencyCode: string): Money => {
  const units = Math.floor(micros / 1_000_000);
  const nanos = (micros - units * 1_000_000) * 1000;
  return { currencyCode, units: String(units), ...(nanos ? { nanos } : {}) };
};

/** The regions version RevenueDot sends with subscription writes (Play rejects a write without one). */
export const PLAY_REGIONS_VERSION = "2022/02";

/** monetization.onetimeproducts resource (the fields the product import reads). */
export interface PlayOneTimeProduct {
  productId: string;
  listings?: Array<{ languageCode?: string; title?: string }>;
  purchaseOptions?: Array<{
    purchaseOptionId?: string; state?: string; buyOption?: { legacyCompatible?: boolean }; rentOption?: object;
    regionalPricingAndAvailabilityConfigs?: Array<{ regionCode: string; price?: Money; availability?: string }>;
  }>;
}

/** inappproducts resource (legacy API; still lists one-time products made before Play's 2025 purchase options). */
export interface PlayInAppProduct {
  sku: string; status?: string; purchaseType?: string; defaultLanguage?: string;
  listings?: Record<string, { title?: string }>;
  defaultPrice?: { priceMicros?: string; currency?: string };
  prices?: Record<string, { priceMicros?: string; currency?: string }>;
}

/** Whether the app has a service account configured at all (either field name). */
export const hasServiceAccount = (app: Pick<AppRow, "credentials">) => {
  const raw = app.credentials?.play_service_account_credentials_json ?? app.credentials?.service_account;
  return raw !== undefined && raw !== null && raw !== "";
};

/** Why a Google call failed, which decides the HTTP answer: bad token → 400, our setup → 400/500, Google down → 503. */
export type GoogleErrorKind = "invalid_token" | "credentials" | "transient" | "conflict";

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

  /** The raw fetch this client uses (the injected one, else the global). */
  get fetchImpl(): typeof fetch { return this.opts.fetch ?? ((u, i) => globalThis.fetch(u, i)); }

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

  /**
   * OAuth 2.0 JWT bearer grant with the service account; tokens are cached until a minute before expiry. The cache is
   * keyed by the private key (client_email and private_key_id are not secret: a key file with another project's email
   * must never pick up that project's token), and the key file's `token_uri` is ignored: the signed assertion always
   * goes to Google's token endpoint, never to a URL a customer could point at the server's own network.
   */
  async accessToken(sa: ServiceAccount): Promise<string> {
    const cacheKey = `${sa.client_email}|${sa.private_key}`;
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
    const aud = OAUTH_TOKEN_URL;
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
  async call<T = any>(app: Pick<AppRow, "credentials" | "bundleId">, method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
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
    if (res.status === 409) throw new GoogleApiError("conflict", message, res.status, reason);
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

  /** subscriptionsv2.revoke with a full refund of the latest order: access ends now. */
  revokeSubscriptionV2(app: AppRow, token: string) {
    return this.call(app, "POST", `/purchases/subscriptionsv2/tokens/${enc(token)}:revoke`, { revocationContext: { fullRefund: {} } });
  }
  /** subscriptionsv2.cancel: renewal stops, access continues to the end of the paid period. */
  cancelSubscriptionV2(app: AppRow, token: string) {
    return this.call(app, "POST", `/purchases/subscriptionsv2/tokens/${enc(token)}:cancel`, { cancellationContext: { cancellationType: "DEVELOPER_REQUESTED_STOP_PAYMENTS" } });
  }
  /** subscriptionsv2.defer: moves the next renewal later by `seconds`. Google requires the etag of the state being changed. */
  deferSubscriptionV2(app: AppRow, token: string, etag: string, seconds: number) {
    return this.call(app, "POST", `/purchases/subscriptionsv2/tokens/${enc(token)}:defer`, { deferralContext: { etag, deferDuration: `${Math.round(seconds)}s` } });
  }
  /** orders.refund: refunds one order (a subscription period or a one-time purchase); `revoke` also ends access. */
  refundOrder(app: AppRow, orderId: string, revoke = true) {
    return this.call(app, "POST", `/orders/${enc(orderId)}:refund?revoke=${revoke}`);
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
  async batchGetOrders(app: AppRow, orderIds: string[]): Promise<Order[]> {
    const out: Order[] = [];
    for (let i = 0; i < orderIds.length; i += 100) {
      const q = new URLSearchParams();
      for (const id of orderIds.slice(i, i + 100)) q.append("orderIds", id);
      const r = await this.call<{ orders?: Order[] }>(app, "GET", `/orders:batchGet?${q}`);
      out.push(...(r.orders ?? []));
    }
    return out;
  }

  /** The app's default listing language, read from a throwaway edit (edits.insert, edits.details.get, edits.delete). */
  async defaultLanguage(app: AppRow): Promise<string> {
    const edit = await this.call<{ id?: string }>(app, "POST", "/edits", {});
    if (!edit.id) throw new GoogleApiError("transient", "Google did not open an edit.");
    try {
      const d = await this.call<{ defaultLanguage?: string }>(app, "GET", `/edits/${enc(edit.id)}/details`);
      return d.defaultLanguage || "en-US";
    } finally {
      await this.call(app, "DELETE", `/edits/${enc(edit.id)}`).catch(() => undefined);
    }
  }

  /** monetization.subscriptions.create with one listing and no base plans (base plans need prices, which Play Console adds). */
  createSubscription(app: AppRow, productId: string, listing: { languageCode: string; title: string }) {
    const q = new URLSearchParams({ productId, "regionsVersion.version": "2022/02" });
    return this.call<{ productId?: string; listings?: { title?: string }[] }>(app, "POST", `/subscriptions?${q}`, { packageName: packageNameOf(app), productId, listings: [listing] });
  }

  /** monetization.subscriptions.get. */
  getSubscription(app: AppRow, productId: string) {
    return this.call<PlaySubscription>(app, "GET", `/subscriptions/${enc(productId)}`);
  }

  /**
   * monetization.subscriptions.patch with `updateMask=basePlans`: the subscription as read, with its base plans changed.
   * Base plan prices apply to new subscribers; existing ones keep theirs until migrated (basePlans.migratePrices).
   */
  patchSubscriptionBasePlans(app: AppRow, sub: PlaySubscription) {
    const q = new URLSearchParams({ updateMask: "basePlans", "regionsVersion.version": PLAY_REGIONS_VERSION });
    return this.call<PlaySubscription>(app, "PATCH", `/subscriptions/${enc(sub.productId)}?${q}`, { ...sub, packageName: packageNameOf(app) });
  }

  /** monetization.subscriptions.create with one listing and the given base plans (they start as drafts). */
  createSubscriptionWithBasePlans(app: AppRow, productId: string, listing: { languageCode: string; title: string }, basePlans: PlayBasePlan[]) {
    const q = new URLSearchParams({ productId, "regionsVersion.version": PLAY_REGIONS_VERSION });
    return this.call<PlaySubscription>(app, "POST", `/subscriptions?${q}`, { packageName: packageNameOf(app), productId, listings: [listing], basePlans });
  }

  /** monetization.subscriptions.basePlans.activate: a draft base plan goes on sale. */
  activateBasePlan(app: AppRow, productId: string, basePlanId: string) {
    return this.call<PlaySubscription>(app, "POST", `/subscriptions/${enc(productId)}/basePlans/${enc(basePlanId)}:activate`, { packageName: packageNameOf(app), productId, basePlanId });
  }

  /** pricing.convertRegionPrices: a price converted to every region Play sells in (with each region's currency). */
  convertRegionPrices(app: AppRow, price: Money) {
    return this.call<{ convertedRegionPrices?: Record<string, { regionCode?: string; price?: Money }>; regionVersion?: { version?: string } }>(app, "POST", "/pricing:convertRegionPrices", { price });
  }

  /** Pages through a Play list: `pageToken`/`nextPageToken` (monetization) or `token`/`tokenPagination` (inappproducts). */
  private async listPages<T>(app: AppRow, path: string, field: string, params: Record<string, string>, legacy: boolean, maxPages: number): Promise<{ items: T[]; truncated: boolean }> {
    const items: T[] = [];
    let token: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const q = new URLSearchParams(params);
      if (token) q.set(legacy ? "token" : "pageToken", token);
      const r = await this.call<Record<string, unknown> & { nextPageToken?: string; tokenPagination?: { nextPageToken?: string } }>(app, "GET", `${path}?${q}`);
      items.push(...((r[field] as T[] | undefined) ?? []));
      token = legacy ? r.tokenPagination?.nextPageToken : r.nextPageToken;
      if (!token) return { items, truncated: false };
    }
    return { items, truncated: true };
  }

  /** monetization.subscriptions.list: every subscription with its base plans (archived ones left out). */
  listSubscriptions(app: AppRow, maxPages = 25) {
    return this.listPages<PlaySubscription>(app, "/subscriptions", "subscriptions", { pageSize: "100" }, false, maxPages);
  }
  /** monetization.onetimeproducts.list: one-time products with their purchase options. */
  listOneTimeProducts(app: AppRow, maxPages = 25) {
    return this.listPages<PlayOneTimeProduct>(app, "/oneTimeProducts", "oneTimeProducts", { pageSize: "100" }, false, maxPages);
  }
  /** inappproducts.list (legacy): managed products and, before base plans, subscriptions. */
  listInAppProducts(app: AppRow, maxPages = 25) {
    return this.listPages<PlayInAppProduct>(app, "/inappproducts", "inappproduct", { maxResults: "100" }, true, maxPages);
  }
}
