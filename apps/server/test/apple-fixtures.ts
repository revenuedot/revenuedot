/** Test helpers for the App Store adapter: a throwaway CA, signed JWS, DER receipts, a mock App Store Server API and a harness. */
import { CompactSign } from "jose";
import { asc } from "drizzle-orm";
import { openDb, schema, type DB } from "@revenuedot/db";
import { createApp } from "../src/app.js";
import { defaultStores } from "../src/stores/index.js";
import { createAppleStore } from "../src/stores/apple/index.js";
import type { FetchFn, StatusesResponse } from "../src/stores/apple/api.js";
import type { AppleRenewalInfo, AppleTransaction } from "../src/stores/apple/map.js";

// ---------- DER encoding ----------

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
function tlv(tag: number, content: Uint8Array): Uint8Array {
  const n = content.length;
  let len: number[];
  if (n < 128) len = [n];
  else { len = []; for (let v = n; v > 0; v = Math.floor(v / 256)) len.unshift(v & 0xff); len.unshift(0x80 | len.length); }
  return concat([Uint8Array.of(tag, ...len), content]);
}
export const der = {
  seq: (...c: Uint8Array[]) => tlv(0x30, concat(c)),
  set: (...c: Uint8Array[]) => tlv(0x31, concat(c)),
  int: (n: number) => {
    const b: number[] = [];
    for (let v = n; v > 0; v = Math.floor(v / 256)) b.unshift(v & 0xff);
    if (!b.length || b[0]! & 0x80) b.unshift(0);
    return tlv(0x02, Uint8Array.from(b));
  },
  oid: (s: string) => {
    const [a, b, ...rest] = s.split(".").map(Number);
    const out = [a! * 40 + b!];
    for (const v of rest) {
      const chunk = [v & 0x7f];
      for (let x = Math.floor(v / 128); x > 0; x = Math.floor(x / 128)) chunk.unshift((x & 0x7f) | 0x80);
      out.push(...chunk);
    }
    return tlv(0x06, Uint8Array.from(out));
  },
  utf8: (s: string) => tlv(0x0c, new TextEncoder().encode(s)),
  ia5: (s: string) => tlv(0x16, new TextEncoder().encode(s)),
  octet: (c: Uint8Array) => tlv(0x04, c),
  bool: (v: boolean) => Uint8Array.of(0x01, 0x01, v ? 0xff : 0),
  null: () => Uint8Array.of(0x05, 0x00),
  bits: (c: Uint8Array) => tlv(0x03, concat([Uint8Array.of(0), c])),
  ctx: (n: number, c: Uint8Array) => tlv(0xa0 | n, c),
  time: (d: Date) => {
    const iso = d.toISOString().replace(/[-:T]/g, "").slice(0, 14) + "Z";
    return d.getUTCFullYear() < 2050 ? tlv(0x17, new TextEncoder().encode(iso.slice(2))) : tlv(0x18, new TextEncoder().encode(iso));
  },
};

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
export const toPem = (d: Uint8Array) => `-----BEGIN CERTIFICATE-----\n${b64(d).replace(/(.{64})/g, "$1\n")}\n-----END CERTIFICATE-----`;

// ---------- A throwaway PKI shaped like Apple's ----------

const OID_ECDSA_SHA256 = "1.2.840.10045.4.3.2";
export const OID_APPLE_LEAF = "1.2.840.113635.100.6.11.1";
export const OID_APPLE_INTERMEDIATE = "1.2.840.113635.100.6.2.1";

function rawToDerSig(raw: Uint8Array): Uint8Array {
  const part = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    const v = b.subarray(i);
    return tlv(0x02, v[0]! & 0x80 ? concat([Uint8Array.of(0), v]) : v);
  };
  return der.seq(part(raw.subarray(0, 32)), part(raw.subarray(32)));
}

const genKey = () => crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as Promise<CryptoKeyPair>;
let serial = 1;

async function makeCert(o: { subject: string; issuer: string; publicKey: CryptoKey; signer: CryptoKey; ca: boolean; oids?: string[]; notBefore?: Date; notAfter?: Date }) {
  const name = (cn: string) => der.seq(der.set(der.seq(der.oid("2.5.4.3"), der.utf8(cn))));
  const sigAlg = der.seq(der.oid(OID_ECDSA_SHA256));
  const exts = [der.seq(der.oid("2.5.29.19"), der.bool(true), der.octet(o.ca ? der.seq(der.bool(true)) : der.seq()))];
  for (const id of o.oids ?? []) exts.push(der.seq(der.oid(id), der.octet(der.null())));
  const tbs = der.seq(
    der.ctx(0, der.int(2)), der.int(serial++), sigAlg, name(o.issuer),
    der.seq(der.time(o.notBefore ?? new Date("2020-01-01T00:00:00Z")), der.time(o.notAfter ?? new Date("2040-01-01T00:00:00Z"))),
    name(o.subject), new Uint8Array(await crypto.subtle.exportKey("spki", o.publicKey)), der.ctx(3, der.seq(...exts)),
  );
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, o.signer, new Uint8Array(tbs)));
  return der.seq(tbs, sigAlg, der.bits(rawToDerSig(sig)));
}

export interface Pki { rootPem: string; x5c: string[]; leafKey: CryptoKey }

/** Root, intermediate and leaf like Apple's App Store signing chain (leaf and intermediate carry Apple's marker OIDs). */
export async function makePki(o: { leafNotAfter?: Date; leafNotBefore?: Date; appleOids?: boolean } = {}): Promise<Pki> {
  const [root, int, leaf] = await Promise.all([genKey(), genKey(), genKey()]);
  const oids = o.appleOids ?? true;
  const rootCert = await makeCert({ subject: "Test Root CA", issuer: "Test Root CA", publicKey: root.publicKey, signer: root.privateKey, ca: true });
  const intCert = await makeCert({ subject: "Test WWDR CA", issuer: "Test Root CA", publicKey: int.publicKey, signer: root.privateKey, ca: true, oids: oids ? [OID_APPLE_INTERMEDIATE] : [] });
  const leafCert = await makeCert({
    subject: "Test App Store Signing", issuer: "Test WWDR CA", publicKey: leaf.publicKey, signer: int.privateKey, ca: false,
    oids: oids ? [OID_APPLE_LEAF] : [], notBefore: o.leafNotBefore, notAfter: o.leafNotAfter,
  });
  return { rootPem: toPem(rootCert), x5c: [leafCert, intCert, rootCert].map(b64), leafKey: leaf.privateKey };
}

/** A single self-signed certificate, like Xcode's StoreKit testing certificate. */
export async function makeXcodePki(): Promise<Pki> {
  const k = await genKey();
  const cert = await makeCert({ subject: "StoreKit Testing in Xcode", issuer: "StoreKit Testing in Xcode", publicKey: k.publicKey, signer: k.privateKey, ca: true });
  return { rootPem: toPem(cert), x5c: [b64(cert)], leafKey: k.privateKey };
}

export const signJws = (payload: unknown, pki: Pki) =>
  new CompactSign(new TextEncoder().encode(JSON.stringify(payload))).setProtectedHeader({ alg: "ES256", x5c: pki.x5c }).sign(pki.leafKey);

// ---------- Apple payloads ----------

export const BUNDLE = "com.example.scanner";
export const T0 = Date.parse("2026-09-01T12:00:00Z");
export const DAY = 86_400_000;

export function transaction(over: Partial<AppleTransaction> & Record<string, unknown> = {}): AppleTransaction {
  const transactionId = (over.transactionId as string) ?? "2000000001";
  return {
    transactionId, originalTransactionId: transactionId, bundleId: BUNDLE, productId: "pro_monthly",
    purchaseDate: T0, originalPurchaseDate: T0, expiresDate: T0 + 30 * DAY, type: "Auto-Renewable Subscription",
    inAppOwnershipType: "PURCHASED", environment: "Production", storefront: "USA", price: 9990, currency: "USD", signedDate: T0,
    ...over,
  } as AppleTransaction;
}

export function renewalInfo(over: Partial<AppleRenewalInfo> & Record<string, unknown> = {}): AppleRenewalInfo {
  return { originalTransactionId: "2000000001", productId: "pro_monthly", autoRenewProductId: "pro_monthly", autoRenewStatus: 1, signedDate: T0, ...over } as AppleRenewalInfo;
}

export async function notificationBody(pki: Pki, type: string, subtype: string | undefined, tx: AppleTransaction | null, renewal: AppleRenewalInfo | null, over: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { bundleId: BUNDLE, environment: tx?.environment ?? "Production", appAppleId: 1234567890 };
  if (tx) data.signedTransactionInfo = await signJws(tx, pki);
  if (renewal) data.signedRenewalInfo = await signJws(renewal, pki);
  const payload = { notificationType: type, subtype, notificationUUID: crypto.randomUUID(), version: "2.0", signedDate: (tx?.signedDate ?? T0) + 1000, data, ...over };
  return JSON.stringify({ signedPayload: await signJws(payload, pki) });
}

// ---------- StoreKit 1 receipts ----------

export interface ReceiptItem {
  productId: string; transactionId: string; originalTransactionId?: string; purchaseDate: string; originalPurchaseDate?: string; expiresDate?: string;
  cancellationDate?: string; isTrial?: boolean; isIntro?: boolean; quantity?: number;
}

/** A base64 PKCS#7 app receipt (unsigned: our adapter does not check the PKCS#7 signature). */
export function makeReceipt(o: { bundleId?: string; environment?: string; originalApplicationVersion?: string; inApp: ReceiptItem[] }): string {
  const attr = (type: number, value: Uint8Array) => der.seq(der.int(type), der.int(1), der.octet(value));
  const items = o.inApp.map((i) => der.set(
    attr(1701, der.int(i.quantity ?? 1)), attr(1702, der.utf8(i.productId)), attr(1703, der.utf8(i.transactionId)),
    attr(1705, der.utf8(i.originalTransactionId ?? i.transactionId)), attr(1704, der.ia5(i.purchaseDate)), attr(1706, der.ia5(i.originalPurchaseDate ?? i.purchaseDate)),
    attr(1708, der.ia5(i.expiresDate ?? "")), attr(1712, der.ia5(i.cancellationDate ?? "")),
    attr(1713, der.int(i.isTrial ? 1 : 0)), attr(1719, der.int(i.isIntro ? 1 : 0)),
  ));
  const payload = der.set(
    attr(0, der.utf8(o.environment ?? "Production")), attr(2, der.utf8(o.bundleId ?? BUNDLE)), attr(3, der.utf8("42")),
    attr(19, der.utf8(o.originalApplicationVersion ?? "1.0")), ...items.map((i) => attr(17, i)),
  );
  const signedData = der.seq(der.int(1), der.set(), der.seq(der.oid("1.2.840.113549.1.7.1"), der.ctx(0, der.octet(payload))), der.set());
  return b64(der.seq(der.oid("1.2.840.113549.1.7.2"), der.ctx(0, signedData)));
}

// ---------- A mock App Store Server API ----------

export interface ApiEnvData { transactions: string[]; statuses?: StatusesResponse }
export interface ApiCall { env: string; path: string; auth: string | null }

/** Serves history (2 per page, to exercise pagination) and statuses per environment for any known transaction id. */
export function mockAppleApi(data: { production?: ApiEnvData; sandbox?: ApiEnvData; failWith?: number; knownIds?: string[] }) {
  const calls: ApiCall[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const u = new URL(url);
    const env = u.host.includes("sandbox") ? "sandbox" : "production";
    calls.push({ env, path: u.pathname + u.search, auth: new Headers(init?.headers).get("authorization") });
    if (data.failWith) return new Response(JSON.stringify({ errorCode: 0, errorMessage: "failure" }), { status: data.failWith });
    const d = data[env];
    const id = decodeURIComponent(u.pathname.split("/").pop()!);
    if (!d || (data.knownIds && !data.knownIds.includes(id))) return new Response(JSON.stringify({ errorCode: 4040010, errorMessage: "Transaction id not found." }), { status: 404 });
    if (u.pathname.startsWith("/inApps/v2/history/")) {
      const start = Number(u.searchParams.get("revision") ?? 0);
      const page = d.transactions.slice(start, start + 2);
      const hasMore = start + 2 < d.transactions.length;
      return Response.json({ signedTransactions: page, hasMore, revision: String(start + 2), bundleId: BUNDLE, environment: env === "sandbox" ? "Sandbox" : "Production" });
    }
    if (u.pathname.startsWith("/inApps/v1/subscriptions/")) return Response.json(d.statuses ?? { data: [] });
    return new Response("{}", { status: 404 });
  };
  return { fetch: fetchFn, calls };
}

/** A P-256 key in the .p8 (PKCS#8 PEM) format App Store Connect hands out. */
export async function makeP8(): Promise<string> {
  const k = await genKey();
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", k.privateKey));
  return `-----BEGIN PRIVATE KEY-----\n${b64(pkcs8).replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----`;
}

// ---------- Harness ----------

export interface AppleHarness {
  db: DB;
  now: () => Date;
  setNow: (d: Date | number) => void;
  close: () => Promise<void>;
  /** POST /v1/receipts with the iOS app's key. */
  postReceipt: (appUserId: string, fetchToken: string, extra?: Record<string, unknown>) => Promise<Response>;
  customerInfo: (appUserId: string) => Promise<any>;
  notify: (body: string, contentType?: string) => Promise<Response>;
  /** Event payloads recorded since the last call, oldest first. */
  newEvents: () => Promise<any[]>;
}

export const APP_ID = "app_ios";
const KEY = "appl_testkey123";

export async function appleHarness(o: { credentials?: Record<string, unknown>; fetch?: FetchFn; forwardUrl?: string; bundleId?: string | null } = {}): Promise<AppleHarness> {
  const { db, close } = await openDb("pglite://memory");
  let clock = new Date(T0);
  const now = () => clock;
  const app = createApp({ db, now, stores: { ...defaultStores(), app_store: createAppleStore({ fetch: o.fetch, now }) } });
  await db.insert(schema.projects).values({ id: "proj1", name: "Scanner" });
  await db.insert(schema.apps).values({
    id: APP_ID, projectId: "proj1", name: "Scanner iOS", type: "app_store", bundleId: o.bundleId === undefined ? BUNDLE : o.bundleId, publicKey: KEY,
    credentials: o.credentials ?? {}, notificationForwardUrl: o.forwardUrl ?? null,
  });
  const prods = [
    { id: "p1", storeIdentifier: "pro_monthly", type: "subscription", duration: "P1M" },
    { id: "p2", storeIdentifier: "pro_annual", type: "subscription", duration: "P1Y" },
    { id: "p3", storeIdentifier: "coins_100", type: "consumable" },
    { id: "p4", storeIdentifier: "lifetime", type: "non_consumable" },
  ];
  await db.insert(schema.products).values(prods.map((p) => ({ ...p, projectId: "proj1", appId: APP_ID, displayName: p.storeIdentifier })));
  await db.insert(schema.entitlements).values({ id: "ent_pro", projectId: "proj1", lookupKey: "pro", displayName: "Pro" });
  await db.insert(schema.entitlementProducts).values(["p1", "p2", "p4"].map((productId) => ({ entitlementId: "ent_pro", productId })));
  const request = (path: string, init: RequestInit = {}) => Promise.resolve(app.fetch(new Request(`http://localhost${path}`, init)));
  const seen = new Set<string>();
  return {
    db, now, close,
    setNow: (d) => { clock = new Date(d); },
    postReceipt: (appUserId, fetchToken, extra = {}) => request("/v1/receipts", {
      method: "POST", headers: { Authorization: `Bearer ${KEY}`, "content-type": "application/json", "X-Platform": "iOS" },
      body: JSON.stringify({ app_user_id: appUserId, fetch_token: fetchToken, is_restore: false, observer_mode: false, initiation_source: "purchase", ...extra }),
    }),
    customerInfo: async (appUserId) => (await request(`/v1/subscribers/${encodeURIComponent(appUserId)}`, { headers: { Authorization: `Bearer ${KEY}` } })).json(),
    notify: (body, contentType = "application/json") => request(`/v1/notifications/apple/${APP_ID}`, { method: "POST", headers: { "content-type": contentType }, body }),
    newEvents: async () => {
      const rows = await db.select().from(schema.events).orderBy(asc(schema.events.createdAt));
      const fresh = rows.filter((r) => !seen.has(r.id));
      for (const r of fresh) seen.add(r.id);
      return fresh.map((r) => (r.payload as { event: Record<string, any> }).event);
    },
  };
}
