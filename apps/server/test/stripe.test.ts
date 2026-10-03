import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { CustomerInfoSchema, ErrorSchema } from "../../../packages/contract/src/sdk-schemas.js";
import { tick } from "../src/services/tick.js";
import { secretKeyFrom, unseal } from "../src/services/secrets.js";
import { TEST_ENCRYPTION_KEY } from "./store-secret-helpers.js";
import { flushStoreForwards } from "../src/stores/forward.js";
import { signStripePayload, stripeSignature, verifyStripeSignature } from "../src/stores/stripe/signature.js";
import { fromMinor } from "../src/stores/stripe/map.js";
import {
  at, charge, checkoutSession, env, invoice, KEY, PRICE_ANNUAL, PRICE_COINS, PRICE_LIFETIME, PRICE_MONTHLY, s, subscription, T0, WHSEC, type Env,
} from "./stripe-helpers.js";

let e: Env;
beforeEach(async () => { e = await env(); });
afterEach(async () => { await e?.h.close(); });

const SUB = "sub_1TestSubscription";
const info = async (user: string) => CustomerInfoSchema.parse(await (await e.call(`/v1/subscribers/${user}`, { key: e.key })).json());
const txns = () => e.h.db.select().from(schema.transactions).where(eq(schema.transactions.store, "stripe"));

/** An active monthly subscription bought at T0 and posted by the developer's backend. */
async function bought(over: Partial<Parameters<typeof subscription>[0]> = {}) {
  e.st.put(subscription({ ...over, invoice: over.invoice ?? "in_1First" }), invoice({ id: "in_1First", sub: SUB, start: T0, end: at(30) }));
  const res = await e.receipt({ app_user_id: "web_user_1", fetch_token: SUB });
  expect(res.status).toBe(200);
  return res;
}

/** Stripe's next billing period: a new paid (or failed) renewal invoice and the subscription moved forward. */
function renew(o: { from: Date; to: Date; invoiceId: string; status?: string; subStatus?: string; nextAttempt?: Date | null; amount?: number; price?: Record<string, unknown> }) {
  e.st.invoices.set(o.invoiceId, invoice({ id: o.invoiceId, sub: SUB, start: o.from, end: o.to, reason: "subscription_cycle", status: o.status, nextAttempt: o.nextAttempt, amount: o.amount }));
  const cur = e.st.subs.get(SUB)!;
  const next = subscription({ invoice: o.invoiceId, periodStart: o.from, periodEnd: o.to, status: o.subStatus ?? "active", price: o.price, trialEnd: cur.trial_end ? new Date(cur.trial_end * 1000) : null });
  e.st.subs.set(SUB, next);
  return next;
}

describe("Stripe-Signature", () => {
  it("is HMAC-SHA256 over '<t>.<body>' in hex, as Stripe documents", async () => {
    const body = '{"id":"evt_1","object":"event"}';
    expect(await stripeSignature(WHSEC, 1_700_000_000, body)).toBe(createHmac("sha256", WHSEC).update(`1700000000.${body}`).digest("hex"));
    const now = new Date(1_700_000_100_000);
    await verifyStripeSignature(body, await signStripePayload(WHSEC, body, 1_700_000_000), WHSEC, now);
    // Several v1 values (a rolled secret): any match is enough; v0 is ignored.
    const real = await stripeSignature(WHSEC, 1_700_000_000, body);
    await verifyStripeSignature(body, `t=1700000000,v1=${"0".repeat(64)},v1=${real},v0=abc`, WHSEC, now);
  });

  it("refuses a wrong secret, a changed body, a missing header or v1, and a timestamp outside 5 minutes", async () => {
    const body = '{"id":"evt_1"}';
    const now = new Date(1_700_000_000_000);
    const good = await signStripePayload(WHSEC, body, 1_700_000_000);
    await expect(verifyStripeSignature(body, await signStripePayload("whsec_other", body, 1_700_000_000), WHSEC, now)).rejects.toThrow(/No signature/);
    await expect(verifyStripeSignature(body + " ", good, WHSEC, now)).rejects.toThrow(/No signature/);
    await expect(verifyStripeSignature(body, null, WHSEC, now)).rejects.toThrow(/missing/);
    await expect(verifyStripeSignature(body, "t=1700000000", WHSEC, now)).rejects.toThrow(/no v1/);
    await expect(verifyStripeSignature(body, good, WHSEC, new Date(1_700_000_301_000))).rejects.toThrow(/tolerance/);
    await verifyStripeSignature(body, good, WHSEC, new Date(1_700_000_299_000));
  });
});

describe("POST /v1/receipts with X-Platform: stripe", () => {
  it("reads a subscription from Stripe with the app's key and records it under the Stripe product id, test mode as sandbox", async () => {
    const res = await bought();
    const ci = CustomerInfoSchema.parse(await res.json());
    expect(ci.subscriber.subscriptions.prod_ProMonthly).toMatchObject({ store: "stripe", period_type: "normal", is_sandbox: true,
      purchase_date: "2026-09-01T12:00:00Z", expires_date: "2026-10-01T12:00:00Z", store_transaction_id: "in_1First" });
    expect(ci.subscriber.entitlements.pro).toMatchObject({ product_identifier: "prod_ProMonthly", expires_date: "2026-10-01T12:00:00Z" });
    const [ev] = await e.events("INITIAL_PURCHASE");
    expect(ev).toMatchObject({ store: "STRIPE", product_id: "prod_ProMonthly", price: 9.99, currency: "USD", environment: "SANDBOX", transaction_id: "in_1First",
      original_transaction_id: SUB, country_code: "US", app_user_id: "web_user_1", entitlement_ids: ["pro"], commission_percentage: 0 });
    const call = e.st.apiCalls()[0]!;
    expect(call.url).toBe(`https://api.stripe.com/v1/subscriptions/${SUB}?expand%5B%5D=latest_invoice&expand%5B%5D=items.data.price.currency_options`);
    expect(call.auth).toBe(`Bearer ${KEY}`);
    expect((await txns())[0]).toMatchObject({ kind: "purchase", revenueUsd: 9.99 });
    // Posting it again changes nothing.
    await e.receipt({ app_user_id: "web_user_1", fetch_token: SUB });
    expect(await e.events("INITIAL_PURCHASE")).toHaveLength(1);
  });

  it("a catalog product with the price id wins over the product id; a secret key with X-Platform stripe works; Stripe-Account is sent for Connect", async () => {
    await e.setCredentials({ stripe_secret_key: KEY, stripe_webhook_secret: WHSEC, stripe_account_id: "acct_1Connected" });
    e.st.put(subscription({ invoice: "in_A", price: PRICE_ANNUAL, periodEnd: at(365) }), invoice({ id: "in_A", sub: SUB, start: T0, end: at(365), amount: 7999 }));
    const res = await e.receipt({ app_user_id: "web_user_1", fetch_token: SUB }, e.h.ids.secretKey);
    expect(res.status).toBe(200);
    const ci = CustomerInfoSchema.parse(await res.json());
    expect(Object.keys(ci.subscriber.subscriptions)).toEqual(["price_1PyAnnual"]);
    expect(e.st.apiCalls()[0]!.account).toBe("acct_1Connected");
  });

  it("a Checkout Session: subscription mode records its subscription; payment mode records one-time purchases keyed by the PaymentIntent", async () => {
    e.st.put(subscription({ invoice: "in_1First" }), invoice({ id: "in_1First", sub: SUB, start: T0, end: at(30) }));
    e.st.sessions.set("cs_test_sub", checkoutSession({ id: "cs_test_sub", mode: "subscription", sub: SUB }));
    let ci = CustomerInfoSchema.parse(await (await e.receipt({ app_user_id: "web_user_1", fetch_token: "cs_test_sub" })).json());
    expect(ci.subscriber.subscriptions.prod_ProMonthly).toBeDefined();

    e.st.sessions.set("cs_test_pay", checkoutSession({ id: "cs_test_pay", mode: "payment", pi: "pi_1Coins", items: [{ price: PRICE_COINS, amount: 1200, currency: "jpy" }] }));
    const body = await (await e.receipt({ app_user_id: "web_user_1", fetch_token: "cs_test_pay" })).json();
    ci = CustomerInfoSchema.parse(body);
    expect(ci.subscriber.non_subscriptions.prod_Coins![0]).toMatchObject({ store: "stripe", store_transaction_id: "pi_1Coins", is_sandbox: true });
    expect(body.purchased_products.prod_Coins).toEqual({ should_consume: true });
    // JPY is a zero-decimal currency: 1200 is ¥1,200.
    expect((await e.events("NON_RENEWING_PURCHASE"))[0]).toMatchObject({ price_in_purchased_currency: 1200, currency: "JPY", country_code: "JP" });
    expect(e.st.apiCalls().some((c) => c.url.includes("/v1/checkout/sessions/cs_test_pay?expand%5B%5D=line_items"))).toBe(true);
  });

  it("answers 400 7103 for what can never succeed and 5xx 7101 for everything that can", async () => {
    const code = async (body: Record<string, unknown>) => { const r = await e.receipt({ app_user_id: "u", ...body }); return [r.status, ErrorSchema.parse(await r.json()).code]; };
    expect(await code({ fetch_token: "sub_missing" })).toEqual([400, 7103]);
    expect(await code({ fetch_token: "pi_123" })).toEqual([400, 7103]);
    expect(await code({})).toEqual([400, 7103]);
    e.st.sessions.set("cs_open", checkoutSession({ id: "cs_open", mode: "payment", status: "open", paymentStatus: "unpaid", items: [{ price: PRICE_LIFETIME, amount: 4999 }] }));
    expect(await code({ fetch_token: "cs_open" })).toEqual([503, 7101]);
    e.st.sessions.set("cs_exp", checkoutSession({ id: "cs_exp", mode: "payment", status: "expired", paymentStatus: "unpaid", items: [] }));
    expect(await code({ fetch_token: "cs_exp" })).toEqual([400, 7103]);
    e.st.put(subscription({ id: "sub_inc", invoice: "in_inc", status: "incomplete" }), invoice({ id: "in_inc", sub: "sub_inc", start: T0, end: at(30), status: "open" }));
    expect(await code({ fetch_token: "sub_inc" })).toEqual([503, 7101]);
    e.st.put(subscription({ id: "sub_dead", invoice: "in_dead", status: "incomplete_expired" }), invoice({ id: "in_dead", sub: "sub_dead", start: T0, end: at(30), status: "void" }));
    expect(await code({ fetch_token: "sub_dead" })).toEqual([400, 7103]);
    for (const status of [429, 500, 503]) {
      e.st.override = () => new Response(JSON.stringify({ error: { type: "api_error", message: "busy" } }), { status });
      expect(await code({ fetch_token: SUB })).toEqual([503, 7101]);
    }
    e.st.override = () => new Promise<Response>(() => {});
    expect(await code({ fetch_token: SUB })).toEqual([503, 7101]);
    e.st.override = null;
    e.st.key = "rk_test_rolled";
    expect(await code({ fetch_token: SUB })).toEqual([500, 7101]);
    const [app] = await e.h.db.select().from(schema.apps).where(eq(schema.apps.id, e.appId));
    expect(app!.credentialsStatus).toBe("failing");
    await e.setCredentials({});
    expect(await code({ fetch_token: SUB })).toEqual([500, 7101]);
  });

  it("with register_on invoice_created, a subscription whose first invoice is still open counts", async () => {
    await e.setCredentials({ stripe_secret_key: KEY, stripe_webhook_secret: WHSEC, register_on: "invoice_created" });
    e.st.put(subscription({ invoice: "in_open", status: "incomplete" }), invoice({ id: "in_open", sub: SUB, start: T0, end: at(30), status: "open" }));
    const res = await e.receipt({ app_user_id: "web_user_1", fetch_token: SUB });
    expect(res.status).toBe(200);
    expect((await info("web_user_1")).subscriber.entitlements.pro).toBeDefined();
  });
});

describe("Stripe webhooks", () => {
  it("refuses events without the signing secret, without or with a wrong signature, and applies nothing", async () => {
    await bought();
    renew({ from: at(30), to: at(60), invoiceId: "in_2" });
    e.h.setNow(at(30));
    let res = await e.webhook("customer.subscription.updated", e.st.subs.get(SUB), { signature: null });
    expect([res.status, (await res.json()).message]).toEqual([400, "The Stripe-Signature header is missing."]);
    res = await e.webhook("customer.subscription.updated", e.st.subs.get(SUB), { secret: "whsec_wrong" });
    expect(res.status).toBe(400);
    res = await e.webhook("customer.subscription.updated", e.st.subs.get(SUB), { tamper: true });
    expect(res.status).toBe(400);
    expect(await e.events("RENEWAL")).toHaveLength(0);
    // The store settings show the failure until a good event arrives.
    let settings = await (await e.call(`/v2/projects/${e.h.ids.project}/apps/${e.appId}/store_settings`, { key: e.h.ids.secretKey })).json();
    expect(settings).toMatchObject({ notification_status: "failing", notification_url: `http://localhost/v1/notifications/stripe/${e.appId}`,
      credentials: { stripe_secret_key: { configured: true, mode: "test", kind: "restricted", last4: KEY.slice(-4) }, stripe_webhook_secret: { configured: true } },
      stripe: { app_user_id_source: "metadata", app_user_id_metadata_key: "app_user_id", register_on: "invoice_paid" } });
    expect(JSON.stringify(settings)).not.toContain(KEY);
    expect(JSON.stringify(settings)).not.toContain(WHSEC);
    res = await e.webhook("customer.subscription.updated", e.st.subs.get(SUB), { id: "evt_good" });
    expect(await res.json()).toEqual({ status: "processed" });
    settings = await (await e.call(`/v2/projects/${e.h.ids.project}/apps/${e.appId}/store_settings`, { key: e.h.ids.secretKey })).json();
    expect(settings.notification_status).toBe("ready");

    await e.setCredentials({ stripe_secret_key: KEY });
    res = await e.webhook("customer.subscription.updated", e.st.subs.get(SUB));
    expect([res.status, (await res.json()).message]).toEqual([400, "Add the webhook signing secret (whsec_…) in the app's settings."]);
  });

  it("a renewal (invoice.paid) is RENEWAL at the invoice's amount; redelivered events are processed once; unrelated events are ignored", async () => {
    await bought();
    e.h.setNow(at(30));
    renew({ from: at(30), to: at(60), invoiceId: "in_2", amount: 899 });
    const res = await e.webhook("invoice.paid", e.st.invoices.get("in_2"), { id: "evt_paid_2" });
    expect(await res.json()).toEqual({ status: "processed" });
    expect((await e.events("RENEWAL"))[0]).toMatchObject({ price: 8.99, transaction_id: "in_2", purchased_at_ms: at(30).getTime(), expiration_at_ms: at(60).getTime() });
    expect(await (await e.webhook("invoice.paid", e.st.invoices.get("in_2"), { id: "evt_paid_2" })).json()).toEqual({ status: "duplicate" });
    // The same state again through another event records nothing.
    await e.webhook("customer.subscription.updated", e.st.subs.get(SUB));
    expect(await e.events("RENEWAL")).toHaveLength(1);
    expect((await txns()).map((t) => [t.kind, t.revenueUsd])).toEqual([["purchase", 9.99], ["renewal", 8.99]]);
    expect(await (await e.webhook("customer.created", { id: "cus_1", object: "customer" })).json()).toEqual({ status: "ignored" });
  });

  it("a trial is TRIAL at 0, and the first paid invoice after it is RENEWAL with is_trial_conversion", async () => {
    e.st.put(subscription({ invoice: "in_trial", status: "trialing", trialEnd: at(7), periodEnd: at(7) }), invoice({ id: "in_trial", sub: SUB, start: T0, end: at(7), amount: 0 }));
    expect((await e.receipt({ app_user_id: "web_user_1", fetch_token: SUB })).status).toBe(200);
    expect((await e.events("INITIAL_PURCHASE"))[0]).toMatchObject({ period_type: "TRIAL", price: 0, expiration_at_ms: at(7).getTime() });
    e.h.setNow(at(7));
    renew({ from: at(7), to: at(37), invoiceId: "in_conv" });
    await e.webhook("invoice.payment_succeeded", e.st.invoices.get("in_conv"));
    expect((await e.events("RENEWAL"))[0]).toMatchObject({ is_trial_conversion: true, period_type: "NORMAL", price: 9.99 });
  });

  it("cancel at period end is CANCELLATION (UNSUBSCRIBE), undoing it UNCANCELLATION, and deletion EXPIRATION", async () => {
    await bought();
    e.h.setNow(at(5));
    e.st.subs.set(SUB, subscription({ invoice: "in_1First", cancelAtPeriodEnd: true, canceledAt: at(5), cancelReason: "cancellation_requested" }));
    await e.webhook("customer.subscription.updated", e.st.subs.get(SUB));
    expect((await e.events("CANCELLATION"))[0]).toMatchObject({ cancel_reason: "UNSUBSCRIBE" });
    expect((await info("web_user_1")).subscriber.subscriptions.prod_ProMonthly!.unsubscribe_detected_at).toBe("2026-09-06T12:00:00Z");
    e.st.subs.set(SUB, subscription({ invoice: "in_1First" }));
    await e.webhook("customer.subscription.updated", e.st.subs.get(SUB));
    expect(await e.events("UNCANCELLATION")).toHaveLength(1);
    e.h.setNow(at(10));
    e.st.subs.set(SUB, subscription({ invoice: "in_1First", status: "canceled", canceledAt: at(10), endedAt: at(10), cancelReason: "cancellation_requested" }));
    await e.webhook("customer.subscription.deleted", e.st.subs.get(SUB));
    expect(await e.events("CANCELLATION")).toHaveLength(2);
    await tick(e.h.db, at(10), e.st.fetch);
    expect((await e.events("EXPIRATION"))[0]).toMatchObject({ expiration_reason: "UNSUBSCRIBE", store: "STRIPE" });
    expect((await info("web_user_1")).subscriber.entitlements.pro!.expires_date).toBe("2026-09-11T12:00:00Z");
  });

  it("a failed renewal (past_due) is BILLING_ISSUE and CANCELLATION (BILLING_ERROR) with grace until the next attempt; paying it is RENEWAL", async () => {
    await bought();
    e.h.setNow(new Date(at(30).getTime() + 3600_000));
    renew({ from: at(30), to: at(60), invoiceId: "in_2", status: "open", subStatus: "past_due", nextAttempt: at(33) });
    await e.webhook("invoice.payment_failed", e.st.invoices.get("in_2"));
    expect(await e.events("BILLING_ISSUE")).toHaveLength(1);
    expect((await e.events("CANCELLATION"))[0]).toMatchObject({ cancel_reason: "BILLING_ERROR" });
    expect(await e.events("RENEWAL")).toHaveLength(0);
    let ci = await info("web_user_1");
    expect(ci.subscriber.subscriptions.prod_ProMonthly).toMatchObject({ expires_date: "2026-10-01T12:00:00Z", grace_period_expires_date: "2026-10-04T12:00:00Z", store_transaction_id: "in_1First" });
    expect(ci.subscriber.entitlements.pro!.expires_date).toBe("2026-10-04T12:00:00Z");
    expect(await txns()).toHaveLength(1);
    e.h.setNow(at(32));
    renew({ from: at(30), to: at(60), invoiceId: "in_2" });
    await e.webhook("invoice.paid", e.st.invoices.get("in_2"));
    expect((await e.events("RENEWAL"))[0]).toMatchObject({ transaction_id: "in_2" });
    expect(await e.events("UNCANCELLATION")).toHaveLength(0);
    ci = await info("web_user_1");
    expect(ci.subscriber.subscriptions.prod_ProMonthly).toMatchObject({ billing_issues_detected_at: null, grace_period_expires_date: null, expires_date: "2026-10-31T12:00:00Z" });
  });

  it("retries running out (unpaid, then canceled for payment_failed) end access with EXPIRATION (BILLING_ERROR)", async () => {
    await bought();
    e.h.setNow(new Date(at(30).getTime() + 3600_000));
    renew({ from: at(30), to: at(60), invoiceId: "in_2", status: "open", subStatus: "past_due", nextAttempt: at(33) });
    await e.webhook("invoice.payment_failed", e.st.invoices.get("in_2"));
    e.h.setNow(at(34));
    renew({ from: at(30), to: at(60), invoiceId: "in_2", status: "open", subStatus: "unpaid", nextAttempt: null });
    await e.webhook("customer.subscription.updated", e.st.subs.get(SUB));
    await tick(e.h.db, at(34), e.st.fetch);
    expect((await e.events("EXPIRATION"))[0]).toMatchObject({ expiration_reason: "BILLING_ERROR" });
    expect(await e.events("BILLING_ISSUE")).toHaveLength(1);
  });

  it("pause_collection with a resume date is SUBSCRIPTION_PAUSED", async () => {
    await bought();
    e.h.setNow(at(3));
    e.st.subs.set(SUB, subscription({ invoice: "in_1First", pause: { behavior: "void", resumes_at: s(at(90)) } }));
    await e.webhook("customer.subscription.paused", e.st.subs.get(SUB));
    expect(await e.events("SUBSCRIPTION_PAUSED")).toHaveLength(1);
    expect((await info("web_user_1")).subscriber.entitlements.pro!.expires_date).toBe("2026-10-01T12:00:00Z");
  });

  it("switching to another price with a proration invoice is PRODUCT_CHANGE, not a renewal, and adds no revenue", async () => {
    await bought();
    e.h.setNow(at(10));
    e.st.invoices.set("in_prorate", invoice({ id: "in_prorate", sub: SUB, start: at(10), end: at(10), reason: "subscription_update", amount: 5332 }));
    e.st.subs.set(SUB, subscription({ invoice: "in_prorate", price: PRICE_ANNUAL }));
    await e.webhook("customer.subscription.updated", e.st.subs.get(SUB));
    expect((await e.events("PRODUCT_CHANGE"))[0]).toMatchObject({ product_id: "prod_ProMonthly", new_product_id: "price_1PyAnnual" });
    expect(await e.events("RENEWAL")).toHaveLength(0);
    expect(await txns()).toHaveLength(1);
    expect((await info("web_user_1")).subscriber.subscriptions.price_1PyAnnual).toMatchObject({ store_transaction_id: "in_1First" });
  });

  it("a full refund of the latest invoice is CANCELLATION (CUSTOMER_SUPPORT) and ends access; the next paid period is a RENEWAL, not a reversal", async () => {
    await bought();
    e.h.setNow(at(2));
    let res = await e.webhook("charge.refunded", charge({ amount: 999, refunded: 500, invoice: "in_1First" }));
    expect(await res.json()).toEqual({ status: "ignored" });
    res = await e.webhook("charge.refunded", charge({ amount: 999, invoice: "in_1First", refundAt: at(2) }));
    expect(await res.json()).toEqual({ status: "processed" });
    expect((await e.events("CANCELLATION"))[0]).toMatchObject({ cancel_reason: "CUSTOMER_SUPPORT", price: -9.99 });
    expect((await txns()).map((t) => [t.kind, t.revenueUsd])).toEqual([["purchase", 9.99], ["refund", -9.99]]);
    expect((await info("web_user_1")).subscriber.entitlements.pro!.expires_date).toBe("2026-09-03T12:00:00Z");
    // Re-reading the subscription keeps the refund.
    await e.webhook("customer.subscription.updated", e.st.subs.get(SUB));
    expect((await info("web_user_1")).subscriber.entitlements.pro!.expires_date).toBe("2026-09-03T12:00:00Z");
    e.h.setNow(at(30));
    renew({ from: at(30), to: at(60), invoiceId: "in_2" });
    await e.webhook("invoice.paid", e.st.invoices.get("in_2"));
    expect(await e.events("RENEWAL")).toHaveLength(1);
    expect(await e.events("REFUND_REVERSED")).toHaveLength(0);
  });

  it("a refunded one-time purchase is found through its PaymentIntent (API 2025-03-31: charges no longer name the invoice)", async () => {
    e.st.sessions.set("cs_life", checkoutSession({ id: "cs_life", mode: "payment", pi: "pi_1Life", items: [{ price: PRICE_LIFETIME, amount: 4999 }] }));
    await e.receipt({ app_user_id: "web_user_1", fetch_token: "cs_life" });
    e.h.setNow(at(1));
    const res = await e.webhook("charge.refunded", charge({ amount: 4999, pi: "pi_1Life", refundAt: at(1) }), { apiVersion: "2025-03-31.basil" });
    expect(await res.json()).toEqual({ status: "processed" });
    expect((await e.events("CANCELLATION"))[0]).toMatchObject({ cancel_reason: "CUSTOMER_SUPPORT", product_id: "prod_Lifetime", price: -49.99 });
    expect(e.st.apiCalls().some((c) => c.url.includes("/v1/invoice_payments?payment%5Btype%5D=payment_intent&payment%5Bpayment_intent%5D=pi_1Life"))).toBe(true);
  });

  it("reads API 2025-03-31 shapes: the period on the subscription item and the invoice's parent subscription", async () => {
    e.st.put(subscription({ invoice: "in_b1", basil: true }), invoice({ id: "in_b1", sub: SUB, start: T0, end: at(30), basil: true }));
    await e.receipt({ app_user_id: "web_user_1", fetch_token: SUB });
    expect((await info("web_user_1")).subscriber.subscriptions.prod_ProMonthly!.expires_date).toBe("2026-10-01T12:00:00Z");
    e.h.setNow(at(30));
    e.st.invoices.set("in_b2", invoice({ id: "in_b2", sub: SUB, start: at(30), end: at(60), reason: "subscription_cycle", basil: true }));
    e.st.subs.set(SUB, subscription({ invoice: "in_b2", periodStart: at(30), periodEnd: at(60), basil: true }));
    await e.webhook("invoice.paid", e.st.invoices.get("in_b2"), { apiVersion: "2025-03-31.basil" });
    expect((await e.events("RENEWAL"))[0]).toMatchObject({ transaction_id: "in_b2" });
  });

  it("unknown purchases are ignored unless the app tracks new purchases; then the customer comes from metadata, the customer id or an anonymous id", async () => {
    e.st.put(subscription({ invoice: "in_1First", metadata: {} }), invoice({ id: "in_1First", sub: SUB, start: T0, end: at(30) }));
    e.st.sessions.set("cs_new", checkoutSession({ id: "cs_new", mode: "subscription", sub: SUB, metadata: { uid: "from_session" } }));
    let res = await e.webhook("checkout.session.completed", e.st.sessions.get("cs_new"));
    expect(await res.json()).toEqual({ status: "unknown_purchase" });
    await e.setCredentials({ stripe_secret_key: KEY, stripe_webhook_secret: WHSEC, track_new_purchases: true, app_user_id_metadata_key: "uid" });
    res = await e.webhook("checkout.session.completed", e.st.sessions.get("cs_new"));
    expect(await res.json()).toEqual({ status: "processed" });
    expect((await e.events("INITIAL_PURCHASE"))[0]!.app_user_id).toBe("from_session");

    await e.setCredentials({ stripe_secret_key: KEY, stripe_webhook_secret: WHSEC, track_new_purchases: true, app_user_id_source: "customer_id" });
    e.st.put(subscription({ id: "sub_2", invoice: "in_x" }), invoice({ id: "in_x", sub: "sub_2", start: T0, end: at(30) }));
    await e.webhook("customer.subscription.created", e.st.subs.get("sub_2"));
    expect((await e.events("INITIAL_PURCHASE"))[1]!.app_user_id).toBe("cus_TestCustomer1");

    await e.setCredentials({ stripe_secret_key: KEY, stripe_webhook_secret: WHSEC, track_new_purchases: true, app_user_id_source: "anonymous" });
    e.st.put(subscription({ id: "sub_3", invoice: "in_y" }), invoice({ id: "in_y", sub: "sub_3", start: T0, end: at(30) }));
    await e.webhook("customer.subscription.created", e.st.subs.get("sub_3"));
    expect((await e.events("INITIAL_PURCHASE"))[2]!.app_user_id).toMatch(/^\$RCAnonymousID:/);

    // A subscription whose first invoice is unpaid waits for invoice.paid.
    e.st.put(subscription({ id: "sub_4", invoice: "in_z", status: "incomplete" }), invoice({ id: "in_z", sub: "sub_4", start: T0, end: at(30), status: "open" }));
    expect(await (await e.webhook("customer.subscription.created", e.st.subs.get("sub_4"))).json()).toEqual({ status: "ignored" });
  });

  it("customer.subscription.created before the Checkout Session: the anonymous customer is merged into the user the session's metadata names", async () => {
    await e.setCredentials({ stripe_secret_key: KEY, stripe_webhook_secret: WHSEC, track_new_purchases: true });
    e.st.put(subscription({ invoice: "in_1First", metadata: {} }), invoice({ id: "in_1First", sub: SUB, start: T0, end: at(30) }));
    e.st.sessions.set("cs_late", checkoutSession({ id: "cs_late", mode: "subscription", sub: SUB, metadata: { app_user_id: "web_user_9" } }));
    await e.webhook("customer.subscription.created", e.st.subs.get(SUB));
    expect((await e.events("INITIAL_PURCHASE"))[0]!.app_user_id).toMatch(/^\$RCAnonymousID:/);
    expect((await (await e.webhook("checkout.session.completed", e.st.sessions.get("cs_late"))).json())).toEqual({ status: "processed" });
    expect((await info("web_user_9")).subscriber.entitlements.pro).toBeDefined();
    expect(await e.events("INITIAL_PURCHASE")).toHaveLength(1);
    expect((await e.events("SUBSCRIBER_ALIAS")).map((x) => x.app_user_id)).toEqual(["web_user_9"]);
  });

  it("Stripe outages answer 500 so Stripe retries; the retry is processed; events are forwarded with their signature", async () => {
    await e.h.db.update(schema.apps).set({ notificationForwardUrl: "https://hooks.example.com/stripe" }).where(eq(schema.apps.id, e.appId));
    await bought();
    e.h.setNow(at(30));
    renew({ from: at(30), to: at(60), invoiceId: "in_2" });
    e.st.override = (url) => (url.startsWith("https://api.stripe.com/") ? new Response('{"error":{"type":"api_error","message":"busy"}}', { status: 500 }) : undefined);
    let res = await e.webhook("invoice.paid", e.st.invoices.get("in_2"), { id: "evt_retry" });
    expect(res.status).toBe(500);
    e.st.override = null;
    res = await e.webhook("invoice.paid", e.st.invoices.get("in_2"), { id: "evt_retry" });
    expect(await res.json()).toEqual({ status: "processed" });
    await flushStoreForwards();
    expect(e.st.forwarded).toHaveLength(1);
    expect(JSON.parse(e.st.forwarded[0]!.body).id).toBe("evt_retry");
    expect(e.st.forwarded[0]!.headers.get("stripe-signature")).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  });
});

describe("Stripe app setup (v2)", () => {
  const P = () => `/v2/projects/${e.h.ids.project}`;
  const v2 = (method: string, path: string, json?: unknown) => e.call(path, { method, key: e.h.ids.secretKey, ...(json === undefined ? {} : { json }) });

  it("creates a Stripe app with its key and secret, never returns them, and refuses a publishable key or a malformed secret", async () => {
    let res = await v2("POST", `${P()}/apps`, { name: "Web", type: "stripe", stripe: { stripe_secret_key: "pk_test_123", stripe_webhook_secret: WHSEC } });
    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/publishable key/);
    res = await v2("POST", `${P()}/apps`, { name: "Web", type: "stripe", stripe: { stripe_secret_key: KEY, stripe_webhook_secret: "secret" } });
    expect((await res.json()).param).toBe("stripe.stripe_webhook_secret");
    res = await v2("POST", `${P()}/apps`, { name: "Web", type: "stripe", stripe: { stripe_secret_key: KEY, stripe_webhook_secret: WHSEC, stripe_account_id: "acct_1X", register_on: "invoice_created", app_user_id_source: "customer_id" } });
    expect(res.status).toBe(201);
    const app = await res.json();
    expect(app).toMatchObject({ type: "stripe", stripe: { stripe_account_id: "acct_1X" } });
    expect(app.id).toMatch(/^app/);
    const keys = await (await v2("GET", `${P()}/apps/${app.id}/public_api_keys`)).json();
    expect(keys.items[0].key).toMatch(/^strp_/);
    expect(JSON.stringify(app)).not.toContain(KEY);
    // The key and the signing secret are sealed; the API shows only that they are set, and the key's mode and last four.
    const [row] = await e.h.db.select().from(schema.apps).where(eq(schema.apps.id, app.id));
    expect(row!.credentials).toEqual({ stripe_account_id: "acct_1X", register_on: "invoice_created", app_user_id_source: "customer_id" });
    expect(row!.secretHints).toEqual({ stripe_secret_key: `rk_test_…${KEY.slice(-4)}`, stripe_webhook_secret: "set" });
    expect(row!.secrets).toMatch(/^v1:/);
    expect(row!.secrets).not.toContain(KEY.slice(8));
    expect(await unseal(row!.secrets, await secretKeyFrom(TEST_ENCRYPTION_KEY))).toEqual({ stripe_secret_key: KEY, stripe_webhook_secret: WHSEC });
    const settings = await (await v2("GET", `${P()}/apps/${app.id}/store_settings`)).json();
    expect(settings.credentials).toMatchObject({ stripe_secret_key: { configured: true, mode: "test", kind: "restricted", last4: KEY.slice(-4) }, stripe_webhook_secret: { configured: true } });
    expect(JSON.stringify(settings)).not.toContain(KEY);
    expect(JSON.stringify(settings)).not.toContain(WHSEC);
    // Replacing one secret keeps the other.
    res = await v2("POST", `${P()}/apps/${app.id}`, { stripe: { stripe_webhook_secret: "whsec_rolled" } });
    expect(res.status).toBe(200);
    const [rolled] = await e.h.db.select().from(schema.apps).where(eq(schema.apps.id, app.id));
    expect(await unseal(rolled!.secrets, await secretKeyFrom(TEST_ENCRYPTION_KEY))).toEqual({ stripe_secret_key: KEY, stripe_webhook_secret: "whsec_rolled" });
    res = await v2("POST", `${P()}/apps/${app.id}`, { stripe: { register_on: "sometimes" } });
    expect((await res.json()).param).toBe("stripe.register_on");
  });

  it("verify_credentials lists a subscription and a Checkout Session: 401 is a bad key, 403 names the missing permission", async () => {
    let r = await (await v2("POST", `${P()}/apps/${e.appId}/actions/verify_credentials`, {})).json();
    expect(r).toMatchObject({ status: "valid", valid: true, message: "Stripe accepted the test mode key.", mode: "test" });
    expect(e.st.apiCalls().map((c) => new URL(c.url).pathname)).toEqual(["/v1/subscriptions", "/v1/checkout/sessions"]);
    r = await (await v2("POST", `${P()}/apps/${e.appId}/actions/verify_credentials`, { stripe: { stripe_secret_key: "rk_live_other" } })).json();
    expect(r).toMatchObject({ status: "invalid", mode: "live" });
    expect(r.message).toMatch(/rejected the key/);
    e.st.override = () => new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "The provided key 'rk_test_***' does not have the required permissions for this endpoint on account 'acct_1'. Having the 'rak_checkout_session_read' permission would allow this request to continue." } }), { status: 403 });
    r = await (await v2("POST", `${P()}/apps/${e.appId}/actions/verify_credentials`, {})).json();
    expect(r.status).toBe("invalid");
    expect(r.message).toMatch(/rak_checkout_session_read/);
    e.st.override = () => new Response("", { status: 502 });
    r = await (await v2("POST", `${P()}/apps/${e.appId}/actions/verify_credentials`, {})).json();
    expect(r.status).toBe("unreachable");
  });
});

describe("Stripe trust boundaries", () => {
  it("Stripe API requests never follow a redirect; one is a 5xx so the backend retries", async () => {
    e.st.put(subscription({ invoice: "in_1First" }), invoice({ id: "in_1First", sub: SUB, start: T0, end: at(30) }));
    e.st.override = (url) => (url.startsWith("https://api.stripe.com/") ? new Response(null, { status: 302, headers: { location: "https://attacker.example.com/" } }) : undefined);
    const res = await e.receipt({ app_user_id: "web_user_1", fetch_token: SUB });
    expect([res.status, (await res.json()).code]).toEqual([503, 7101]);
    e.st.override = null;
    expect((await e.receipt({ app_user_id: "web_user_1", fetch_token: SUB })).status).toBe(200);
    expect(e.st.apiCalls().length).toBeGreaterThan(1);
    for (const c of e.st.apiCalls()) expect(c.redirect).toBe("manual");
  });

  it("a subscription posted again after a refund keeps the refund (no REFUND_REVERSED, no revenue back)", async () => {
    await bought();
    e.h.setNow(at(2));
    await e.webhook("charge.refunded", charge({ amount: 999, invoice: "in_1First", refundAt: at(2) }));
    expect((await e.receipt({ app_user_id: "web_user_1", fetch_token: SUB })).status).toBe(200);
    expect(await e.events("REFUND_REVERSED")).toHaveLength(0);
    expect((await txns()).map((t) => t.kind)).toEqual(["purchase", "refund"]);
    expect((await info("web_user_1")).subscriber.entitlements.pro!.expires_date).toBe("2026-09-03T12:00:00Z");
  });

  it("a one-time Checkout purchase posted again after a refund stays refunded", async () => {
    e.st.sessions.set("cs_life", checkoutSession({ id: "cs_life", mode: "payment", pi: "pi_1Life", items: [{ price: PRICE_LIFETIME, amount: 4999 }] }));
    await e.receipt({ app_user_id: "web_user_1", fetch_token: "cs_life" });
    e.h.setNow(at(1));
    await e.webhook("charge.refunded", charge({ amount: 4999, pi: "pi_1Life", invoice: null, refundAt: at(1) }));
    await e.receipt({ app_user_id: "web_user_1", fetch_token: "cs_life" });
    expect(await e.events("REFUND_REVERSED")).toHaveLength(0);
  });

  it("a body with a bad signature never takes a real event's id and is never forwarded", async () => {
    await e.h.db.update(schema.apps).set({ notificationForwardUrl: "https://hooks.example.com/stripe" }).where(eq(schema.apps.id, e.appId));
    await bought();
    e.h.setNow(at(30));
    renew({ from: at(30), to: at(60), invoiceId: "in_2" });
    expect((await e.webhook("invoice.paid", e.st.invoices.get("in_2"), { id: "evt_real", secret: "whsec_forged" })).status).toBe(400);
    expect(await (await e.webhook("invoice.paid", e.st.invoices.get("in_2"), { id: "evt_real" })).json()).toEqual({ status: "processed" });
    await flushStoreForwards();
    expect(e.st.forwarded).toHaveLength(1);
    expect(await e.events("RENEWAL")).toHaveLength(1);
  });

  it("three-decimal currencies are thousandths (KWD 1.500 is 1500), zero-decimal ones whole units", () => {
    expect([fromMinor(1500, "kwd"), fromMinor(1200, "JPY"), fromMinor(999, "usd")]).toEqual([1.5, 1200, 9.99]);
  });
});

describe("Stripe edge cases", () => {
  const sub = async () => (await e.h.db.select().from(schema.subscriptions).where(eq(schema.subscriptions.storeKey, SUB)))[0]!;

  it("with register_on invoice_created, a period first seen with an open invoice costs what is due, and paying it adds nothing", async () => {
    await e.setCredentials({ stripe_secret_key: KEY, stripe_webhook_secret: WHSEC, register_on: "invoice_created" });
    e.st.put(subscription({ invoice: "in_open", status: "incomplete" }), invoice({ id: "in_open", sub: SUB, start: T0, end: at(30), status: "open" }));
    expect((await e.receipt({ app_user_id: "web_user_1", fetch_token: SUB })).status).toBe(200);
    expect((await e.events("INITIAL_PURCHASE"))[0]).toMatchObject({ price: 9.99, transaction_id: "in_open" });
    e.h.setNow(at(1));
    e.st.put(subscription({ invoice: "in_open" }), invoice({ id: "in_open", sub: SUB, start: T0, end: at(30) }));
    expect(await (await e.webhook("invoice.paid", e.st.invoices.get("in_open"))).json()).toEqual({ status: "processed" });
    expect(await e.events("RENEWAL")).toHaveLength(0);
    expect((await txns()).map((t) => [t.kind, t.revenueUsd])).toEqual([["purchase", 9.99]]);
    expect((await sub()).priceAmount).toBe(9.99);
  });

  it("a period stored at a placeholder price of 0 takes the paid amount, and its purchase revenue is corrected", async () => {
    await e.setCredentials({ stripe_secret_key: KEY, stripe_webhook_secret: WHSEC, register_on: "invoice_created" });
    e.st.put(subscription({ invoice: "in_open", status: "incomplete" }), invoice({ id: "in_open", sub: SUB, start: T0, end: at(30), status: "open" }));
    await e.receipt({ app_user_id: "web_user_1", fetch_token: SUB });
    // What an earlier version stored: amount_paid (0) of the open invoice.
    await e.h.db.update(schema.subscriptions).set({ priceAmount: 0, priceUsd: 0 }).where(eq(schema.subscriptions.storeKey, SUB));
    await e.h.db.update(schema.transactions).set({ revenueUsd: 0, priceAmount: 0 }).where(eq(schema.transactions.store, "stripe"));
    e.h.setNow(at(1));
    e.st.put(subscription({ invoice: "in_open" }), invoice({ id: "in_open", sub: SUB, start: T0, end: at(30) }));
    await e.webhook("invoice.paid", e.st.invoices.get("in_open"));
    expect((await sub()).priceAmount).toBe(9.99);
    expect((await txns()).map((t) => [t.kind, t.revenueUsd, t.priceAmount])).toEqual([["purchase", 9.99, 9.99]]);
    expect(await e.events("RENEWAL")).toHaveLength(0);
  });

  it("a paused subscription read again later keeps its access end (no SUBSCRIPTION_EXTENDED)", async () => {
    await bought();
    e.h.setNow(at(3));
    e.st.subs.set(SUB, subscription({ invoice: "in_1First", status: "paused" }));
    await e.webhook("customer.subscription.paused", e.st.subs.get(SUB));
    expect((await info("web_user_1")).subscriber.subscriptions.prod_ProMonthly!.expires_date).toBe("2026-09-04T12:00:00Z");
    e.h.setNow(at(4));
    await e.webhook("customer.subscription.updated", e.st.subs.get(SUB));
    e.h.setNow(at(5));
    expect((await e.receipt({ app_user_id: "web_user_1", fetch_token: SUB })).status).toBe(200);
    expect(await e.events("SUBSCRIPTION_EXTENDED")).toHaveLength(0);
    expect((await info("web_user_1")).subscriber.subscriptions.prod_ProMonthly!.expires_date).toBe("2026-09-04T12:00:00Z");
  });

  it("a canceled subscription without ended_at or canceled_at keeps its access end on later reads", async () => {
    await bought();
    e.h.setNow(at(3));
    e.st.subs.set(SUB, subscription({ invoice: "in_1First", status: "canceled" }));
    await e.webhook("customer.subscription.deleted", e.st.subs.get(SUB));
    e.h.setNow(at(4));
    await e.webhook("customer.subscription.updated", e.st.subs.get(SUB));
    expect(await e.events("SUBSCRIPTION_EXTENDED")).toHaveLength(0);
    expect((await info("web_user_1")).subscriber.subscriptions.prod_ProMonthly!.expires_date).toBe("2026-09-04T12:00:00Z");
  });

  it("a key in the wrong mode is a credentials problem: 500 7101 so the backend retries, and the app's credentials are failing", async () => {
    e.st.override = (url) => (url.startsWith(`https://api.stripe.com/v1/subscriptions/sub_live`)
      ? new Response(JSON.stringify({ error: { type: "invalid_request_error", code: "resource_missing", message: "No such subscription: 'sub_live'; a similar object exists in live mode, but a test mode key was used to make this request." } }), { status: 404 })
      : undefined);
    const res = await e.receipt({ app_user_id: "web_user_1", fetch_token: "sub_live" });
    expect([res.status, ErrorSchema.parse(await res.json()).code]).toEqual([500, 7101]);
    const [app] = await e.h.db.select().from(schema.apps).where(eq(schema.apps.id, e.appId));
    expect(app!.credentialsStatus).toBe("failing");
    expect(app!.credentialsError).toMatch(/in live mode, but the app's Stripe key is a test mode key/);
    expect((await e.webhook("customer.subscription.updated", { id: "sub_live", object: "subscription" })).status).toBe(500);
    // A plain "no such subscription" is still a bad receipt.
    const missing = await e.receipt({ app_user_id: "web_user_1", fetch_token: "sub_missing" });
    expect([missing.status, ErrorSchema.parse(await missing.json()).code]).toEqual([400, 7103]);
  });

  it("the list price is in the subscription's currency: its currency_options entry, else labelled with the price's own currency", async () => {
    const multi = { ...PRICE_MONTHLY, currency_options: { usd: { unit_amount: 999 }, eur: { unit_amount: 899 } } };
    // No invoice to read (latest_invoice is not found), so the price comes from the subscription item.
    e.st.put({ ...subscription({ invoice: "in_gone", price: multi }), currency: "eur" });
    await e.receipt({ app_user_id: "web_user_1", fetch_token: SUB });
    expect((await e.events("INITIAL_PURCHASE"))[0]).toMatchObject({ price_in_purchased_currency: 8.99, currency: "EUR" });
    e.st.put({ ...subscription({ id: "sub_2", invoice: "in_gone", price: PRICE_MONTHLY }), currency: "eur" });
    await e.receipt({ app_user_id: "web_user_2", fetch_token: "sub_2" });
    expect((await e.events("INITIAL_PURCHASE"))[1]).toMatchObject({ price_in_purchased_currency: 9.99, currency: "USD" });
  });

  it("verify_credentials checks a new key in the body when the stored secrets cannot be opened", async () => {
    await e.h.db.update(schema.apps).set({ secrets: "v1:not-openable" }).where(eq(schema.apps.id, e.appId));
    const verify = (json: unknown) => e.call(`/v2/projects/${e.h.ids.project}/apps/${e.appId}/actions/verify_credentials`, { method: "POST", key: e.h.ids.secretKey, json });
    let r = await (await verify({})).json();
    expect(r).toMatchObject({ status: "invalid" });
    expect(r.message).toMatch(/could not be opened/);
    r = await (await verify({ stripe: { stripe_secret_key: KEY } })).json();
    expect(r).toMatchObject({ status: "valid", mode: "test" });
    r = await (await verify({ stripe: { stripe_secret_key: "rk_test_wrong" } })).json();
    expect(r).toMatchObject({ status: "invalid" });
    expect(r.message).toMatch(/rejected the key/);
  });
});
