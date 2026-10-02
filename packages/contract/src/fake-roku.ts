/**
 * A stateful fake of Roku Pay for one developer account: `validate-transaction` in Roku's JSON shape (WCF dates,
 * `OriginalTransactionId`, `status` 0/1, UNAUTHORIZED with HTTP 200, "Invalid URI format." with HTTP 400), Roku's published
 * key sets (`assets.cs.roku.com/keys/partner-jwks.json` and the test set), and signed push notifications (RS256 JWS with
 * `x-Roku-message` as base64 JSON). Lifecycle helpers move a subscription the way Roku would and return the pushes Roku
 * would send (https://developer.roku.com/dev/docs/roku-web-service, /push-notifications-jwt, /subscription-on-hold).
 * Used by the server tests, the dashboard's e2e server and the journeys. It never calls Roku.
 */

export const FAKE_ROKU_KEY = "FAKEROKUPAYKEY0123456789ABCDEF012";
export const FAKE_ROKU_CHANNEL = "765432";
export const ROKU_KID = "ROKU-PARTNER-SERVICE-2021-08-05-10-20";
export const ROKU_TEST_KID = "ROKU-PARTNER-SERVICE-TEST-2021-08-05-10-20";
const ISSUER = "Roku, Inc. urn:roku:apps:partner-service.roku.com";
const DAY = 86_400_000;

type Obj = Record<string, any>;
const wcf = (d: Date | null) => (d ? `/Date(${d.getTime()}+0000)/` : null);
const isoZ = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const b64url = (b: Uint8Array | string) => {
  const bytes = typeof b === "string" ? new TextEncoder().encode(b) : b;
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const hex32 = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

export interface RokuPush { body: string; message: Obj }

interface KeyPair { kid: string; priv: CryptoKey; jwk: JsonWebKey }

export class FakeRoku {
  keys = new Set([FAKE_ROKU_KEY]);
  channelId = FAKE_ROKU_CHANNEL;
  channelName = "Scanner TV";
  transactions = new Map<string, Obj>();
  calls: Array<{ url: string; method: string }> = [];
  /** Answer validate-transaction with this HTTP status (Roku down, rate limited). */
  outage: number | null = null;
  now: () => Date = () => new Date();
  private pairs: Promise<{ prod: KeyPair; test: KeyPair; other: KeyPair }> | null = null;

  constructor(o: { now?: () => Date } = {}) { if (o.now) this.now = o.now; }

  private keyPairs() {
    const make = async (kid: string): Promise<KeyPair> => {
      const k = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
      const jwk = await crypto.subtle.exportKey("jwk", k.publicKey) as JsonWebKey;
      return { kid, priv: k.privateKey, jwk: { kty: jwk.kty, n: jwk.n, e: jwk.e, kid, use: "sig", alg: "RS256" } as JsonWebKey };
    };
    // `other` signs with Roku's production kid but a key Roku never published: a forged push.
    this.pairs ??= Promise.all([make(ROKU_KID), make(ROKU_TEST_KID), make(ROKU_KID)]).then(([prod, test, other]) => ({ prod, test, other }));
    return this.pairs;
  }

  // ---- Transactions -----------------------------------------------------------------------------------------------
  private txn(o: { product: string; price: number; original?: string | null; start: Date; end: Date | null; originalStart?: Date; purchaseType?: string | null; cancelledIds?: string[] | null; status?: string; customer?: string }) {
    const id = hex32();
    const t: Obj = {
      errorCode: null, errorDetails: null, errorMessage: "", status: 0,
      OriginalTransactionId: o.original ?? id, amount: o.price, cancelled: false, cancelledTransactionIds: o.cancelledIds ?? null,
      channelId: this.channelId, channelName: this.channelName, couponCode: null, currency: "usd",
      expirationDate: wcf(o.end), isEntitled: true, originalPurchaseDate: wcf(o.originalStart ?? o.start), partnerReferenceId: null,
      productId: o.product, productName: o.product, purchaseDate: wcf(o.start), purchaseStatus: o.status ?? "Active", purchaseType: o.purchaseType ?? null,
      purchaseChannel: "device", purchaseContext: "iap", quantity: 1, rokuCustomerId: o.customer ?? hex32(), tax: 0, total: o.price, transactionId: id, isDunning: null,
    };
    this.transactions.set(id, t);
    return t;
  }
  /** The newest transaction of a subscription (by its original transaction id). */
  latest(chain: string) {
    return [...this.transactions.values()].filter((t) => t.OriginalTransactionId === chain && t.purchaseStatus !== "PendingActive").at(-1)!;
  }
  private msg(type: string, t: Obj, extra: Obj = {}): Obj {
    const exp = t.expirationDate ? new Date(Number(/\d+/.exec(t.expirationDate)![0])) : null;
    return {
      customerId: t.rokuCustomerId, transactionType: type, transactionId: t.transactionId, originalTransactionId: t.OriginalTransactionId,
      channelId: t.channelId, channelName: t.channelName, productCode: t.productId, productName: t.productName, price: t.amount, tax: 0, total: t.total, currency: t.currency,
      isFreeTrial: t.total === 0, expirationDate: exp ? isoZ(exp) : null, originalPurchaseDate: t.originalPurchaseDate ? isoZ(new Date(Number(/\d+/.exec(t.originalPurchaseDate)![0]))) : null,
      eventDate: isoZ(this.now()), comments: "", responseKey: hex32(), purchaseChannel: "DEVICE", purchaseContext: "IAP", ...extra,
    };
  }

  /** A purchase on the device: a subscription (`months` per period, `trialDays` free first) or a one-time product (`months: 0`). */
  buy(product: string, o: { price?: number; months?: number; trialDays?: number } = {}): { transaction: Obj; pushes: Obj[] } {
    const now = this.now();
    const months = o.months ?? 1;
    const end = months === 0 ? null : o.trialDays ? new Date(now.getTime() + o.trialDays * DAY) : new Date(new Date(now).setUTCMonth(now.getUTCMonth() + months));
    const t = this.txn({ product, price: o.trialDays ? 0 : o.price ?? 4.99, start: now, end });
    t.__months = months; t.__price = o.price ?? 4.99;
    return { transaction: t, pushes: [this.msg("Sale", t, { comments: "New order processed." })] };
  }
  /** Roku charges the next period: a new transaction of the same subscription. */
  renew(chain: string, type = "Sale"): { transaction: Obj; pushes: Obj[] } {
    const cur = this.latest(chain);
    const start = new Date(Number(/\d+/.exec(cur.expirationDate)![0]));
    const months = cur.__months ?? 1;
    const t = this.txn({ product: cur.productId, price: cur.__price ?? cur.total, original: chain, start, end: new Date(new Date(start).setUTCMonth(start.getUTCMonth() + months)), originalStart: new Date(Number(/\d+/.exec(cur.originalPurchaseDate)![0])), customer: cur.rokuCustomerId });
    t.__months = months; t.__price = cur.__price;
    return { transaction: t, pushes: [this.msg(type, t, { comments: "Recurring subscription processed" })] };
  }
  /** The renewal charge failed: 3 days of grace with access (the expiry has passed, still entitled). */
  grace(chain: string): Obj[] { const t = this.latest(chain); t.isEntitled = true; t.isDunning = true; return [this.msg("GraceInitiated", t)]; }
  /** Grace ran out: on hold, no access. */
  onHold(chain: string): Obj[] { const t = this.latest(chain); t.isEntitled = false; t.isDunning = true; return [this.msg("OnHoldInitiated", t)]; }
  /** The customer turned renewal off; access to the expiry. */
  cancel(chain: string): Obj[] { const t = this.latest(chain); t.cancelled = true; return [this.msg("Cancellation", t)]; }
  resubscribe(chain: string): Obj[] { const t = this.latest(chain); t.cancelled = false; return [this.msg("Resubscribe", t)]; }
  /** A refund of one transaction (negative amounts in the push). */
  refund(transactionId: string): Obj[] {
    const t = this.transactions.get(transactionId)!;
    t.cancelled = true; t.isEntitled = false;
    return [this.msg("Refund", t, { price: -t.amount, total: -t.total, tax: 0, expirationDate: null, partnerReferenceId: "refund-1", comments: "Refund processed." })];
  }
  /** An upgrade, effective now: a new subscription that replaces the current one. */
  upgrade(chain: string, product: string, price = 9.99): { transaction: Obj; pushes: Obj[] } {
    const old = this.latest(chain);
    const now = this.now();
    old.cancelled = true; old.isEntitled = false;
    const t = this.txn({ product, price, start: now, end: new Date(new Date(now).setUTCMonth(now.getUTCMonth() + 1)), purchaseType: "UPGRADE", cancelledIds: [old.transactionId], customer: old.rokuCustomerId });
    t.__months = 1; t.__price = price;
    return { transaction: t, pushes: [this.msg("UpgradeSale", t), this.msg("UpgradeCancellation", old)] };
  }
  /** A downgrade: a $0 pending transaction that starts when the current period ends; the current plan does not renew. */
  downgrade(chain: string, product: string): { transaction: Obj; pushes: Obj[] } {
    const old = this.latest(chain);
    old.cancelled = true;
    const start = new Date(Number(/\d+/.exec(old.expirationDate)![0]));
    const t = this.txn({ product, price: 0, start, end: start, purchaseType: "DOWNGRADE", cancelledIds: [old.transactionId], status: "PendingActive", customer: old.rokuCustomerId });
    return { transaction: t, pushes: [this.msg("DowngradeSale", t), this.msg("DowngradeCancellation", old)] };
  }
  /** A push type that changes nothing RevenueDot records (Credit, Chargeback …). */
  other(type: string, transactionId: string): Obj[] { return [this.msg(type, this.transactions.get(transactionId)!)]; }

  // ---- Pushes -------------------------------------------------------------------------------------------------------
  /** The body Roku POSTs: a compact JWS. `test` signs with the test key set, `forged` with a key Roku never published. */
  async sign(message: Obj, o: { test?: boolean; forged?: boolean; issuer?: string; type?: string; at?: Date; urlSafe?: boolean } = {}): Promise<RokuPush> {
    const pairs = await this.keyPairs();
    const pair = o.forged ? pairs.other : o.test ? pairs.test : pairs.prod;
    const iat = Math.floor((o.at ?? this.now()).getTime() / 1000);
    const raw = new TextEncoder().encode(JSON.stringify(message));
    // Roku's own sample decodes standard base64; both alphabets are accepted.
    const encoded = o.urlSafe ? b64url(raw) : btoa(String.fromCharCode(...raw));
    const claims = { iss: o.issuer ?? ISSUER, iat, exp: iat + 86_400, nbf: iat - 3600, "x-Roku-message": encoded, "x-Roku-message-encoding": "base64-utf8", "x-Roku-message-key": hex32(), "x-Roku-message-type": o.type ?? "roku.rpay.push" };
    const head = b64url(JSON.stringify({ typ: "JWT", alg: "RS256", kid: pair.kid }));
    const body = b64url(JSON.stringify(claims));
    const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.priv, new TextEncoder().encode(`${head}.${body}`)));
    return { body: `${head}.${body}.${b64url(sig)}`, message };
  }

  // ---- HTTP -----------------------------------------------------------------------------------------------------------
  fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    this.calls.push({ url, method: (init.method ?? "GET").toUpperCase() });
    const u = new URL(url);
    if (u.hostname === "assets.cs.roku.com") {
      const pairs = await this.keyPairs();
      if (u.pathname === "/keys/partner-jwks.json") return json(200, { keys: [pairs.prod.jwk] });
      if (u.pathname === "/keys/partner-jwks-test.json") return json(200, { keys: [pairs.test.jwk] });
      return new Response("Not found", { status: 404 });
    }
    if (u.hostname !== "apipub.roku.com") return new Response("unexpected host", { status: 502 });
    if (this.outage) return new Response("", { status: this.outage });
    const m = /\/listen\/transaction-service\.svc\/validate-transaction\/([^/]+)\/([^/]+)$/.exec(u.pathname);
    if (!m) return new Response("Endpoint not found.", { status: 404 });
    const key = decodeURIComponent(m[1]!), id = decodeURIComponent(m[2]!);
    if (!/^([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(id)) return new Response("Invalid URI format.", { status: 400, headers: { "content-type": "text/plain" } });
    const empty = { errorCode: null, errorDetails: null, transactionId: null, rokuCustomerId: null, purchaseDate: null, channelId: 0, channelName: null, productName: null, productId: null, amount: null, tax: null, total: null, currency: null, quantity: 0, expirationDate: null, originalPurchaseDate: null, OriginalTransactionId: null, partnerReferenceId: null, couponCode: null, cancelled: false, isEntitled: false, purchaseType: null, purchaseChannel: null, purchaseContext: null, cancelledTransactionIds: null, purchaseStatus: null, isDunning: null };
    if (!this.keys.has(key)) return json(200, { ...empty, errorMessage: "UNAUTHORIZED", status: 1 });
    const t = this.transactions.get(id.replace(/-/g, "")) ?? this.transactions.get(id);
    if (!t) return json(200, { ...empty, errorMessage: "Invalid transaction id", status: 1 });
    const { __months: _m, __price: _p, ...out } = t;
    return json(200, out);
  }) as typeof fetch;
}
