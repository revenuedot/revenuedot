/**
 * A stateful fake of Samsung's in-app purchase server APIs for one seller: the receipt API (no auth), access tokens from a
 * service account JWT (`POST /auth/accessToken`), the subscription API (GET and PATCH cancel | refund | revoke), the
 * publish API's item list, and Instant Server Notifications signed with the seller's IAP key (RS256 JWTs). Shapes from
 * https://developer.samsung.com/iap/programming-guide/samsung-iap-server-api.html, /iap/api/iap-subscription-api.html,
 * /galaxy-store/galaxy-store-developer-api/create-an-access-token.html, /iap/api/iap-publish-api.html and
 * /iap/isn/jwt/payload.html. Lifecycle helpers move a subscription the way Samsung would and return the notifications it
 * would send. Used by the server tests, the dashboard's e2e server and the journeys. It never calls Samsung.
 * Its key pairs are generated when the fake starts (`await fake.keys()`), so no key is ever committed.
 */

export const FAKE_GALAXY_PACKAGE = "com.example.scanner.galaxy";
export const FAKE_GALAXY_ACCOUNT = "fake-galaxy-service-account-0001";

type Obj = Record<string, any>;
const DAY = 86_400_000;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const b64url = (b: Uint8Array | string) => {
  const bytes = typeof b === "string" ? new TextEncoder().encode(b) : b;
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
const pemBody = (pem: string) => Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")), (c) => c.charCodeAt(0));
const gmt = (d: Date) => d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
const hex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");
let orderSeq = 0;
const orderId = (d: Date) => `S${d.toISOString().slice(0, 10).replace(/-/g, "")}USA${String(++orderSeq).padStart(7, "0")}`;

export async function rsaSign(privatePem: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey("pkcs8", pemBody(privatePem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(payload))));
}
async function rsaVerify(publicPem: string, jwt: string): Promise<Obj | null> {
  const [h, p, s] = jwt.split(".");
  if (!h || !p || !s) return null;
  const key = await crypto.subtle.importKey("spki", pemBody(publicPem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, fromB64url(s), new TextEncoder().encode(`${h}.${p}`));
  return ok ? JSON.parse(new TextDecoder().decode(fromB64url(p))) : null;
}

export interface GalaxyIsn { body: string; claims: Obj }

const toPem = (label: string, der: ArrayBuffer) => `-----BEGIN ${label}-----\n${btoa(String.fromCharCode(...new Uint8Array(der))).replace(/(.{64})/g, "$1\n").replace(/\n$/, "")}\n-----END ${label}-----\n`;
async function rsaPair() {
  const k = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  return { privatePem: toPem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", k.privateKey)), publicPem: toPem("PUBLIC KEY", await crypto.subtle.exportKey("spki", k.publicKey)) };
}
export interface GalaxyKeys { serviceAccountPrivateKey: string; serviceAccountPublicKey: string; iapPrivateKey: string; iapPublicKey: string }

export class FakeGalaxy {
  packageName = FAKE_GALAXY_PACKAGE;
  /** Service accounts: id → public key PEM. */
  accounts = new Map<string, string>();
  /** Service accounts whose tokens may not read purchases (NO_PERMISSION). */
  noPermission = new Set<string>();
  tokens = new Map<string, string>();
  receipts = new Map<string, Obj>();
  /** Subscription chains by their first purchase id, and every purchase id of a chain → its first purchase id. */
  subscriptions = new Map<string, Obj>();
  chainOf = new Map<string, string>();
  items: Obj[] = [];
  actions: Array<{ purchaseId: string; action: string }> = [];
  calls: Array<{ url: string; method: string }> = [];
  outage: number | null = null;
  now: () => Date = () => new Date();

  private generated: Promise<GalaxyKeys> | null = null;

  constructor(o: { now?: () => Date; packageName?: string } = {}) {
    if (o.now) this.now = o.now;
    if (o.packageName) this.packageName = o.packageName;
  }

  /** The service account's and the IAP key pairs (made once per fake); the service account is registered as FAKE_GALAXY_ACCOUNT. */
  keys(): Promise<GalaxyKeys> {
    this.generated ??= Promise.all([rsaPair(), rsaPair()]).then(([sa, iap]) => {
      this.accounts.set(FAKE_GALAXY_ACCOUNT, sa.publicPem);
      return { serviceAccountPrivateKey: sa.privatePem, serviceAccountPublicKey: sa.publicPem, iapPrivateKey: iap.privatePem, iapPublicKey: iap.publicPem };
    });
    return this.generated;
  }

  /** An in-app item in Seller Portal (for the item list). */
  item(id: string, title: string, usdPrice = 0.99) {
    const i = { id, title, description: title, type: "ITEM", status: "PUBLISHED", itemPaymentMethod: { phoneBillStatus: true }, usdPrice, prices: [{ countryId: "USA", currency: "USD", localPrice: String(usdPrice) }] };
    this.items.push(i);
    return i;
  }

  private receipt(o: { itemId: string; type: "Item" | "Subscription"; amount: number; currency?: string; test?: boolean; at?: Date }) {
    const at = o.at ?? this.now();
    const purchaseId = hex(32);
    const r: Obj = {
      itemId: o.itemId, paymentId: `${at.toISOString().replace(/\D/g, "").slice(0, 17)}TRAN`, orderId: orderId(at), packageName: this.packageName, itemName: o.itemId, itemDesc: o.itemId,
      itemType: o.type, countryCode: "USA", purchaseDate: gmt(at), paymentAmount: o.amount.toFixed(3), status: "success", paymentMethod: "Credit Card",
      mode: o.test ? "TEST" : "PRODUCTION", consumeYN: "N", consumeDate: "", consumeDeviceModel: "", acknowledgeYN: "N", currencyCode: o.currency ?? "USD", currencyUnit: "$",
      obfuscatedAccountId: hex(32), obfuscatedProfileId: "",
    };
    this.receipts.set(purchaseId, r);
    return { purchaseId, receipt: r };
  }

  // ---- Lifecycle ----------------------------------------------------------------------------------------------------
  buyItem(itemId: string, o: { amount?: number; test?: boolean } = {}): { purchaseId: string; notifications: Obj[] } {
    const { purchaseId, receipt } = this.receipt({ itemId, type: "Item", amount: o.amount ?? 0.99, test: o.test });
    return { purchaseId, notifications: [this.n("ITEM_PURCHASED", { itemId, orderId: receipt.orderId, purchaseId, testPayYn: o.test ? "Y" : "N", betaTestYn: "N" })] };
  }
  /** A subscription of `months` per period (`trialDays` free first, `intro` for a tiered first price). */
  subscribe(itemId: string, o: { amount?: number; months?: number; trialDays?: number; intro?: boolean; test?: boolean } = {}): { purchaseId: string; notifications: Obj[] } {
    const now = this.now();
    const amount = o.amount ?? 4.99;
    const { purchaseId, receipt } = this.receipt({ itemId, type: "Subscription", amount: o.trialDays ? 0 : amount, test: o.test });
    const months = o.months ?? 1;
    const end = o.trialDays ? new Date(now.getTime() + o.trialDays * DAY) : new Date(new Date(now).setUTCMonth(now.getUTCMonth() + months));
    const s: Obj = {
      subscriptionPurchaseDate: `${gmt(now)} GMT`, subscriptionEndDate: `${gmt(end)} GMT`, subscriptionStatus: "ACTIVE", subscriptionFirstPurchaseID: purchaseId,
      countryCode: "USA", price: { localCurrencyCode: "USD", localPrice: o.trialDays ? 0 : amount, supplyPrice: Math.round(amount * 0.7 * 100) / 100 }, itemID: itemId, itemTitle: itemId,
      freeTrial: o.trialDays ? "Y" : o.intro ? "T" : "N", realMode: o.test ? "N" : "Y", latestOrderId: receipt.orderId, latestRenewalDate: null,
      totalNumberOfTieredPayment: o.intro ? "1" : "0", currentPaymentPlan: o.trialDays ? "F" : o.intro ? "T" : "R", totalNumberOfRenewalPayment: "0",
      cancelSubscriptionDate: null, cancelSubscriptionReason: null, gracePeriodYN: "N", gracePeriodEndDate: null, priceChange: null,
      __months: months, __amount: amount, __test: !!o.test,
    };
    this.subscriptions.set(purchaseId, s);
    this.chainOf.set(purchaseId, purchaseId);
    return { purchaseId, notifications: [this.n("ARS_SUBSCRIBED", { itemId, orderId: receipt.orderId, purchaseId, paymentPlan: o.trialDays ? "FreeTrial" : o.intro ? "TieredPrice" : "Regular", scheduledTimeOfRenewal: Math.floor(end.getTime() / 1000), validUntil: Math.floor(end.getTime() / 1000), testPayYn: o.test ? "Y" : "N", betaTestYn: "N" })] };
  }
  sub(first: string) { return this.subscriptions.get(first)!; }
  private end(s: Obj) { return new Date(`${s.subscriptionEndDate.replace(" GMT", "").replace(" ", "T")}Z`); }
  private flags(s: Obj) { return { testPayYn: s.__test ? "Y" : "N", betaTestYn: "N" }; }
  /** Samsung charges the next period: a new purchase id and order id on the same chain. */
  renew(first: string, event = "ARS_RENEWED"): { purchaseId: string; notifications: Obj[] } {
    const s = this.sub(first);
    const start = this.end(s);
    const { purchaseId, receipt } = this.receipt({ itemId: s.itemID, type: "Subscription", amount: s.__amount, test: s.__test, at: start });
    const end = new Date(new Date(start).setUTCMonth(start.getUTCMonth() + s.__months));
    Object.assign(s, { subscriptionEndDate: `${gmt(end)} GMT`, latestOrderId: receipt.orderId, latestRenewalDate: `${gmt(start)} GMT`, currentPaymentPlan: "R", freeTrial: "N", gracePeriodYN: "N", gracePeriodEndDate: null, subscriptionStatus: "ACTIVE",
      totalNumberOfRenewalPayment: String(Number(s.totalNumberOfRenewalPayment) + 1), price: { ...s.price, localPrice: s.__amount } });
    this.chainOf.set(purchaseId, first);
    return { purchaseId, notifications: [this.n(event, { itemId: s.itemID, firstOrderId: this.receipts.get(first)!.orderId, firstPurchaseId: first, renewedOrderId: receipt.orderId, renewedPurchaseId: purchaseId, paymentPlan: "Regular", scheduledTimeOfRenewal: Math.floor(end.getTime() / 1000), validUntil: Math.floor(end.getTime() / 1000), ...this.flags(s) })] };
  }
  unsubscribe(first: string): Obj[] {
    const s = this.sub(first);
    Object.assign(s, { subscriptionStatus: "CANCEL", cancelSubscriptionDate: `${gmt(this.now())} GMT`, cancelSubscriptionReason: "1" });
    return [this.n("ARS_UNSUBSCRIBED", { firstOrderId: this.receipts.get(first)!.orderId, firstPurchaseId: first, validUntil: Math.floor(this.end(s).getTime() / 1000), ...this.flags(s) })];
  }
  /** Resubscribed within the paid period: the same chain is active again. */
  resubscribe(first: string): Obj[] {
    const s = this.sub(first);
    Object.assign(s, { subscriptionStatus: "ACTIVE", cancelSubscriptionDate: null, cancelSubscriptionReason: null });
    return [this.n("ARS_RESUBSCRIBED", { itemId: s.itemID, resubscribedOrderId: s.latestOrderId, resubscribedPurchaseId: first, paymentPlan: "Regular", scheduledTimeOfRenewal: Math.floor(this.end(s).getTime() / 1000), validUntil: Math.floor(this.end(s).getTime() / 1000), ...this.flags(s) })];
  }
  /** The renewal charge failed: Samsung's grace period keeps access for `days`. */
  grace(first: string, days = 7): Obj[] {
    const s = this.sub(first);
    const start = this.end(s);
    const until = new Date(start.getTime() + days * DAY);
    Object.assign(s, { gracePeriodYN: "Y", gracePeriodEndDate: `${gmt(until)} GMT` });
    return [this.n("ARS_IN_GRACE_PERIOD", { itemId: s.itemID, firstOrderId: this.receipts.get(first)!.orderId, firstPurchaseId: first, gracePeriodStartDate: Math.floor(start.getTime() / 1000), gracePeriodEndDate: Math.floor(until.getTime() / 1000), ...this.flags(s) })];
  }
  /** Grace ended without a payment: the subscription is cancelled and ends at its end date. */
  lapse(first: string): Obj[] {
    const s = this.sub(first);
    Object.assign(s, { gracePeriodYN: "N", gracePeriodEndDate: null, subscriptionStatus: "CANCEL", cancelSubscriptionDate: `${gmt(this.now())} GMT`, cancelSubscriptionReason: "2" });
    return [this.n("ARS_UNSUBSCRIBED", { firstOrderId: this.receipts.get(first)!.orderId, firstPurchaseId: first, validUntil: Math.floor(this.end(s).getTime() / 1000), ...this.flags(s) })];
  }
  /** A refund of the latest payment; Samsung cancels the subscription. */
  refund(first: string): Obj[] {
    const s = this.sub(first);
    const order = s.latestOrderId;
    const pid = [...this.receipts.entries()].find(([, r]) => r.orderId === order)?.[0] ?? first;
    this.receipts.get(pid)!.status = "cancel"; this.receipts.get(pid)!.cancelDate = gmt(this.now());
    Object.assign(s, { subscriptionStatus: "CANCEL", cancelSubscriptionDate: `${gmt(this.now())} GMT`, subscriptionEndDate: `${gmt(this.now())} GMT` });
    return [this.n("ARS_REFUNDED", { firstOrderId: this.receipts.get(first)!.orderId, firstPurchaseId: first, refundedOrderId: order, refundedPurchaseId: pid, refundedPurchaseDate: Math.floor(this.now().getTime() / 1000), ...this.flags(s) })];
  }
  refundItem(purchaseId: string): Obj[] {
    const r = this.receipts.get(purchaseId)!;
    r.status = "cancel"; r.cancelDate = gmt(this.now());
    return [this.n("ITEM_REFUNDED", { orderId: r.orderId, purchaseId, testPayYn: r.mode === "TEST" ? "Y" : "N", betaTestYn: "N" })];
  }
  /** A plan change: a new subscription for `itemId`; the old one ends now (or at its renewal when `deferred`). */
  upDowngrade(first: string, itemId: string, o: { amount?: number; deferred?: boolean } = {}): { purchaseId: string; notifications: Obj[] } {
    const old = this.sub(first);
    const switchAt = o.deferred ? this.end(old) : this.now();
    Object.assign(old, { subscriptionStatus: "CANCEL", cancelSubscriptionDate: `${gmt(this.now())} GMT`, subscriptionEndDate: `${gmt(switchAt)} GMT` });
    const saved = this.now;
    this.now = () => switchAt;
    const next = this.subscribe(itemId, { amount: o.amount ?? 9.99, test: old.__test });
    this.now = saved;
    const s = this.sub(next.purchaseId);
    return { purchaseId: next.purchaseId, notifications: [this.n("ARS_UPDOWNGRADED", {
      oldItemId: old.itemID, oldPaymentPlan: "Regular", oldOrderId: old.latestOrderId, oldPurchaseId: first, newItemId: itemId, newPaymentPlan: "Regular", newOrderId: s.latestOrderId, newPurchaseId: next.purchaseId,
      scheduledTimeOfRenewal: Math.floor(switchAt.getTime() / 1000), validUntil: Math.floor(this.end(s).getTime() / 1000), ...this.flags(old),
    })] };
  }
  priceChangeAgreed(first: string): Obj[] {
    const s = this.sub(first);
    s.priceChange = { agreeYN: "Y" };
    return [this.n("ARS_PRICECHANGE_AGREED", { itemId: s.itemID, firstOrderId: this.receipts.get(first)!.orderId, firstPurchaseId: first, agreeYn: "Y", ...this.flags(s) })];
  }
  test(): Obj[] { return [this.n("TEST", { sellerName: "Example Seller", contentName: "Scanner" })]; }

  // ---- Notifications ------------------------------------------------------------------------------------------------
  n(event: string, data: Obj): Obj {
    const iat = Math.floor(this.now().getTime() / 1000) + Math.floor(Math.random() * 1000) / 1000;
    return { iss: "iap.samsungapps.com", sub: event, aud: [this.packageName], iat: Math.floor(iat), nbf: Math.floor(iat), version: "2.0", data, __nonce: hex(4) };
  }
  /** The body Samsung POSTs: an RS256 JWT signed with the seller's IAP private key (or `key`). */
  async sign(claims: Obj, o: { key?: string; issuer?: string; audience?: string[] } = {}): Promise<GalaxyIsn> {
    const { __nonce, ...c } = claims;
    const out: Obj = { ...c, ...(o.issuer ? { iss: o.issuer } : {}), ...(o.audience ? { aud: o.audience } : {}) };
    // The nonce keeps two notifications of the same event in one second apart (Samsung's iat is in seconds).
    if (__nonce) out.jti = __nonce;
    const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const body = b64url(JSON.stringify(out));
    return { body: `${head}.${body}.${await rsaSign(o.key ?? (await this.keys()).iapPrivateKey, `${head}.${body}`)}`, claims: out };
  }

  // ---- HTTP -----------------------------------------------------------------------------------------------------------
  fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init.method ?? "GET").toUpperCase();
    this.calls.push({ url, method });
    const u = new URL(url);
    if (this.outage) return json(this.outage, { code: "SERVER_ERROR", message: "Samsung is unavailable" });
    if (u.hostname === "iap.samsungapps.com" && u.pathname === "/iap/v6/receipt") {
      const id = u.searchParams.get("purchaseID") ?? "";
      if (!/^[0-9a-f]{16,64}$/i.test(id)) return json(200, { status: "fail", errorCode: 9153, errorMessage: "Invalid purchaseID" });
      const r = this.receipts.get(id);
      return r ? json(200, r) : json(200, { status: "fail", errorCode: 9135, errorMessage: "not exist order" });
    }
    if (u.hostname !== "devapi.samsungapps.com") return json(502, { message: "unexpected host" });
    const auth = (new Headers(init.headers).get("authorization") ?? "").replace(/^Bearer\s+/, "");
    if (u.pathname === "/auth/accessToken" && method === "POST") {
      await this.keys();
      const [h, p] = auth.split(".");
      let claims: Obj | null = null;
      try { claims = JSON.parse(new TextDecoder().decode(fromB64url(p ?? ""))); } catch { /* below */ }
      const pub = claims && typeof claims.iss === "string" ? this.accounts.get(claims.iss) : undefined;
      const verified = pub && h ? await rsaVerify(pub, auth) : null;
      if (!verified || !Array.isArray(verified.scopes) || typeof verified.exp !== "number") return json(401, { code: "AUTH_REQUIRE", message: "Invalid JWT", from: "asgw" });
      const token = `fakeGalaxyToken${hex(12)}`;
      this.tokens.set(token, verified.iss);
      return json(200, { ok: true, createdItem: { accessToken: token, userId: "0", clientId: verified.iss, createdAt: Date.now(), scopes: verified.scopes, type: "SERVICE" } });
    }
    const account = this.tokens.get(auth);
    if (!account || new Headers(init.headers).get("service-account-id") !== account) return json(401, { code: "AUTH_REQUIRE", message: "Invalid accessToken", from: "asgw" });
    if (this.noPermission.has(account)) return json(403, { code: "NO_PERMISSION", message: "No permission to access" });
    const sub = /^\/iap\/seller\/v6\/applications\/([^/]+)\/purchases\/subscriptions\/([^/]+)$/.exec(u.pathname);
    if (sub) {
      if (decodeURIComponent(sub[1]!) !== this.packageName) return json(400, { code: "SLR_4006", message: "Not your content" });
      const pid = decodeURIComponent(sub[2]!);
      const first = this.chainOf.get(pid);
      if (!first) return json(400, { code: "SLR_4008", message: "Invalid purchase id" });
      const s = this.subscriptions.get(first)!;
      if (method === "PATCH") {
        const b = JSON.parse(typeof init.body === "string" ? init.body : "{}");
        this.actions.push({ purchaseId: pid, action: b.action });
        if (b.action === "cancel") this.unsubscribe(first);
        else if (b.action === "refund" || b.action === "revoke") this.refund(first);
        return json(200, { code: "0000", message: "Success" });
      }
      const { __months: _m, __amount: _a, __test: _t, ...out } = s;
      return json(200, out);
    }
    const items = /^\/iap\/v6\/applications\/([^/]+)\/items$/.exec(u.pathname);
    if (items && method === "GET") {
      if (decodeURIComponent(items[1]!) !== this.packageName) return json(400, { code: "SLR_4006", message: "Not your content" });
      const page = Number(u.searchParams.get("page") ?? 1), size = Number(u.searchParams.get("size") ?? 20);
      return json(200, { itemList: this.items.slice((page - 1) * size, page * size), totalCount: this.items.length });
    }
    return json(404, { code: "NOT_FOUND", message: `${method} ${u.pathname}` });
  }) as typeof fetch;
}
