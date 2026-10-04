import { eq } from "drizzle-orm";
import { exportJWK, exportPKCS8, generateKeyPair, jwtVerify, SignJWT, type KeyLike } from "jose";
import { schema } from "@revenuedot/db";
import { harness, type Harness } from "../../../packages/contract/src/harness.js";
import { createApp } from "../src/app.js";
import { defaultStores } from "../src/stores/index.js";
import { createGoogleStore, type GoogleStore } from "../src/stores/google/index.js";
import type { ProductPurchase, SubscriptionPurchaseV2, VoidedPurchase } from "../src/stores/google/api.js";
import { setAppCredentials, TEST_ENCRYPTION_KEY } from "./store-secret-helpers.js";

export const PKG = "com.example.scanner";
export const API = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PKG}`;

export interface Keys { privateKey: KeyLike; publicKey: KeyLike; pem: string; sa: Record<string, string> }

export async function makeKeys(): Promise<Keys> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const pem = await exportPKCS8(privateKey);
  const sa = { type: "service_account", project_id: "scanner", private_key_id: "kid-1", private_key: pem, client_email: "rd@scanner.iam.gserviceaccount.com", token_uri: "https://oauth2.googleapis.com/token" };
  return { privateKey, publicKey, pem, sa };
}

interface Call { method: string; url: string; body: string; auth: string | null }

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const googleError = (status: number, message: string, reason: string) => json(status, { error: { code: status, message, errors: [{ reason, message }] } });

/** A fake Google: OAuth token endpoint, the Play Developer API purchase endpoints, Google certs and a forward target. */
export class FakeGoogle {
  subs = new Map<string, SubscriptionPurchaseV2>();
  products = new Map<string, ProductPurchase>();
  v1 = new Map<string, { autoResumeTimeMillis?: string }>();
  orders = new Map<string, string>();
  /** orders.batchGet line items per order id (productId, subscriptionDetails or oneTimePurchaseDetails). */
  orderLines = new Map<string, unknown[]>();
  /** Subscriptions created through monetization.subscriptions.create, by product id. */
  created = new Map<string, Record<string, unknown>>();
  /** The app's default language, answered by edits.details.get. */
  defaultLanguage = "en-US";
  /** What purchases.voidedpurchases.list returns (filtered by startTime/endTime on voidedTimeMillis). */
  voided: VoidedPurchase[] = [];
  /** Order ids refunded through orders.refund, with the revoke flag. */
  refunds: { orderId: string; revoke: boolean }[] = [];
  calls: Call[] = [];
  tokenRequests: URLSearchParams[] = [];
  forwarded: Call[] = [];
  jwks: unknown = { keys: [] };
  /** Return a Response to override any call (e.g. to simulate outages). */
  override: ((url: string, method: string, init: RequestInit) => Response | Promise<Response> | undefined) | null = null;

  constructor(private publicKey: KeyLike, public now: () => Date = () => new Date()) {}

  fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const body = typeof init.body === "string" ? init.body : "";
    const call = { method, url, body, auth: headers.get("authorization") };
    const o = await this.override?.(url, method, init);
    if (o) { this.calls.push(call); return o; }
    if (url === "https://oauth2.googleapis.com/token") {
      const form = new URLSearchParams(body);
      this.tokenRequests.push(form);
      await jwtVerify(form.get("assertion")!, this.publicKey, { issuer: "rd@scanner.iam.gserviceaccount.com", audience: "https://oauth2.googleapis.com/token" });
      return json(200, { access_token: "ya29.test-token", expires_in: 3599, token_type: "Bearer" });
    }
    if (url === "https://www.googleapis.com/oauth2/v3/certs") return json(200, this.jwks);
    if (url.startsWith("https://hooks.example.com/")) { this.forwarded.push(call); return new Response(null, { status: 202 }); }
    if (!url.startsWith(API)) throw new Error(`unexpected fetch ${url}`);
    this.calls.push(call);
    if (call.auth !== "Bearer ya29.test-token") return googleError(401, "Request had invalid authentication credentials.", "authError");
    const u = new URL(url);
    const path = u.pathname.slice(new URL(API).pathname.length).split("/").map(decodeURIComponent);
    // ["", "purchases", "subscriptionsv2", "tokens", token]
    if (path[1] === "purchases" && path[2] === "subscriptionsv2" && method === "GET") {
      const s = this.subs.get(path[4]!);
      return s ? json(200, { etag: `etag-${s.latestOrderId}-${s.lineItems?.[0]?.expiryTime}`, ...s }) : googleError(404, "The purchase token was not found.", "notFound");
    }
    if (path[1] === "purchases" && path[2] === "subscriptionsv2" && method === "POST") {
      const [token, action] = path[4]!.split(":");
      const s = this.subs.get(token!);
      if (!s) return googleError(404, "The purchase token was not found.", "notFound");
      const li = s.lineItems![0]!;
      const req = body ? JSON.parse(body) : {};
      if (action === "revoke") {
        if (!req.revocationContext) return googleError(400, "revocationContext is required", "subscriptionInvalidArgument");
        s.subscriptionState = "SUBSCRIPTION_STATE_EXPIRED";
        li.expiryTime = this.now().toISOString();
        return json(200, {});
      }
      if (action === "cancel") {
        if (s.subscriptionState === "SUBSCRIPTION_STATE_EXPIRED") return googleError(400, "The subscription has expired.", "subscriptionExpired");
        s.subscriptionState = "SUBSCRIPTION_STATE_CANCELED";
        s.canceledStateContext = { developerInitiatedCancellation: {} };
        li.autoRenewingPlan = { ...li.autoRenewingPlan, autoRenewEnabled: false };
        return json(200, {});
      }
      if (action === "defer") {
        const ctx = req.deferralContext ?? {};
        if (ctx.etag !== `etag-${s.latestOrderId}-${li.expiryTime}`) return googleError(400, "etag mismatch", "subscriptionInvalidArgument");
        const secs = Number(/^(\d+)s$/.exec(ctx.deferDuration ?? "")?.[1]);
        if (!secs) return googleError(400, "deferDuration is required", "subscriptionInvalidArgument");
        li.expiryTime = new Date(new Date(li.expiryTime!).getTime() + secs * 1000).toISOString();
        return json(200, { itemExpiryTimeDetails: [{ productId: li.productId, expiryTime: li.expiryTime }] });
      }
      return googleError(404, "unknown action", "notFound");
    }
    if (path[1] === "purchases" && path[2] === "voidedpurchases") {
      const start = Number(u.searchParams.get("startTime") ?? 0);
      const end = Number(u.searchParams.get("endTime") ?? Infinity);
      return json(200, { voidedPurchases: this.voided.filter((v) => Number(v.voidedTimeMillis) >= start && Number(v.voidedTimeMillis) <= end) });
    }
    if (path[1] === "orders" && method === "POST") {
      const [orderId, action] = path[2]!.split(":");
      if (action !== "refund") return googleError(404, "unknown action", "notFound");
      const revoke = u.searchParams.get("revoke") === "true";
      this.refunds.push({ orderId: orderId!, revoke });
      for (const [, s] of this.subs) {
        if (s.latestOrderId === orderId && revoke) { s.subscriptionState = "SUBSCRIPTION_STATE_EXPIRED"; s.lineItems![0]!.expiryTime = this.now().toISOString(); }
      }
      for (const [, p] of this.products) if (p.orderId === orderId) p.purchaseState = 1;
      return new Response(null, { status: 204 });
    }
    if (path[1] === "purchases" && path[2] === "subscriptions") {
      const [token, action] = path[5]!.split(":");
      if (action === "acknowledge") {
        const s = this.subs.get(token!);
        if (!s) return googleError(404, "not found", "notFound");
        s.acknowledgementState = "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED";
        return new Response(null, { status: 204 });
      }
      const v = this.v1.get(token!);
      return v ? json(200, v) : googleError(404, "not found", "notFound");
    }
    if (path[1] === "purchases" && path[2] === "products") {
      const [token, action] = path[5]!.split(":");
      const p = this.products.get(`${path[3]}|${token}`);
      if (!p) return googleError(400, "Invalid Value", "invalid");
      if (action === "acknowledge") { p.acknowledgementState = 1; return new Response(null, { status: 204 }); }
      return json(200, p);
    }
    if (path[1] === "orders:batchGet") {
      const ids = u.searchParams.getAll("orderIds");
      return json(200, { orders: ids.filter((id) => this.orders.has(id)).map((orderId) => ({ orderId, purchaseToken: this.orders.get(orderId), state: "PROCESSED", ...(this.orderLines.has(orderId) ? { lineItems: this.orderLines.get(orderId) } : {}) })) });
    }
    if (path[1] === "edits" && method === "POST" && path.length === 2) return json(200, { id: "edit-1", expiryTimeSeconds: "1900000000" });
    if (path[1] === "edits" && path[2] === "edit-1" && path[3] === "details" && method === "GET") return json(200, { defaultLanguage: this.defaultLanguage, contactEmail: "dev@example.com" });
    if (path[1] === "edits" && path[2] === "edit-1" && method === "DELETE") return new Response(null, { status: 204 });
    if (path[1] === "subscriptions" && method === "POST" && path.length === 2) {
      const productId = u.searchParams.get("productId")!;
      if (this.created.has(productId)) return googleError(409, `Subscription ${productId} already exists.`, "alreadyExists");
      const req = JSON.parse(body || "{}");
      if (req.productId !== productId || !req.listings?.length) return googleError(400, "productId and listings are required", "invalid");
      this.created.set(productId, req);
      return json(200, { packageName: PKG, productId, listings: req.listings, basePlans: [] });
    }
    return googleError(404, "unknown endpoint", "notFound");
  }) as typeof fetch;

  acks(token: string) { return this.calls.filter((c) => c.method === "POST" && c.url.includes(encodeURIComponent(token)) && c.url.endsWith(":acknowledge")); }
}

export interface SubOpts {
  product?: string; plan?: string; start: Date; expiry: Date; order: string; state?: string; ack?: boolean; test?: boolean;
  offerId?: string; offerTags?: string[]; linked?: string; cancelTime?: Date; replaced?: boolean; autoResume?: Date; price?: number;
}

export function sub(o: SubOpts): SubscriptionPurchaseV2 {
  return {
    kind: "androidpublisher#subscriptionPurchaseV2", regionCode: "US", startTime: o.start.toISOString(),
    subscriptionState: o.state ?? "SUBSCRIPTION_STATE_ACTIVE", latestOrderId: o.order,
    acknowledgementState: o.ack ? "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED" : "ACKNOWLEDGEMENT_STATE_PENDING",
    ...(o.test ? { testPurchase: {} } : {}),
    ...(o.linked ? { linkedPurchaseToken: o.linked } : {}),
    ...(o.cancelTime ? { canceledStateContext: { userInitiatedCancellation: { cancelTime: o.cancelTime.toISOString() } } } : {}),
    ...(o.replaced ? { canceledStateContext: { replacementCancellation: {} } } : {}),
    ...(o.autoResume ? { pausedStateContext: { autoResumeTime: o.autoResume.toISOString() } } : {}),
    lineItems: [{
      productId: o.product ?? "pro", expiryTime: o.expiry.toISOString(), latestSuccessfulOrderId: o.order,
      autoRenewingPlan: { autoRenewEnabled: !o.cancelTime && !o.replaced, recurringPrice: { currencyCode: "USD", units: String(Math.floor(o.price ?? 9.99)), nanos: Math.round(((o.price ?? 9.99) % 1) * 1e9) } },
      offerDetails: { basePlanId: o.plan ?? "monthly", ...(o.offerId ? { offerId: o.offerId } : {}), offerTags: o.offerTags ?? [] },
    }],
  };
}

export interface Env {
  h: Harness; g: FakeGoogle; store: GoogleStore; keys: Keys;
  call: (path: string, init?: RequestInit & { json?: unknown; key?: string | null }) => Promise<Response>;
  receipt: (body: Record<string, unknown>) => Promise<Response>;
  rtdn: (n: Record<string, unknown>, opts?: { messageId?: string; auth?: string }) => Promise<Response>;
  events: (type?: string) => Promise<Array<Record<string, any>>>;
}

/** Contract harness (project, apps, catalog) plus the server wired to a fake Google, with the Play app's credentials set. */
/** `depsFetch: false` leaves Deps.fetch unset (the Node server's default), so outbound calls use the store client's fetch. */
export async function env(keys: Keys, credentials: Record<string, unknown> = {}, opts: { depsFetch?: boolean } = {}): Promise<Env> {
  const h = await harness();
  const g = new FakeGoogle(keys.publicKey, h.now);
  const store = createGoogleStore({ fetch: g.fetch, now: h.now, timeoutMs: 200 });
  const app = createApp({ db: h.db, now: h.now, stores: { ...defaultStores(), play_store: store }, fetch: opts.depsFetch === false ? undefined : g.fetch, encryptionKey: TEST_ENCRYPTION_KEY });
  // The service account is sealed the way the API stores it (services/store-secrets.ts).
  await setAppCredentials(h.db, h.ids.androidApp, "play_store", { service_account: keys.sa, ...credentials });
  const extra = [
    { id: "gp_premium", storeIdentifier: "premium:monthly", type: "subscription", duration: "P1M" },
    { id: "gp_lifetime", storeIdentifier: "lifetime_unlock", type: "non_consumable", duration: null },
    { id: "gp_coins", storeIdentifier: "coins_100", type: "consumable", duration: null },
  ];
  await h.db.insert(schema.products).values(extra.map((p) => ({ ...p, projectId: h.ids.project, appId: h.ids.androidApp, displayName: p.storeIdentifier })));
  await h.db.insert(schema.entitlementProducts).values([{ entitlementId: "ent_pro", productId: "gp_premium" }, { entitlementId: "ent_pro", productId: "gp_lifetime" }]);
  const call: Env["call"] = (path, init = {}) => {
    const headers = new Headers(init.headers);
    if (init.key) headers.set("Authorization", `Bearer ${init.key}`);
    let body = init.body;
    if (init.json !== undefined) { headers.set("content-type", "application/json"); body = JSON.stringify(init.json); }
    return Promise.resolve(app.fetch(new Request(`http://localhost${path}`, { ...init, headers, body })));
  };
  return {
    h, g, store, keys, call,
    receipt: (body) => call("/v1/receipts", { method: "POST", key: h.ids.androidKey, headers: { "X-Platform": "android" }, json: { is_restore: false, observer_mode: false, ...body } }),
    rtdn: (n, opts = {}) => call(`/v1/notifications/google/${h.ids.androidApp}`, {
      method: "POST", headers: opts.auth ? { authorization: opts.auth } : {},
      json: {
        message: {
          data: btoa(JSON.stringify({ version: "1.0", packageName: PKG, eventTimeMillis: String(h.now().getTime()), ...n })),
          messageId: opts.messageId ?? crypto.randomUUID(), publishTime: h.now().toISOString(),
        },
        subscription: "projects/scanner/subscriptions/play-rtdn",
      },
    }),
    events: async (type) => {
      const rows = await h.db.select().from(schema.events);
      return rows.map((r) => (r.payload as { event: Record<string, any> }).event).filter((e) => !type || e.type === type);
    },
  };
}

/** A Google-signed-looking OIDC token for Pub/Sub push, signed with the test key and published through the fake certs. */
export async function pushToken(keys: Keys, g: FakeGoogle, aud: string, email = "pubsub@scanner.iam.gserviceaccount.com") {
  g.jwks = { keys: [{ ...(await exportJWK(keys.publicKey)), kid: "push-1", alg: "RS256", use: "sig" }] };
  return new SignJWT({ email, email_verified: true }).setProtectedHeader({ alg: "RS256", kid: "push-1" })
    .setIssuer("https://accounts.google.com").setAudience(aud).setIssuedAt().setExpirationTime("1h").sign(keys.privateKey);
}
