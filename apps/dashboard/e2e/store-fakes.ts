/**
 * Fake Amazon RVS and Stripe API for the e2e server, so "Check credentials", receipts and webhooks run through the real
 * server code without ever reaching Amazon or Stripe. Only these test values are accepted.
 * Web billing (web.spec.ts) uses its own key, FAKE_STRIPE_KEY: those calls go to `webStripe`, a stateful in-memory Stripe
 * account (products, prices, Checkout Sessions, coupons, promotion codes) shared with the contract tests.
 */
import { createAmazonStore } from "@revenuedot/server/stores/amazon/index.js";
import { createStripeStore } from "@revenuedot/server/stores/stripe/index.js";

import { E2E_AMAZON_SECRET, E2E_STRIPE_KEY, E2E_STRIPE_SUB } from "./store-values.ts";
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
