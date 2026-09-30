import type { Store } from "@revenuedot/core";
import type { AppRow, ReceiptInput, StoreAdapter, VerifiedPurchase } from "../types.js";
import { Codes, RCError } from "../../errors.js";
import { base64ToBytes } from "./asn1.js";
import { AppStoreServerApi, AppleApiClientError, appleCredentials, type AppleCredentials, type AppleEnv, type FetchFn } from "./api.js";
import { JwsError, looksLikeJws, pemToDer, verifyAppleJws } from "./jws.js";
import { AUTO_RENEWABLE, alpha2, fromTransaction, latestPerChain, type AppleRenewalInfo, type AppleTransaction } from "./map.js";
import { parseAppReceipt, type AppReceipt } from "./receipt.js";

export { setAppleRootsForTesting } from "./jws.js";

type Catalog = Parameters<StoreAdapter["verify"]>[2];

/** Where a signed payload came from: a device (bad data is the client's fault) or Apple's API (bad data is our problem). */
type Source = "device" | "apple";

interface Ctx {
  store: Store;
  bundleId: string | null;
  creds: AppleCredentials | null;
  allowUnsignedReceipts: boolean;
  xcodeRoots: Uint8Array[];
  fetchFn: FetchFn;
  now: () => Date;
}

const invalid = (message: string) => new RCError(400, Codes.INVALID_RECEIPT, message);

export const appleStoreOf = (app: Pick<AppRow, "type">): Store => (app.type === "mac_app_store" ? "mac_app_store" : "app_store");

/** The bundle id purchases must carry: the credentials' `bundle_id`, else the app's. Unset means not checked. */
export const expectedBundleId = (app: AppRow): string | null =>
  (typeof app.credentials?.bundle_id === "string" && app.credentials.bundle_id) || app.bundleId || null;

/** The StoreKit test certificate exported from Xcode (`credentials.xcode_certificate`, PEM or base64 DER). */
export function xcodeRootsOf(app: AppRow): Uint8Array[] {
  const c = app.credentials?.xcode_certificate;
  if (typeof c !== "string" || !c.trim()) return [];
  try { return [pemToDer(c)]; } catch { return []; }
}

export async function verifyTransactionJws(jws: string, o: { bundleId: string | null; xcodeRoots: Uint8Array[]; now: Date; source: Source }): Promise<AppleTransaction> {
  const fail = (m: string) => (o.source === "device" ? invalid(m) : new RCError(503, Codes.STORE_PROBLEM, `The App Store returned an unverifiable transaction: ${m}`));
  let tx: AppleTransaction;
  try {
    tx = await verifyAppleJws<AppleTransaction>(jws, { xcodeRoots: o.xcodeRoots, now: o.now });
  } catch (e) {
    if (e instanceof JwsError) throw fail(`The App Store transaction is not valid: ${e.message}.`);
    throw e;
  }
  if (!tx || typeof tx.transactionId !== "string" || typeof tx.productId !== "string" || typeof tx.purchaseDate !== "number") throw fail("The JWS is not an App Store transaction.");
  tx.originalTransactionId ||= tx.transactionId;
  tx.originalPurchaseDate ||= tx.purchaseDate;
  if (o.bundleId && tx.bundleId !== o.bundleId) throw fail(`The transaction is for bundle id ${tx.bundleId}, not ${o.bundleId}.`);
  return tx;
}

export async function verifyRenewalJws(jws: string, o: { xcodeRoots: Uint8Array[]; now: Date; source: Source }): Promise<AppleRenewalInfo> {
  try {
    return await verifyAppleJws<AppleRenewalInfo>(jws, { xcodeRoots: o.xcodeRoots, now: o.now });
  } catch (e) {
    if (!(e instanceof JwsError)) throw e;
    if (o.source === "device") throw invalid(`The App Store renewal info is not valid: ${e.message}.`);
    throw new RCError(503, Codes.STORE_PROBLEM, `The App Store returned unverifiable renewal info: ${e.message}.`);
  }
}

/** Every transaction id Apple proved for each chain, so a chain imported under another of its ids can be matched. */
function withChainIds(out: VerifiedPurchase[], txs: { transactionId: string; originalTransactionId: string }[]): VerifiedPurchase[] {
  for (const p of out) {
    if (p.kind !== "subscription") continue;
    p.chainTransactionIds = [...new Set(txs.filter((t) => t.originalTransactionId === p.storeKey).map((t) => t.transactionId))];
  }
  return out;
}

const verifyTx = (ctx: Ctx, jws: string, source: Source) => verifyTransactionJws(jws, { bundleId: ctx.bundleId, xcodeRoots: ctx.xcodeRoots, now: ctx.now(), source });

/**
 * Asks the App Store Server API for the customer's full history and renewal state, starting from any of their transactions.
 * Production is tried first for production data; a 404 there retries the sandbox. `known` are transactions the device
 * already proved; they are used alone when Apple does not know the transaction yet.
 */
async function fromServerApi(ctx: Ctx, transactionId: string, env: AppleEnv, known: AppleTransaction[]): Promise<VerifiedPurchase[]> {
  const api = new AppStoreServerApi(ctx.creds!, ctx.fetchFn, ctx.now);
  const detectedAt = ctx.now();
  const plain = () => withChainIds(latestPerChain(known).map((tx) => fromTransaction(tx, { store: ctx.store, detectedAt })), known);
  let usedEnv = env;
  let signed: string[] | null;
  try {
    signed = await api.history(env, transactionId);
    if (signed === null && env === "production") {
      usedEnv = "sandbox";
      signed = await api.history("sandbox", transactionId);
    }
  } catch (e) {
    if (!(e instanceof AppleApiClientError)) throw e;
    if (known.length) return plain();
    throw invalid(`The App Store did not accept the receipt's transaction: ${e.message}.`);
  }
  if (signed === null) {
    if (known.length) return plain();
    throw invalid("The App Store has no record of the receipt's transactions.");
  }
  const txs = [...known];
  for (const s of signed) txs.push(await verifyTx(ctx, s, "apple"));

  const renewals = new Map<string, { renewal: AppleRenewalInfo | null; status: number }>();
  const anySub = latestPerChain(txs).find((t) => t.type === AUTO_RENEWABLE);
  if (anySub) {
    let statuses = null;
    try {
      statuses = await api.subscriptionStatuses(usedEnv, anySub.transactionId);
    } catch (e) {
      if (!(e instanceof AppleApiClientError)) throw e;
    }
    for (const group of statuses?.data ?? []) {
      for (const last of group.lastTransactions ?? []) {
        txs.push(await verifyTx(ctx, last.signedTransactionInfo, "apple"));
        const renewal = last.signedRenewalInfo ? await verifyRenewalJws(last.signedRenewalInfo, { xcodeRoots: ctx.xcodeRoots, now: ctx.now(), source: "apple" }) : null;
        renewals.set(last.originalTransactionId, { renewal, status: last.status });
      }
    }
  }
  return withChainIds(latestPerChain(txs).map((tx) => {
    const r = renewals.get(tx.originalTransactionId);
    // Status 3 is billing retry and 4 grace period; both mean the last renewal failed.
    return fromTransaction(tx, { store: ctx.store, renewal: r?.renewal ?? null, detectedAt, billingIssue: r && (r.status === 3 || r.status === 4) ? true : undefined });
  }), txs);
}

/** StoreKit 2: the SDK posts the transaction's JWS. */
async function verifySignedTransaction(ctx: Ctx, jws: string): Promise<VerifiedPurchase[]> {
  const tx = await verifyTx(ctx, jws, "device");
  const local = tx.environment === "Xcode" || tx.environment === "LocalTesting";
  if (!ctx.creds || local) return withChainIds([fromTransaction(tx, { store: ctx.store, detectedAt: ctx.now() })], [tx]);
  return fromServerApi(ctx, tx.transactionId, tx.environment === "Production" ? "production" : "sandbox", [tx]);
}

/** StoreKit 2 in Xcode: the SDK posts base64 JSON holding the local transactions and subscription statuses. */
async function verifyXcodeReceipt(ctx: Ctx, bytes: Uint8Array): Promise<VerifiedPurchase[]> {
  let json: { bundle_id?: string; transactions?: unknown; subscription_status?: Record<string, { renewal_info?: string }[]> };
  try { json = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw invalid("The receipt is not a valid App Store receipt."); }
  if (!Array.isArray(json?.transactions)) throw invalid("The receipt is not a valid App Store receipt.");
  if (ctx.bundleId && json.bundle_id && json.bundle_id !== ctx.bundleId) throw invalid(`The receipt is for bundle id ${json.bundle_id}, not ${ctx.bundleId}.`);
  const txs: AppleTransaction[] = [];
  for (const t of json.transactions) if (typeof t === "string") txs.push(await verifyTx(ctx, t, "device"));
  const renewals = new Map<string, AppleRenewalInfo>();
  for (const group of Object.values(json.subscription_status ?? {})) {
    for (const s of Array.isArray(group) ? group : []) {
      if (typeof s?.renewal_info !== "string") continue;
      const r = await verifyRenewalJws(s.renewal_info, { xcodeRoots: ctx.xcodeRoots, now: ctx.now(), source: "device" });
      renewals.set(r.originalTransactionId, r);
    }
  }
  return withChainIds(latestPerChain(txs).map((tx) => fromTransaction(tx, { store: ctx.store, renewal: renewals.get(tx.originalTransactionId) ?? null, detectedAt: ctx.now() })), txs);
}

/**
 * StoreKit 1: the SDK posts the base64 app receipt (PKCS#7).
 * With App Store Server API credentials, the receipt only names a transaction and Apple's API is the source of truth
 * (a forged receipt fails there). Without credentials the receipt's PKCS#7 signature is NOT verified, so it is refused
 * unless `credentials.allow_unsigned_receipts` is true (development only): anyone could forge such a receipt.
 */
async function verifyAppReceipt(ctx: Ctx, bytes: Uint8Array, input: ReceiptInput, catalog: Catalog): Promise<VerifiedPurchase[]> {
  let receipt: AppReceipt;
  try { receipt = parseAppReceipt(bytes); } catch { throw invalid("The receipt is not a valid App Store receipt."); }
  if (ctx.bundleId && receipt.bundleId !== ctx.bundleId) throw invalid(`The receipt is for bundle id ${receipt.bundleId}, not ${ctx.bundleId}.`);
  if (receipt.environment !== null && receipt.environment !== "Production" && receipt.environment !== "ProductionSandbox") {
    throw invalid(`${receipt.environment} receipts are not signed by the App Store.`);
  }
  if (!receipt.inApp.length) return [];
  if (ctx.creds) {
    const latest = receipt.inApp.reduce((a, b) => (b.purchaseDate > a.purchaseDate ? b : a));
    return fromServerApi(ctx, latest.transactionId, receipt.environment === "ProductionSandbox" ? "sandbox" : "production", []);
  }
  // Nothing proves the PKCS#7 receipt is genuine, so anyone could forge one and unlock paid features.
  // Refuse unless the operator opted in explicitly (development only).
  if (!ctx.allowUnsignedReceipts) {
    throw new RCError(500, Codes.INVALID_APPLE_SUBSCRIPTION_KEY, "StoreKit 1 receipts need the App Store in-app purchase key. Add the key in the app's settings (or set allow_unsigned_receipts for development), then the app will retry.");
  }
  return fromReceipt(ctx, receipt, input, catalog);
}

function fromReceipt(ctx: Ctx, receipt: AppReceipt, input: ReceiptInput, catalog: Catalog): VerifiedPurchase[] {
  const isSandbox = receipt.environment === null ? input.isSandboxHeader : receipt.environment !== "Production";
  const countryCode = alpha2(input.storeCountry);
  // The receipt has no prices; the SDK sends the price of the product being bought.
  const priceFor = (productId: string) =>
    input.price !== null && input.currency && input.productIds[0] === productId ? { amount: input.price, currency: input.currency } : null;
  const chains = new Map<string, AppReceipt["inApp"]>();
  const out: VerifiedPurchase[] = [];
  for (const i of receipt.inApp) {
    if (i.expiresDate) chains.set(i.originalTransactionId, [...(chains.get(i.originalTransactionId) ?? []), i]);
    else {
      out.push({
        kind: "non_subscription", store: ctx.store, productIdentifier: i.productId, storeTransactionId: i.transactionId, isSandbox,
        isConsumable: catalog.productType(i.productId) === "consumable", purchaseDate: i.purchaseDate, refundedAt: i.cancellationDate,
        price: priceFor(i.productId), countryCode,
      });
    }
  }
  for (const [originalTransactionId, items] of chains) {
    const latest = items.reduce((a, b) => (b.purchaseDate > a.purchaseDate ? b : a));
    const first = items.reduce((a, b) => (b.purchaseDate < a.purchaseDate ? b : a));
    out.unshift({
      kind: "subscription", store: ctx.store, storeKey: originalTransactionId, productIdentifier: latest.productId, isSandbox,
      purchaseDate: latest.purchaseDate, originalPurchaseDate: latest.originalPurchaseDate ?? first.purchaseDate, expiresDate: latest.expiresDate,
      periodType: latest.isTrialPeriod ? "trial" : latest.isInIntroOfferPeriod ? "intro" : "normal",
      refundedAt: latest.cancellationDate, storeTransactionId: latest.transactionId, originalTransactionId,
      price: priceFor(latest.productId), countryCode, chainTransactionIds: items.map((i) => i.transactionId),
    });
  }
  return out;
}

export interface AppleStoreOptions {
  /** HTTP client for the App Store Server API (tests pass a mock). */
  fetch?: FetchFn;
  now?: () => Date;
}

/**
 * App Store adapter. `fetch_token` is one of:
 *  - a StoreKit 2 signed transaction (JWS),
 *  - a StoreKit 1 app receipt (base64 PKCS#7),
 *  - an Xcode StoreKit testing receipt (base64 JSON of local JWS), trusted only with `credentials.xcode_certificate`.
 * With `credentials` { key_id, issuer_id, private_key (.p8), bundle_id? } the App Store Server API supplies the full
 * history and renewal state (auto-renew, billing retry, grace period).
 */
export interface AppleStore extends StoreAdapter {
  /** The HTTP client and clock this adapter uses for the App Store Server API (the store actions reuse them). */
  fetchFn: FetchFn;
  now: () => Date;
  customFetch: boolean;
}

export function createAppleStore(opts: AppleStoreOptions = {}): AppleStore {
  const fetchFn: FetchFn = opts.fetch ?? ((url, init) => fetch(url, init));
  const now = opts.now ?? (() => new Date());
  return {
    fetchFn, now, customFetch: !!opts.fetch,
    async verify(app, input, catalog) {
      const token = input.fetchToken?.trim();
      if (!token) throw invalid("fetch_token is required.");
      const ctx: Ctx = { store: appleStoreOf(app), bundleId: expectedBundleId(app), creds: appleCredentials(app), allowUnsignedReceipts: (app.credentials as Record<string, unknown>)?.allow_unsigned_receipts === true, xcodeRoots: xcodeRootsOf(app), fetchFn, now };
      if (looksLikeJws(token)) return verifySignedTransaction(ctx, token);
      let bytes: Uint8Array;
      try { bytes = base64ToBytes(token); } catch { throw invalid("The receipt is not a valid App Store receipt."); }
      if (bytes[0] === 0x7b /* "{" */) return verifyXcodeReceipt(ctx, bytes);
      return verifyAppReceipt(ctx, bytes, input, catalog);
    },
  };
}

export const appleStore: AppleStore = createAppleStore();

const isAppleStore = (s: unknown): s is AppleStore => !!s && typeof s === "object" && typeof (s as AppleStore).fetchFn === "function";

/** The App Store Server API client for an app, using the adapter's HTTP client (tests inject one), else `fallbackFetch`. */
export function appleApiFor(stores: Record<string, StoreAdapter>, app: AppRow, fallbackFetch?: typeof fetch, now: () => Date = () => new Date()): AppStoreServerApi | null {
  const creds = appleCredentials(app);
  if (!creds) return null;
  const s = stores.app_store;
  const fetchFn: FetchFn = isAppleStore(s) && (s.customFetch || !fallbackFetch) ? s.fetchFn : fallbackFetch ? (u, i) => fallbackFetch(u, i) : appleStore.fetchFn;
  return new AppStoreServerApi(creds, fetchFn, isAppleStore(s) ? s.now : now);
}

/**
 * Re-reads one subscription chain from the App Store Server API (Get All Subscription Statuses) and returns its latest
 * state, ready for `applyFromStore`. Used after a store action (extend) so the response already shows the new state.
 */
export async function readAppleSubscription(api: AppStoreServerApi, app: AppRow, originalTransactionId: string, env: AppleEnv, now: Date): Promise<VerifiedPurchase | null> {
  const statuses = await api.subscriptionStatuses(env, originalTransactionId);
  const opts = { bundleId: expectedBundleId(app), xcodeRoots: xcodeRootsOf(app), now, source: "apple" as const };
  for (const group of statuses?.data ?? []) {
    for (const last of group.lastTransactions ?? []) {
      if (last.originalTransactionId !== originalTransactionId) continue;
      const tx = await verifyTransactionJws(last.signedTransactionInfo, opts);
      const renewal = last.signedRenewalInfo ? await verifyRenewalJws(last.signedRenewalInfo, opts) : null;
      return fromTransaction(tx, { store: appleStoreOf(app), renewal, detectedAt: now, billingIssue: last.status === 3 || last.status === 4 ? true : undefined });
    }
  }
  return null;
}
