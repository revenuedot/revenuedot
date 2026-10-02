/**
 * Fake Amazon RVS and Stripe API for the e2e server, so "Check credentials", receipts and webhooks run through the real
 * server code without ever reaching Amazon or Stripe. Only these test values are accepted.
 * Web billing (web.spec.ts) uses its own key, FAKE_STRIPE_KEY: those calls go to `webStripe`, a stateful in-memory Stripe
 * account (products, prices, Checkout Sessions, coupons, promotion codes) shared with the contract tests.
 * Store import (store-import.spec.ts) reads a fake App Store Connect and a fake Google Play Developer API through
 * `storeCatalogFetch`, which answers only the e2e key ids and service account in store-values.ts.
 */
import { createAmazonStore } from "@revenuedot/server/stores/amazon/index.js";
import { createStripeStore } from "@revenuedot/server/stores/stripe/index.js";

import { E2E_AMAZON_SECRET, E2E_ASC_EMPTY_KEY_ID, E2E_ASC_FORBIDDEN_KEY_ID, E2E_PLAY_DENIED_EMAIL, E2E_ASC_KEY_ID, E2E_IMPORT_BUNDLE, E2E_PLAY_EMAIL, E2E_STRIPE_KEY, E2E_STRIPE_SUB } from "./store-values.ts";
import { FAKE_STRIPE_KEY, FakeStripeAccount, FakeStripePlatform } from "../../../packages/contract/src/fake-stripe.ts";

/** The web billing Stripe account (FAKE_STRIPE_KEY). server.ts points its checkout URL at its own fake Checkout page. */
export const webStripe = new FakeStripeAccount();
/** RevenueDot's Stripe Connect platform (stripe-connect.spec.ts, payment-recovery.spec.ts): OAuth, Account Links and connected accounts. */
export const connectPlatform = new FakeStripePlatform();

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function stripeFetch(url: string, init: RequestInit = {}): Response {
  const auth = new Headers(init.headers).get("authorization");
  if (auth !== `Bearer ${E2E_STRIPE_KEY}`) return json(401, { error: { type: "invalid_request_error", message: "Invalid API Key provided." } });
  const u = new URL(url);
  const now = Math.floor(Date.now() / 1000);
  const invoice = { id: "in_1E2e", object: "invoice", status: "paid", paid: true, amount_paid: 999, currency: "usd", billing_reason: "subscription_create", subscription: E2E_STRIPE_SUB, customer_address: { country: "US" }, livemode: false };
  const sub = {
    id: E2E_STRIPE_SUB, object: "subscription", status: "active", livemode: false, customer: "cus_E2e", start_date: now - 60, created: now - 60,
    current_period_start: now - 60, current_period_end: now + 30 * 86400, cancel_at_period_end: false, cancel_at: null, canceled_at: null, ended_at: null,
    cancellation_details: { reason: null }, pause_collection: null, trial_end: null, trial_start: null, currency: "usd", metadata: { app_user_id: "web_e2e_user" },
    items: { object: "list", data: [{ id: "si_E2e", price: { id: "price_1E2eMonthly", product: "prod_E2eMonthly", unit_amount: 999, currency: "usd", recurring: { interval: "month", interval_count: 1 } }, quantity: 1 }] },
    latest_invoice: u.searchParams.getAll("expand[]").includes("latest_invoice") ? invoice : invoice.id,
  };
  if (u.pathname === "/v1/subscriptions" || u.pathname === "/v1/checkout/sessions") return json(200, { object: "list", data: [], has_more: false });
  if (u.pathname === `/v1/subscriptions/${E2E_STRIPE_SUB}`) return json(200, sub);
  if (u.pathname === "/v1/invoices/in_1E2e") return json(200, invoice);
  return json(404, { error: { type: "invalid_request_error", code: "resource_missing", message: `No such object: ${u.pathname}` } });
}

function amazonFetch(url: string): Response {
  const m = /\/developer\/([^/]+)\/user\/([^/]+)\/receiptId\/([^/]+)$/.exec(url);
  if (!m || decodeURIComponent(m[1]!) !== E2E_AMAZON_SECRET) return new Response("", { status: 496 });
  return new Response("", { status: 400 });
}

export const fakeStoreFetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const h = new Headers(init.headers);
  // The Connect platform: its OAuth host, its own keys, and calls for a connected account (Stripe-Account).
  if (url.startsWith("https://connect.stripe.com/") || (url.startsWith("https://api.stripe.com/") && (h.has("stripe-account") || connectPlatform.keys.has((h.get("authorization") ?? "").replace(/^Bearer /, ""))))) return connectPlatform.fetch(url, init);
  if (url.startsWith("https://api.stripe.com/")) {
    if (h.get("authorization") === `Bearer ${FAKE_STRIPE_KEY}`) return webStripe.fetch(url, init);
    return stripeFetch(url, init);
  }
  if (url.startsWith("https://appstore-sdk.amazon.com/")) return amazonFetch(url);
  throw new Error(`The e2e store fakes do not serve ${url}`);
}) as typeof fetch;

/** Amazon and Stripe adapters wired to the fakes above. */
export const fakeStores = () => ({ amazon: createAmazonStore({ fetch: fakeStoreFetch }), stripe: createStripeStore({ fetch: fakeStoreFetch }) });

// ---- Store import: App Store Connect and Google Play product lists ------------------------------------------------------

const b64json = (part: string | undefined) => { try { return JSON.parse(Buffer.from(part ?? "", "base64url").toString("utf8")) as Record<string, unknown>; } catch { return {}; } };
const res = (id: string, type: string, attributes: Record<string, unknown>) => ({ id, type, attributes });
const ASC_GROUPS = [res("21000001", "subscriptionGroups", { referenceName: "Focus Pro" })];
const ASC_SUBS = [
  res("6510000001", "subscriptions", { name: "Focus Pro Monthly", productId: "focus_pro_monthly", subscriptionPeriod: "ONE_MONTH", state: "APPROVED", groupLevel: 1 }),
  res("6510000002", "subscriptions", { name: "Focus Pro Annual", productId: "focus_pro_annual", subscriptionPeriod: "ONE_YEAR", state: "APPROVED", groupLevel: 2 }),
  res("6510000003", "subscriptions", { name: "Focus Pro Weekly", productId: "focus_pro_weekly", subscriptionPeriod: "ONE_WEEK", state: "READY_TO_SUBMIT", groupLevel: 3 }),
];
const ASC_IAPS = [
  res("6610000001", "inAppPurchases", { name: "Focus Lifetime", productId: "focus_lifetime", inAppPurchaseType: "NON_CONSUMABLE", state: "APPROVED" }),
  res("6610000002", "inAppPurchases", { name: "100 focus coins", productId: "focus_coins_100", inAppPurchaseType: "CONSUMABLE", state: "APPROVED" }),
  res("6610000003", "inAppPurchases", { name: "Exam season pass", productId: "focus_season", inAppPurchaseType: "NON_RENEWING_SUBSCRIPTION", state: "WAITING_FOR_REVIEW" }),
];

function ascFetch(url: string, init: RequestInit): Response | null {
  const token = (new Headers(init.headers).get("authorization") ?? "").replace(/^Bearer /, "");
  const kid = b64json(token.split(".")[0]).kid;
  if (kid === E2E_ASC_FORBIDDEN_KEY_ID) return json(403, { errors: [{ status: "403", code: "FORBIDDEN_ERROR", title: "This request is forbidden for security reasons", detail: "The API key in use does not allow this request" }] });
  if (kid !== E2E_ASC_KEY_ID && kid !== E2E_ASC_EMPTY_KEY_ID) return null;
  const empty = kid === E2E_ASC_EMPTY_KEY_ID;
  const u = new URL(url);
  const page = (all: unknown[], size: number) => {
    const cursor = Number(u.searchParams.get("cursor") ?? 0);
    const q = new URLSearchParams(u.search); q.set("cursor", String(cursor + size));
    return json(200, { data: all.slice(cursor, cursor + size), links: { self: url, ...(cursor + size < all.length ? { next: `${u.origin}${u.pathname}?${q}` } : {}) } });
  };
  if (u.pathname === "/v1/apps") return json(200, { data: u.searchParams.get("filter[bundleId]") === E2E_IMPORT_BUNDLE ? [res("6400000099", "apps", { bundleId: E2E_IMPORT_BUNDLE, name: "Focus" })] : [] });
  if (u.pathname === "/v1/apps/6400000099/subscriptionGroups") return page(empty ? [] : ASC_GROUPS, 200);
  if (u.pathname === "/v1/subscriptionGroups/21000001/subscriptions") return page(ASC_SUBS, 200);
  if (u.pathname === "/v1/apps/6400000099/inAppPurchasesV2") return page(empty ? [] : ASC_IAPS, 2);
  return json(404, { errors: [{ status: "404", title: "The specified resource does not exist" }] });
}

const PLAY_TOKEN = "ya29.e2e-import-only";
const PLAY_DENIED_TOKEN = "ya29.e2e-import-denied";
async function playFetch(url: string, init: RequestInit): Promise<Response | null> {
  if (url === "https://oauth2.googleapis.com/token") {
    const assertion = new URLSearchParams(typeof init.body === "string" ? init.body : "").get("assertion") ?? "";
    const iss = b64json(assertion.split(".")[1]).iss;
    if (iss !== E2E_PLAY_EMAIL && iss !== E2E_PLAY_DENIED_EMAIL) return null;
    return json(200, { access_token: iss === E2E_PLAY_EMAIL ? PLAY_TOKEN : PLAY_DENIED_TOKEN, expires_in: 3599, token_type: "Bearer" });
  }
  const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${E2E_IMPORT_BUNDLE}`;
  const auth = new Headers(init.headers).get("authorization");
  if (!url.startsWith(base) || (auth !== `Bearer ${PLAY_TOKEN}` && auth !== `Bearer ${PLAY_DENIED_TOKEN}`)) return null;
  const u = new URL(url);
  const path = u.pathname.slice(new URL(base).pathname.length);
  if (auth === `Bearer ${PLAY_DENIED_TOKEN}`) return json(403, { error: { code: 403, message: "The caller does not have permission", status: "PERMISSION_DENIED", errors: [{ reason: "permissionDenied" }] } });
  if (path === "/subscriptions") {
    // Two pages, like Google's nextPageToken paging.
    if (u.searchParams.get("pageToken") === "page-2") {
      return json(200, { subscriptions: [{ packageName: E2E_IMPORT_BUNDLE, productId: "focus_family", listings: [{ languageCode: "en-US", title: "Focus Family" }], basePlans: [
        { basePlanId: "yearly", state: "ACTIVE", autoRenewingBasePlanType: { billingPeriodDuration: "P1Y" } },
      ] }] });
    }
    return json(200, { nextPageToken: "page-2", subscriptions: [{ packageName: E2E_IMPORT_BUNDLE, productId: "focus_premium", listings: [{ languageCode: "en-US", title: "Focus Premium" }], basePlans: [
      { basePlanId: "monthly", state: "ACTIVE", autoRenewingBasePlanType: { billingPeriodDuration: "P1M", legacyCompatible: true } },
      { basePlanId: "annual", state: "ACTIVE", autoRenewingBasePlanType: { billingPeriodDuration: "P1Y" } },
    ] }] });
  }
  if (path.startsWith("/purchases/voidedpurchases")) return json(200, {});
  if (path === "/oneTimeProducts") {
    return json(200, { oneTimeProducts: [{ packageName: E2E_IMPORT_BUNDLE, productId: "focus_unlock", listings: [{ languageCode: "en-US", title: "Focus Unlock" }], purchaseOptions: [{ purchaseOptionId: "buy", state: "ACTIVE", buyOption: { legacyCompatible: true } }] }] });
  }
  return json(404, { error: { code: 404, message: "Not found", status: "NOT_FOUND" } });
}

/**
 * App Store Connect and Google Play for the e2e store import, or null for anything else (the e2e server then answers
 * as if the store were down, as before). Only the key ids and service account in store-values.ts are served.
 */
export async function storeCatalogFetch(url: string, init: RequestInit = {}): Promise<Response | null> {
  if (url.startsWith("https://api.appstoreconnect.apple.com/")) return ascFetch(url, init);
  if (url.startsWith("https://oauth2.googleapis.com/token") || url.startsWith("https://androidpublisher.googleapis.com/")) return playFetch(url, init);
  return null;
}
