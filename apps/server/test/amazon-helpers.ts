/** Test helpers for the Amazon Appstore adapter: a fake RVS, a throwaway SNS signing certificate and an Amazon app. */
import { schema } from "@revenuedot/db";
import { harness, type Harness } from "../../../packages/contract/src/harness.js";
import { createApp } from "../src/app.js";
import { defaultStores } from "../src/stores/index.js";
import { createAmazonStore, type AmazonStore } from "../src/stores/amazon/index.js";
import type { AmazonReceipt } from "../src/stores/amazon/api.js";
import { stringToSign, type SnsMessage } from "../src/stores/amazon/sns.js";
import { der, toPem } from "./apple-fixtures.js";

export const PKG = "com.example.scanner";
export const SECRET = "2:smOvHE5Y-test-shared-secret:Xg==";
export const AMZ_USER = "amzn1.account.AGXYZTESTUSER";
export const CERT_URL = "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-test.pem";
export const TOPIC = "arn:aws:sns:us-east-1:123456789012:amazon-rtn-test";
export const DAY = 86_400_000;
export const T0 = new Date("2026-09-01T12:00:00Z");
export const at = (days: number) => new Date(T0.getTime() + days * DAY);

// ---------- A self-signed RSA certificate like SNS's signing certificate ----------

export interface SnsKeys { pem: string; sha1: CryptoKey; sha256: CryptoKey }

export async function makeSnsKeys(o: { notAfter?: Date } = {}): Promise<SnsKeys> {
  const kp = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const name = der.seq(der.set(der.seq(der.oid("2.5.4.3"), der.utf8("sns.amazonaws.com"))));
  const sigAlg = der.seq(der.oid("1.2.840.113549.1.1.11"), der.null());
  const tbs = der.seq(
    der.ctx(0, der.int(2)), der.int(4242), sigAlg, name,
    der.seq(der.time(new Date("2020-01-01T00:00:00Z")), der.time(o.notAfter ?? new Date("2040-01-01T00:00:00Z"))),
    name, new Uint8Array(await crypto.subtle.exportKey("spki", kp.publicKey)),
  );
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey, new Uint8Array(tbs)));
  const cert = der.seq(tbs, sigAlg, der.bits(sig));
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", kp.privateKey);
  const sha1 = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-1" }, false, ["sign"]);
  return { pem: toPem(cert), sha1, sha256: kp.privateKey };
}

let messageSeq = 0;

/** An SNS message signed the way SNS signs it (SignatureVersion 1 = SHA-1, 2 = SHA-256). */
export async function snsMessage(keys: SnsKeys, o: { type?: SnsMessage["Type"]; message: unknown; messageId?: string; version?: "1" | "2"; certUrl?: string; topic?: string; subject?: string }): Promise<SnsMessage> {
  const type = o.type ?? "Notification";
  const m: SnsMessage = {
    Type: type, MessageId: o.messageId ?? `msg-${++messageSeq}-${crypto.randomUUID()}`, TopicArn: o.topic ?? TOPIC,
    Message: typeof o.message === "string" ? o.message : JSON.stringify(o.message), Timestamp: new Date().toISOString(),
    SignatureVersion: o.version ?? "1", Signature: "", SigningCertURL: o.certUrl ?? CERT_URL,
    ...(o.subject !== undefined ? { Subject: o.subject } : {}),
    ...(type === "SubscriptionConfirmation" ? {
      Token: "2336412f37fb687f5d51e6e2425f004a",
      SubscribeURL: `https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(o.topic ?? TOPIC)}&Token=2336412f37fb687f5d51e6e2425f004a`,
    } : { UnsubscribeURL: `https://sns.us-east-1.amazonaws.com/?Action=Unsubscribe&SubscriptionArn=${o.topic ?? TOPIC}:sub` }),
  };
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", m.SignatureVersion === "1" ? keys.sha1 : keys.sha256, new TextEncoder().encode(stringToSign(m)));
  m.Signature = Buffer.from(sig).toString("base64");
  return m;
}

// ---------- RVS ----------

export function receipt(over: Partial<AmazonReceipt> = {}): AmazonReceipt {
  return {
    autoRenewing: true, betaProduct: false, cancelDate: null, cancelReason: null, countryCode: "US", deferredDate: null, deferredSku: null,
    freeTrialEndDate: null, gracePeriodEndDate: null, parentProductId: null, productId: "pro.subscription", productType: "SUBSCRIPTION", promotions: null,
    purchaseDate: T0.getTime(), quantity: null, receiptId: "q1YqVrJSSs7P1UvMTazKz9PLTCwoTswtyEktM8jLz0kpLQ1JTSlFMsjILCoQ:3:11",
    renewalDate: at(30).getTime(), term: "1 Month", termSku: "pro.monthly", testTransaction: false,
    fulfillmentDate: null, fulfillmentResult: null,
    ...over,
  };
}

interface Call { url: string; method: string; body: string; headers: Headers }

/** A fake Amazon: RVS (production and cloud sandbox), the SNS certificate and subscription confirmation, and a forward target. */
export class FakeAmazon {
  /** Receipts RVS knows, by receipt id, with the Amazon user they belong to and the environment that has them. */
  receipts = new Map<string, { r: AmazonReceipt; user: string; env: "production" | "sandbox" }>();
  /** Forced answers for a receipt id (e.g. 410). */
  status = new Map<string, number>();
  calls: Call[] = [];
  confirmations: string[] = [];
  forwarded: Call[] = [];
  certFetches = 0;
  override: ((url: string) => Response | Promise<Response> | undefined) | null = null;
  constructor(public keys: SnsKeys) {}

  put(r: AmazonReceipt, o: { user?: string; env?: "production" | "sandbox" } = {}) { this.receipts.set(r.receiptId, { r, user: o.user ?? AMZ_USER, env: o.env ?? "production" }); return r; }
  update(receiptId: string, over: Partial<AmazonReceipt>) { const x = this.receipts.get(receiptId)!; x.r = { ...x.r, ...over }; return x.r; }
  rvsCalls() { return this.calls.filter((c) => c.url.startsWith("https://appstore-sdk.amazon.com/")); }

  fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const call = { url, method: (init.method ?? "GET").toUpperCase(), body: typeof init.body === "string" ? init.body : "", headers: new Headers(init.headers) };
    this.calls.push(call);
    const o = await this.override?.(url);
    if (o) return o;
    if (url === CERT_URL) { this.certFetches++; return new Response(this.keys.pem, { status: 200 }); }
    if (url.startsWith("https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription")) { this.confirmations.push(url); return new Response("<ConfirmSubscriptionResponse/>", { status: 200 }); }
    if (url.startsWith("https://hooks.example.com/")) { this.forwarded.push(call); return new Response(null, { status: 202 }); }
    const m = /^https:\/\/appstore-sdk\.amazon\.com(\/sandbox)?\/version\/1\.0\/verifyReceiptId\/developer\/([^/]+)\/user\/([^/]+)\/receiptId\/([^/]+)$/.exec(url);
    if (!m) throw new Error(`unexpected fetch ${url}`);
    const env = m[1] ? "sandbox" : "production";
    const [secret, user, id] = [m[2]!, m[3]!, m[4]!].map(decodeURIComponent);
    if (secret !== SECRET) return new Response("", { status: 496 });
    const forced = this.status.get(id!);
    if (forced) return new Response("", { status: forced });
    const x = this.receipts.get(id!);
    if (!x || x.env !== env) return new Response("", { status: 400 });
    if (x.user !== user) return new Response("", { status: 497 });
    return new Response(JSON.stringify(x.r), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

export interface Env {
  h: Harness; a: FakeAmazon; store: AmazonStore; appId: string; key: string;
  call: (path: string, init?: RequestInit & { json?: unknown; key?: string | null }) => Promise<Response>;
  receipt: (body: Record<string, unknown>) => Promise<Response>;
  sns: (m: SnsMessage) => Promise<Response>;
  rtn: (n: Record<string, unknown>, o?: { messageId?: string; version?: "1" | "2" }) => Promise<Response>;
  events: (type?: string) => Promise<Array<Record<string, any>>>;
}

/** The contract harness plus an Amazon app (shared key set) and its catalog, with the server wired to a fake Amazon. */
export async function env(keys: SnsKeys, credentials: Record<string, unknown> = {}): Promise<Env> {
  const h = await harness();
  const a = new FakeAmazon(keys);
  const store = createAmazonStore({ fetch: a.fetch, now: h.now, timeoutMs: 200 });
  const app = createApp({ db: h.db, now: h.now, stores: { ...defaultStores(), amazon: store }, fetch: a.fetch });
  const appId = "app_amazon", key = "amzn_testkey123";
  await h.db.insert(schema.apps).values({ id: appId, projectId: h.ids.project, name: "Scanner Fire", type: "amazon", bundleId: PKG, publicKey: key, credentials: { shared_secret: SECRET, ...credentials } });
  const prods = [
    { id: "az_m", storeIdentifier: "pro.monthly", type: "subscription", duration: "P1M" },
    { id: "az_y", storeIdentifier: "pro.annual", type: "subscription", duration: "P1Y" },
    { id: "az_coins", storeIdentifier: "coins.100", type: "consumable", duration: null },
    { id: "az_life", storeIdentifier: "lifetime.unlock", type: "non_consumable", duration: null },
  ];
  await h.db.insert(schema.products).values(prods.map((p) => ({ ...p, projectId: h.ids.project, appId, displayName: p.storeIdentifier })));
  await h.db.insert(schema.entitlementProducts).values(["az_m", "az_y", "az_life"].map((productId) => ({ entitlementId: "ent_pro", productId })));
  const call: Env["call"] = (path, init = {}) => {
    const headers = new Headers(init.headers);
    if (init.key) headers.set("Authorization", `Bearer ${init.key}`);
    let body = init.body;
    if (init.json !== undefined) { headers.set("content-type", "application/json"); body = JSON.stringify(init.json); }
    return Promise.resolve(app.fetch(new Request(`http://localhost${path}`, { ...init, headers, body })));
  };
  const sns: Env["sns"] = (m) => call(`/v1/notifications/amazon/${appId}`, { method: "POST", headers: { "content-type": "text/plain; charset=UTF-8", "x-amz-sns-message-type": m.Type }, body: JSON.stringify(m) });
  return {
    h, a, store, appId, key, call, sns,
    receipt: (body) => call("/v1/receipts", { method: "POST", key, headers: { "X-Platform": "amazon", marketplace: "US" }, json: { is_restore: false, observer_mode: false, store_user_id: AMZ_USER, ...body } }),
    rtn: async (n, o = {}) => sns(await snsMessage(keys, {
      messageId: o.messageId, version: o.version,
      message: { appPackageName: PKG, appUserId: AMZ_USER, relatedReceipts: {}, timestamp: h.now().getTime(), betaProductTransaction: false, ...n },
    })),
    events: async (type) => {
      const rows = await h.db.select().from(schema.events);
      return rows.map((r) => (r.payload as { event: Record<string, any> }).event).filter((ev) => !type || ev.type === type);
    },
  };
}
