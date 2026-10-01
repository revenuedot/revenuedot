/**
 * Test helpers for the Stripe adapter: a fake Stripe API that serves objects in Stripe's documented shapes
 * (https://docs.stripe.com/api/subscriptions/object, /invoices/object, /checkout/sessions/object, /charges/object,
 * /events/object), Stripe-signed webhook events, and a Stripe app in the contract harness. No real key or endpoint is used.
 */
import { schema } from "@revenuedot/db";
import { harness, type Harness } from "../../../packages/contract/src/harness.js";
import { createApp } from "../src/app.js";
import { defaultStores } from "../src/stores/index.js";
import { createStripeStore, type StripeStore } from "../src/stores/stripe/index.js";
import type { StripeCharge, StripeCheckoutSession, StripeInvoice, StripeSubscription } from "../src/stores/stripe/api.js";
import { signStripePayload } from "../src/stores/stripe/signature.js";

export const KEY = "rk_test_51TestOnlyRevenueDotFakeKey000000000000000000";
export const WHSEC = "whsec_testonlyrevenuedotsigningsecret0000";
export const DAY = 86_400_000;
export const T0 = new Date("2026-09-01T12:00:00Z");
export const at = (days: number) => new Date(T0.getTime() + days * DAY);
export const s = (d: Date) => Math.floor(d.getTime() / 1000);

export const PRICE_MONTHLY = { id: "price_1PmMonthly", object: "price", active: true, currency: "usd", product: "prod_ProMonthly", recurring: { interval: "month", interval_count: 1 }, type: "recurring", unit_amount: 999 };
export const PRICE_ANNUAL = { id: "price_1PyAnnual", object: "price", active: true, currency: "usd", product: "prod_ProAnnual", recurring: { interval: "year", interval_count: 1 }, type: "recurring", unit_amount: 7999 };
export const PRICE_COINS = { id: "price_1Coins", object: "price", active: true, currency: "jpy", product: "prod_Coins", recurring: null, type: "one_time", unit_amount: 1200 };
export const PRICE_LIFETIME = { id: "price_1Lifetime", object: "price", active: true, currency: "usd", product: "prod_Lifetime", recurring: null, type: "one_time", unit_amount: 4999 };

/** An invoice like Stripe's (API before 2025-03-31 unless `basil`). */
export function invoice(o: { id: string; sub: string; start: Date; end: Date; reason?: string; status?: string; amount?: number; nextAttempt?: Date | null; basil?: boolean; currency?: string }): StripeInvoice & Record<string, unknown> {
  const paid = (o.status ?? "paid") === "paid";
  const amount = o.amount ?? 999;
  const out: Record<string, unknown> = {
    id: o.id, object: "invoice", account_country: "US", amount_due: amount, amount_paid: paid ? amount : 0, amount_remaining: paid ? 0 : amount, attempt_count: paid ? 1 : 2,
    billing_reason: o.reason ?? "subscription_create", collection_method: "charge_automatically", currency: o.currency ?? "usd", customer: "cus_TestCustomer1",
    customer_address: { city: null, country: "US", line1: null, line2: null, postal_code: "94107", state: null }, livemode: false,
    next_payment_attempt: o.nextAttempt ? s(o.nextAttempt) : null, period_start: s(o.start), period_end: s(o.end),
    status: o.status ?? "paid", total: amount,
    ...(o.basil ? { parent: { type: "subscription_details", subscription_details: { subscription: o.sub, metadata: {} } } } : { subscription: o.sub, paid }),
    status_transitions: { paid_at: paid ? s(o.start) : null, finalized_at: s(o.start) },
  };
  return out as unknown as StripeInvoice & Record<string, unknown>;
}

/** A subscription like Stripe's; `basil` moves the period to the item (API 2025-03-31 and later). */
export function subscription(o: {
  id?: string; price?: Record<string, unknown>; start?: Date; periodStart?: Date; periodEnd?: Date; status?: string; invoice: string;
  trialEnd?: Date | null; cancelAtPeriodEnd?: boolean; canceledAt?: Date | null; endedAt?: Date | null; cancelReason?: string | null;
  pause?: { behavior: string; resumes_at: number | null } | null; metadata?: Record<string, string>; basil?: boolean; livemode?: boolean;
}): StripeSubscription & Record<string, unknown> {
  const id = o.id ?? "sub_1TestSubscription";
  const start = o.start ?? T0, ps = o.periodStart ?? start, pe = o.periodEnd ?? at(30);
  const period = { current_period_start: s(ps), current_period_end: s(pe) };
  return {
    id, object: "subscription", application: null, billing_cycle_anchor: s(start), cancel_at: null, cancel_at_period_end: o.cancelAtPeriodEnd ?? false,
    canceled_at: o.canceledAt ? s(o.canceledAt) : null, cancellation_details: { comment: null, feedback: null, reason: o.cancelReason ?? null },
    collection_method: "charge_automatically", created: s(start), currency: "usd", customer: "cus_TestCustomer1", default_payment_method: "pm_1Test",
    discount: null, ended_at: o.endedAt ? s(o.endedAt) : null,
    items: { object: "list", data: [{ id: "si_Test1", object: "subscription_item", created: s(start), metadata: {}, price: (o.price ?? PRICE_MONTHLY) as never, quantity: 1, subscription: id, ...(o.basil ? period : {}) }], has_more: false, url: `/v1/subscription_items?subscription=${id}` },
    latest_invoice: o.invoice, livemode: o.livemode ?? false, metadata: o.metadata ?? { app_user_id: "web_user_1" }, pause_collection: o.pause ?? null,
    start_date: s(start), status: o.status ?? "active", trial_end: o.trialEnd ? s(o.trialEnd) : null, trial_start: o.trialEnd ? s(start) : null,
    ...(o.basil ? {} : period),
  } as unknown as StripeSubscription & Record<string, unknown>;
}

interface Call { url: string; method: string; auth: string | null; account: string | null; body: string; headers: Headers }
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const stripeError = (status: number, type: string, message: string, code?: string) => json(status, { error: { type, message, ...(code ? { code } : {}) } });

/** A fake Stripe API for one account: subscriptions, invoices, Checkout Sessions and invoice payments, read-only. */
export class FakeStripe {
  subs = new Map<string, StripeSubscription & Record<string, unknown>>();
  invoices = new Map<string, StripeInvoice & Record<string, unknown>>();
  sessions = new Map<string, StripeCheckoutSession & Record<string, unknown>>();
  invoicePayments = new Map<string, string>();
  key = KEY;
  calls: Call[] = [];
  forwarded: Call[] = [];
  override: ((url: string) => Response | Promise<Response> | undefined) | null = null;

  put(sub: StripeSubscription & Record<string, unknown>, ...invs: Array<StripeInvoice & Record<string, unknown>>) {
    this.subs.set(sub.id, sub);
    for (const i of invs) this.invoices.set(i.id, i);
    return sub;
  }
  apiCalls() { return this.calls.filter((c) => c.url.startsWith("https://api.stripe.com/")); }

  fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init.headers);
    const call = { url, method: (init.method ?? "GET").toUpperCase(), auth: headers.get("authorization"), account: headers.get("stripe-account"), body: typeof init.body === "string" ? init.body : "", headers };
    this.calls.push(call);
    const o = await this.override?.(url);
    if (o) return o;
    if (url.startsWith("https://hooks.example.com/")) { this.forwarded.push(call); return new Response(null, { status: 200 }); }
    if (!url.startsWith("https://api.stripe.com/v1/")) throw new Error(`unexpected fetch ${url}`);
    if (call.auth !== `Bearer ${this.key}`) return stripeError(401, "invalid_request_error", "Invalid API Key provided: rk_test_****0000");
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean).map(decodeURIComponent); // ["v1", "subscriptions", id]
    const expand = u.searchParams.getAll("expand[]");
    const list = (data: unknown[]) => json(200, { object: "list", data, has_more: false, url: u.pathname });
    if (parts[1] === "subscriptions") {
      if (!parts[2]) return list([...this.subs.values()].slice(0, 1));
      const sub = this.subs.get(parts[2]);
      if (!sub) return stripeError(404, "invalid_request_error", `No such subscription: '${parts[2]}'`, "resource_missing");
      const out = { ...sub } as Record<string, unknown>;
      if (expand.includes("latest_invoice") && typeof sub.latest_invoice === "string") out.latest_invoice = this.invoices.get(sub.latest_invoice) ?? sub.latest_invoice;
      return json(200, out);
    }
    if (parts[1] === "checkout" && parts[2] === "sessions") {
      if (!parts[3]) return list([]);
      const cs = this.sessions.get(parts[3]);
      if (!cs) return stripeError(404, "invalid_request_error", `No such checkout.session: '${parts[3]}'`, "resource_missing");
      const out = { ...cs } as Record<string, unknown>;
      if (!expand.includes("line_items")) delete out.line_items;
      return json(200, out);
    }
    if (parts[1] === "invoices" && parts[2]) {
      const inv = this.invoices.get(parts[2]);
      return inv ? json(200, inv) : stripeError(404, "invalid_request_error", `No such invoice: '${parts[2]}'`, "resource_missing");
    }
    if (parts[1] === "invoice_payments") {
      const pi = u.searchParams.get("payment[payment_intent]") ?? "";
      const inv = this.invoicePayments.get(pi);
      return list(inv ? [{ id: "inpay_1", object: "invoice_payment", invoice: inv, payment: { type: "payment_intent", payment_intent: pi } }] : []);
    }
    return stripeError(404, "invalid_request_error", `Unrecognized request URL (GET: ${u.pathname}).`);
  }) as typeof fetch;
}

export function checkoutSession(o: { id: string; mode: "payment" | "subscription"; sub?: string | null; status?: "open" | "complete" | "expired"; paymentStatus?: string; items?: Array<{ price: Record<string, unknown>; quantity?: number; amount: number; currency?: string }>; metadata?: Record<string, string>; customer?: string | null; pi?: string | null }): StripeCheckoutSession & Record<string, unknown> {
  const items = o.items ?? [];
  return {
    id: o.id, object: "checkout.session", amount_total: items.reduce((a, i) => a + i.amount, 0), client_reference_id: null, created: s(T0),
    currency: items[0]?.currency ?? "usd", customer: o.customer === undefined ? "cus_TestCustomer1" : o.customer,
    customer_details: { address: { country: "JP" }, email: "buyer@example.com", name: null }, livemode: false, metadata: o.metadata ?? { app_user_id: "web_user_1" },
    mode: o.mode, payment_intent: o.mode === "payment" ? (o.pi === undefined ? "pi_1TestPayment" : o.pi) : null, payment_status: o.paymentStatus ?? "paid", status: o.status ?? "complete",
    subscription: o.sub ?? null, url: null,
    line_items: { object: "list", has_more: false, data: items.map((i, n) => ({ id: `li_${n}`, object: "item", amount_subtotal: i.amount, amount_total: i.amount, currency: i.currency ?? "usd", description: "item", price: i.price as never, quantity: i.quantity ?? 1 })) },
  } as unknown as StripeCheckoutSession & Record<string, unknown>;
}

export function charge(o: { id?: string; amount: number; refunded?: number; invoice?: string | null; pi?: string; refundAt?: Date; currency?: string }): StripeCharge & Record<string, unknown> {
  const refunded = o.refunded ?? o.amount;
  return {
    id: o.id ?? "ch_1TestCharge", object: "charge", amount: o.amount, amount_captured: o.amount, amount_refunded: refunded, captured: true, currency: o.currency ?? "usd",
    customer: "cus_TestCustomer1", livemode: false, paid: true, payment_intent: o.pi ?? "pi_1TestPayment", refunded: refunded >= o.amount, status: "succeeded",
    ...(o.invoice !== undefined ? { invoice: o.invoice } : {}),
    refunds: { object: "list", data: [{ id: "re_1Test", object: "refund", amount: refunded, created: s(o.refundAt ?? T0), status: "succeeded" }], has_more: false },
  } as unknown as StripeCharge & Record<string, unknown>;
}

let eventSeq = 0;

export interface Env {
  h: Harness; st: FakeStripe; store: StripeStore; appId: string; key: string;
  call: (path: string, init?: RequestInit & { json?: unknown; key?: string | null }) => Promise<Response>;
  receipt: (body: Record<string, unknown>, key?: string) => Promise<Response>;
  webhook: (type: string, object: unknown, o?: { id?: string; secret?: string; signature?: string | null; tamper?: boolean; apiVersion?: string; created?: Date }) => Promise<Response>;
  events: (type?: string) => Promise<Array<Record<string, any>>>;
}

/** The contract harness plus a Stripe app (test-mode key and signing secret saved) and its catalog, wired to a fake Stripe. */
export async function env(credentials: Record<string, unknown> = {}): Promise<Env> {
  const h = await harness();
  const st = new FakeStripe();
  const store = createStripeStore({ fetch: st.fetch, now: h.now, timeoutMs: 200 });
  const app = createApp({ db: h.db, now: h.now, stores: { ...defaultStores(), stripe: store }, fetch: st.fetch });
  const appId = "app_stripe", key = "strp_testkey123";
  await h.db.insert(schema.apps).values({ id: appId, projectId: h.ids.project, name: "Scanner Web", type: "stripe", publicKey: key, credentials: { stripe_secret_key: KEY, stripe_webhook_secret: WHSEC, ...credentials } });
  const prods = [
    { id: "st_m", storeIdentifier: "prod_ProMonthly", type: "subscription", duration: "P1M" },
    { id: "st_y", storeIdentifier: "price_1PyAnnual", type: "subscription", duration: "P1Y" },
    { id: "st_coins", storeIdentifier: "prod_Coins", type: "consumable", duration: null },
    { id: "st_life", storeIdentifier: "prod_Lifetime", type: "non_consumable", duration: null },
  ];
  await h.db.insert(schema.products).values(prods.map((p) => ({ ...p, projectId: h.ids.project, appId, displayName: p.storeIdentifier })));
  await h.db.insert(schema.entitlementProducts).values(["st_m", "st_y", "st_life"].map((productId) => ({ entitlementId: "ent_pro", productId })));
  const call: Env["call"] = (path, init = {}) => {
    const headers = new Headers(init.headers);
    if (init.key) headers.set("Authorization", `Bearer ${init.key}`);
    let body = init.body;
    if (init.json !== undefined) { headers.set("content-type", "application/json"); body = JSON.stringify(init.json); }
    return Promise.resolve(app.fetch(new Request(`http://localhost${path}`, { ...init, headers, body })));
  };
  return {
    h, st, store, appId, key, call,
    receipt: (body, k) => call("/v1/receipts", { method: "POST", key: k ?? key, headers: { "X-Platform": "stripe" }, json: body }),
    webhook: async (type, object, o = {}) => {
      const created = o.created ?? h.now();
      const event = { id: o.id ?? `evt_1Test${++eventSeq}`, object: "event", api_version: o.apiVersion ?? "2024-06-20", created: s(created), data: { object }, livemode: false, pending_webhooks: 1, request: { id: null, idempotency_key: null }, type };
      const raw = JSON.stringify(event);
      const sig = o.signature !== undefined ? o.signature : await signStripePayload(o.secret ?? WHSEC, raw, s(h.now()));
      return call(`/v1/notifications/stripe/${appId}`, { method: "POST", headers: { "content-type": "application/json; charset=utf-8", ...(sig ? { "stripe-signature": sig } : {}) }, body: o.tamper ? raw.replace('"livemode":false', '"livemode":true') : raw });
    },
    events: async (type) => {
      const rows = await h.db.select().from(schema.events);
      return rows.map((r) => (r.payload as { event: Record<string, any> }).event).filter((ev) => !type || ev.type === type);
    },
  };
}
