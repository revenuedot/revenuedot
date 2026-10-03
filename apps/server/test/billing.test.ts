import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { harness, type Harness } from "../../../packages/contract/src/harness.js";
import { FAKE_BILLING_KEY, FAKE_BILLING_PRICE, FAKE_BILLING_WEBHOOK_SECRET, FakeBillingStripe } from "../../../packages/contract/src/fake-billing-stripe.js";
import { createApp } from "../src/app.js";
import { defaultStores } from "../src/stores/index.js";
import { memoryMailer } from "../src/mail/index.js";
import { createSession } from "../src/services/sessions.js";
import { DEFAULT_PLANS, billCents, planOf } from "../src/services/billing/plans.js";
import { accountUsage, meterMonth, runBilling } from "../src/services/billing/meter.js";
import { stripeProblem, type BillingConfig } from "../src/services/billing/stripe.js";

/**
 * RevenueDot Cloud billing (prd/cloud-billing/PRD.md) against a fake of RevenueDot's own Stripe account: the bill, what
 * counts as tracked revenue, Checkout and the Portal, the meter, every webhook and dunning, usage emails, and that
 * self-host has no billing and a live key never runs by accident.
 */

const DAY = 86400_000;
let h: Harness;
let stripe: FakeBillingStripe;
let mail: ReturnType<typeof memoryMailer>;
let app: ReturnType<typeof createApp>;
let cookie = "";
const config = (over: Partial<BillingConfig> = {}): BillingConfig => ({ secretKey: FAKE_BILLING_KEY, webhookSecret: FAKE_BILLING_WEBHOOK_SECRET, priceStandard: FAKE_BILLING_PRICE, meterEvent: "revenuedot_cloud_bill_cents", live: false, ...over });

beforeEach(async () => {
  h = await harness();
  h.setNow(new Date("2026-10-15T12:00:00Z"));
  stripe = new FakeBillingStripe();
  stripe.clock = h.now;
  mail = memoryMailer();
  await h.db.insert(schema.users).values({ id: "usr_1", email: "founder@example.com", name: "Founder", emailVerifiedAt: h.now() });
  await h.db.update(schema.projects).set({ ownerUserId: "usr_1" });
  await h.db.insert(schema.memberships).values({ userId: "usr_1", projectId: "proj1", role: "admin" });
  app = createApp({ db: h.db, now: h.now, stores: defaultStores(), edition: "cloud", billing: config(), fetch: stripe.fetch, mailer: mail, publicUrl: "https://app.revenuedot.test" });
  cookie = `rd_session=${await createSession(h.db, "usr_1", h.now())}`;
});
afterEach(async () => { await h.close(); });

const call = async (method: string, path: string, body?: unknown, a = app) => {
  const res = await a.fetch(new Request(`https://app.revenuedot.test${path}`, { method, headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
  return { status: res.status, body: await res.json() as any };
};
const hook = async (type: string, object: Record<string, unknown>) => {
  const e = await stripe.event(type, object);
  const res = await app.fetch(new Request("https://api.revenuedot.test/v2/billing/stripe/webhook", { method: "POST", headers: { "stripe-signature": e.signature, "content-type": "application/json" }, body: e.body }));
  return { status: res.status, body: await res.json() as any };
};
let n = 0;
async function txn(o: { usd: number; at?: Date; kind?: string; sandbox?: boolean; project?: string; createdAt?: Date }) {
  const project = o.project ?? "proj1";
  const id = `t${++n}`;
  await h.db.insert(schema.customers).values({ id: `c_${id}`, projectId: project, originalAppUserId: `u_${id}` });
  await h.db.insert(schema.transactions).values({ id, projectId: project, customerId: `c_${id}`, store: "app_store", storeTransactionId: id, productIdentifier: "pro", kind: o.kind ?? "purchase", isSandbox: !!o.sandbox, purchasedAt: o.at ?? h.now(), revenueUsd: o.usd, createdAt: o.createdAt ?? h.now() });
}

describe("plans and the bill", () => {
  it("Free costs nothing; Standard is 0.5% above $10,000, rounded to the cent, capped at $999", () => {
    const std = planOf(DEFAULT_PLANS, "standard"), free = planOf(DEFAULT_PLANS, "free");
    expect(billCents(free, 50_000)).toBe(0);
    expect([0, 9_999.99, 10_000, 10_001, 50_000, 209_800, 2_000_000].map((x) => billCents(std, x))).toEqual([0, 0, 0, 1, 20_000, 99_900, 99_900]);
    expect(billCents(std, 10_000.99)).toBe(0);
    expect(billCents(std, 10_001.5)).toBe(1);
    expect(billCents(planOf(DEFAULT_PLANS, "enterprise"), 5_000_000)).toBe(0);
    expect(planOf(DEFAULT_PLANS, "unknown").id).toBe("free");
  });

  it("tracked revenue: production money in the month only; sandbox, trials, refunds and moved-in history do not count", async () => {
    await txn({ usd: 6000 });
    await txn({ usd: 5000, kind: "renewal" });
    await txn({ usd: 100_000, sandbox: true });
    await txn({ usd: 0, kind: "trial" });
    await txn({ usd: -500, kind: "refund" });
    await txn({ usd: 7000, at: new Date("2026-09-30T23:59:59Z") });
    await txn({ usd: 1, at: new Date("2026-11-01T00:00:00Z") });
    await h.db.insert(schema.projects).values({ id: "proj2", name: "Second", ownerUserId: "usr_1", movedInAt: new Date("2026-10-10T00:00:00Z") });
    await txn({ usd: 4000, project: "proj2", at: new Date("2026-10-05T00:00:00Z"), createdAt: new Date("2026-10-05T00:00:00Z") });
    await txn({ usd: 1000, project: "proj2", at: new Date("2026-10-12T00:00:00Z"), createdAt: new Date("2026-10-12T00:00:00Z") });
    await meterMonth(h.db, "2026-10", h.now());
    const u = await accountUsage(h.db, "usr_1", "2026-10");
    expect(u.tracked_revenue_usd).toBe(12_000);
    expect(u.projects).toEqual([
      { project_id: "proj1", name: "Scanner", tracked_revenue_usd: 11_000, transactions: 2 },
      { project_id: "proj2", name: "Second", tracked_revenue_usd: 1_000, transactions: 1 },
    ]);
    await meterMonth(h.db, "2026-09", h.now());
    expect((await accountUsage(h.db, "usr_1", "2026-09")).tracked_revenue_usd).toBe(7000);
  });
});

describe("billing page, upgrade and the meter", () => {
  it("Checkout carries the visitor's DataFast ids, so DataFast credits the payment to the channel that brought them", async () => {
    const withCookies = async (extra: string) => {
      const res = await app.fetch(new Request("https://app.revenuedot.test/v2/billing/checkout", { method: "POST", headers: { cookie: `${cookie}; ${extra}`, "content-type": "application/json" }, body: JSON.stringify({ plan: "standard" }) }));
      const body = await res.json() as any;
      return stripe.sessions.get(body.id)!;
    };
    const visitor = "a3ab2331-989f-4cfa-91c6-2461c9e3c6bd", visit = "0f2c5d7e-1b4a-4c1e-9d3f-7a6b5c4d3e2f";
    const s1 = await withCookies(`datafast_visitor_id=${visitor}; datafast_session_id=${visit}`);
    expect(s1.metadata).toMatchObject({ revenuedot_user_id: "usr_1", plan: "standard", datafast_visitor_id: visitor, datafast_session_id: visit });
    expect(s1.subscription_data.metadata).toMatchObject({ datafast_visitor_id: visitor, datafast_session_id: visit });
    // No cookies, or values that are not plain ids: nothing extra reaches Stripe.
    const s2 = await withCookies("other=1");
    expect(Object.keys(s2.metadata).sort()).toEqual(["plan", "revenuedot_user_id"]);
    const s3 = await withCookies("datafast_visitor_id=<script>alert(1)</script>");
    expect(Object.keys(s3.metadata).sort()).toEqual(["plan", "revenuedot_user_id"]);
  });

  it("free account over the limit: the page, one usage email, then Checkout, the webhook, the meter and the portal", async () => {
    await txn({ usd: 12_000 });
    await runBilling({ db: h.db, now: h.now(), fetch: stripe.fetch, mailer: mail, publicUrl: "https://app.revenuedot.test", config: config() });
    let page = await call("GET", "/v2/billing");
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ account: { plan: "free", status: "none" }, flags: ["over_free_limit"], stripe_ready: true, usage: { month: "2026-10", tracked_revenue_usd: 12_000, bill_usd: 0, standard_bill_usd: 10, free_limit_usd: 10_000, cap_usd: 999, ceiling_usd: 1_000_000 } });
    expect(page.body.plans.map((p: { id: string }) => p.id)).toEqual(["free", "standard", "enterprise"]);
    // Usage email: once, the 100% one (not also 80%), with the billing link.
    expect(mail.sent.map((m) => m.subject)).toEqual(["Your apps passed RevenueDot Cloud Free's $10,000 for October 2026"]);
    expect(mail.sent[0]!.text).toContain("https://app.revenuedot.test/account/billing");
    await runBilling({ db: h.db, now: h.now(), fetch: stripe.fetch, mailer: mail, config: config(), force: true });
    expect(mail.sent).toHaveLength(1);
    // Hourly: a second pass within the hour does nothing.
    expect(await runBilling({ db: h.db, now: new Date(h.now().getTime() + 60_000), fetch: stripe.fetch, mailer: mail, config: config() })).toBe(0);

    // Upgrade: a Stripe customer, then Checkout for the metered price anchored to Nov 1 without proration.
    const co = await call("POST", "/v2/billing/checkout", { plan: "standard" });
    expect(co.status).toBe(200);
    expect(co.body.url).toMatch(/^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_/);
    const [cust] = [...stripe.customers.values()];
    expect(cust).toMatchObject({ email: "founder@example.com", metadata: { revenuedot_user_id: "usr_1" } });
    const session = stripe.sessions.get(co.body.id)!;
    expect(session).toMatchObject({ customer: cust!.id, client_reference_id: "usr_1", success_url: "https://app.revenuedot.test/account/billing?checkout=success", subscription_data: { billing_cycle_anchor: String(Date.UTC(2026, 10, 1) / 1000), proration_behavior: "none" } });
    expect((await call("POST", "/v2/billing/checkout", { plan: "enterprise" })).status).toBe(400);
    // The webhook with a bad signature is refused; the real one makes the account Standard.
    const bad = await app.fetch(new Request("https://api.revenuedot.test/v2/billing/stripe/webhook", { method: "POST", headers: { "stripe-signature": "t=1,v1=00" }, body: "{}" }));
    expect(bad.status).toBe(400);
    const { subscription } = stripe.complete(session.id);
    expect((await hook("checkout.session.completed", stripe.sessions.get(session.id)!)).body.result).toBe("subscribed");
    expect((await hook("customer.subscription.created", subscription)).body.result).toBe("active");
    page = await call("GET", "/v2/billing");
    expect(page.body.account).toMatchObject({ plan: "standard", status: "active", has_payment_method: true });
    expect(page.body.usage.bill_usd).toBe(10);
    expect(page.body.flags).toEqual([]);
    expect((await call("GET", "/auth/me")).body.account).toMatchObject({ plan: "standard", billing_status: "active" });
    expect((await call("POST", "/v2/billing/checkout", { plan: "standard" })).status).toBe(409);

    // The meter gets the month's bill in cents, again only when it changes.
    await runBilling({ db: h.db, now: h.now(), fetch: stripe.fetch, mailer: mail, config: config(), force: true });
    expect(stripe.meterEvents.map((e) => ({ v: e.payload.value, c: e.payload.stripe_customer_id, id: e.identifier }))).toEqual([{ v: "1000", c: cust!.id, id: `rd-usr_1-2026-10-1000-${Math.floor(h.now().getTime() / 1000)}` }]);
    await runBilling({ db: h.db, now: h.now(), fetch: stripe.fetch, mailer: mail, config: config(), force: true });
    expect(stripe.meterEvents).toHaveLength(1);
    await txn({ usd: 300_000 });
    await runBilling({ db: h.db, now: h.now(), fetch: stripe.fetch, mailer: mail, config: config(), force: true });
    expect(stripe.meterEvents.at(-1)!.payload.value).toBe("99900");
    expect(mail.sent.at(-1)!.subject).toBe("Your RevenueDot bill for October 2026 reached the $999 cap");
    // After the month: the first days settle the month before (a late purchase still counts there; the bill stays at the
    // cap, so no new event), and the new month starts at $0.
    h.setNow(new Date("2026-11-01T06:00:00Z"));
    await txn({ usd: 100, at: new Date("2026-10-31T23:00:00Z") });
    const events = stripe.meterEvents.length;
    await runBilling({ db: h.db, now: h.now(), fetch: stripe.fetch, mailer: mail, config: config(), force: true });
    expect((await accountUsage(h.db, "usr_1", "2026-10")).tracked_revenue_usd).toBe(312_100);
    expect(stripe.meterEvents.length).toBe(events);
    // A change to last month's bill is dated that month's last second, so it lands in that period.
    await h.db.delete(schema.billingMeterReports).where(eq(schema.billingMeterReports.month, "2026-10"));
    await runBilling({ db: h.db, now: h.now(), fetch: stripe.fetch, mailer: mail, config: config(), force: true });
    expect(stripe.meterEvents.at(-1)).toMatchObject({ timestamp: Date.UTC(2026, 10, 1) / 1000 - 1, payload: { value: "99900" } });

    // Manage billing opens Stripe's portal.
    const portal = await call("POST", "/v2/billing/portal");
    expect(portal.body.url).toMatch(/^https:\/\/billing\.stripe\.com\/p\/session\//);
    expect(stripe.portalSessions[0]).toMatchObject({ customer: cust!.id, return_url: "https://app.revenuedot.test/account/billing" });
  });

  it("dunning: a failed payment emails once and marks past due, payment recovers it, unpaid goes back to Free; apps keep working", async () => {
    const co = await call("POST", "/v2/billing/checkout", { plan: "standard" });
    const { subscription } = stripe.complete(co.body.id);
    await hook("checkout.session.completed", stripe.sessions.get(co.body.id)!);
    const cust = subscription.customer as string;
    // The renewal charge fails: Stripe marks the subscription past due and keeps the invoice open.
    const inv = stripe.invoice(cust, { amount_due: 1234, status: "open", subscription: subscription.id, attempt_count: 1 });
    stripe.updateSubscription(subscription.id, { status: "past_due", latest_invoice: inv.id });
    expect((await hook("invoice.payment_failed", inv)).status).toBe(200);
    await hook("invoice.payment_failed", inv);
    await hook("customer.subscription.updated", stripe.subscriptions.get(subscription.id)!);
    let page = await call("GET", "/v2/billing");
    expect(page.body.account.status).toBe("past_due");
    expect(page.body.flags).toEqual(["past_due"]);
    expect(page.body.invoices).toEqual([expect.objectContaining({ id: inv.id, status: "open", amount_due: 12.34, hosted_invoice_url: inv.hosted_invoice_url })]);
    expect(mail.sent.filter((m) => m.subject === "Your RevenueDot payment failed")).toHaveLength(1);
    // Apps never notice billing.
    expect([200, 201]).toContain((await h.fetch("/v1/subscribers/anyone", { key: h.ids.iosKey })).status);
    // A retry succeeds.
    stripe.updateInvoice(inv.id, { status: "paid", amount_paid: 1234, attempt_count: 2 });
    stripe.updateSubscription(subscription.id, { status: "active" });
    await hook("invoice.paid", stripe.invoices.get(inv.id)!);
    page = await call("GET", "/v2/billing");
    expect(page.body.account.status).toBe("active");
    expect(mail.sent.at(-1)!.subject).toBe("Your RevenueDot payment went through");
    // Cancel at period end (Customer Portal), then retries run out on a later invoice: unpaid, back to Free.
    await hook("customer.subscription.updated", stripe.updateSubscription(subscription.id, { cancel_at_period_end: true }));
    expect((await call("GET", "/v2/billing")).body.account.cancel_at).toBe(subscription.items.data[0].current_period_end * 1000);
    await hook("customer.subscription.updated", stripe.updateSubscription(subscription.id, { status: "unpaid" }));
    page = await call("GET", "/v2/billing");
    expect(page.body.account).toMatchObject({ plan: "free", status: "unpaid" });
    expect(mail.sent.at(-1)!.subject).toBe("Your RevenueDot subscription moved to Cloud Free");
    await hook("customer.subscription.deleted", stripe.updateSubscription(subscription.id, { status: "canceled" }));
    expect((await call("GET", "/v2/billing")).body.account).toMatchObject({ plan: "free", status: "canceled", cancel_at: null });
    // An event for another account's customer changes nothing here.
    expect((await hook("customer.subscription.updated", { id: "sub_other", customer: "cus_nobody", status: "active" })).body.result).toBe("unknown customer");
  });

  it("near the Standard ceiling: the 80% email once", async () => {
    await h.db.insert(schema.billingAccounts).values({ userId: "usr_1", plan: "standard", status: "active", stripeCustomerId: null });
    await txn({ usd: 850_000 });
    await runBilling({ db: h.db, now: h.now(), fetch: stripe.fetch, mailer: mail, config: config(), force: true });
    expect(mail.sent.map((m) => m.subject)).toEqual(["Your RevenueDot bill for October 2026 reached the $999 cap", "Your apps are near Cloud Standard's $1,000,000 a month"]);
  });
});

describe("Stripe is the source of truth: order, repeats, lost and failed deliveries", () => {
  const upgrade = async () => {
    const co = await call("POST", "/v2/billing/checkout", { plan: "standard" });
    expect(co.status).toBe(200);
    return { sessionId: co.body.id as string, subscription: stripe.complete(co.body.id).subscription };
  };
  const account = async () => (await call("GET", "/v2/billing")).body.account;
  const userPlan = async () => (await h.db.select().from(schema.users).where(eq(schema.users.id, "usr_1")))[0]!.plan;

  it("events in reverse order and twice end in Stripe's current state", async () => {
    const { sessionId: session, subscription } = await upgrade();
    const createdSnap = stripe.snapshot(subscription);
    const completedSnap = stripe.snapshot(stripe.sessions.get(session)!);
    // The customer cancels at once; Stripe sends deleted, then the older events arrive late and twice.
    stripe.updateSubscription(subscription.id, { status: "canceled" });
    await hook("customer.subscription.deleted", stripe.snapshot(stripe.subscriptions.get(subscription.id)!));
    for (let i = 0; i < 2; i++) {
      await hook("customer.subscription.created", createdSnap);
      await hook("checkout.session.completed", completedSnap);
      await hook("customer.subscription.updated", { ...createdSnap, status: "active" });
    }
    expect(await account()).toMatchObject({ plan: "free", status: "canceled" });
    expect(await userPlan()).toBe("free");
  });

  it("an old 'active' event after a newer 'past_due' leaves the account past due", async () => {
    const { subscription } = await upgrade();
    const activeSnap = stripe.snapshot(subscription);
    await hook("customer.subscription.updated", stripe.updateSubscription(subscription.id, { status: "past_due" }));
    await hook("customer.subscription.updated", activeSnap);
    expect(await account()).toMatchObject({ plan: "standard", status: "past_due" });
  });

  it("a late payment_failed for an invoice already paid sends no email and changes nothing; recovery mail needs a failure mail first", async () => {
    const { subscription } = await upgrade();
    const inv = stripe.invoice(subscription.customer, { amount_due: 500, status: "paid", subscription: subscription.id, attempt_count: 1 });
    await hook("invoice.paid", inv);
    await hook("invoice.payment_failed", { ...stripe.snapshot(inv), status: "open", amount_paid: 0 });
    expect(await account()).toMatchObject({ plan: "standard", status: "active" });
    expect(mail.sent.filter((m) => /payment (failed|went through)/.test(m.subject))).toEqual([]);
  });

  it("when Stripe cannot be read the webhook answers 500 and writes nothing; Stripe's retry then lands", async () => {
    const { sessionId: session, subscription } = await upgrade();
    stripe.failReads = true;
    const r = await hook("checkout.session.completed", stripe.sessions.get(session)!);
    expect(r.status).toBe(500);
    expect((await account()).plan).toBe("free");
    stripe.failReads = false;
    expect((await hook("checkout.session.completed", stripe.sessions.get(session)!)).body.result).toBe("subscribed");
    expect(await account()).toMatchObject({ plan: "standard", status: "active" });
    expect((await h.db.select().from(schema.billingAccounts))[0]!.stripeSubscriptionId).toBe(subscription.id);
  });

  it("a lost webhook is repaired: the return from Checkout reads Stripe, and so does the hourly pass", async () => {
    const { subscription } = await upgrade();
    // No webhook at all. Back on the Billing page after Checkout:
    const page = await call("GET", "/v2/billing?sync=1");
    expect(page.body.account).toMatchObject({ plan: "standard", status: "active" });
    // Later the customer cancels in the portal and that webhook is lost too: the hourly pass catches it.
    stripe.updateSubscription(subscription.id, { status: "canceled" });
    await runBilling({ db: h.db, now: h.now(), fetch: stripe.fetch, mailer: mail, publicUrl: "https://app.revenuedot.test", config: config(), force: true });
    expect(await account()).toMatchObject({ plan: "free", status: "canceled" });
  });

  it("one subscription per account: Checkout expires older open sessions, refuses while Stripe has a live one, and a duplicate is cancelled", async () => {
    const first = await call("POST", "/v2/billing/checkout", { plan: "standard" });
    const second = await call("POST", "/v2/billing/checkout", { plan: "standard" });
    expect(stripe.sessions.get(first.body.id)!.status).toBe("expired");
    expect(() => stripe.complete(first.body.id)).toThrow(/expired/);
    const { subscription } = stripe.complete(second.body.id);
    // The webhook has not arrived, but Stripe already has the subscription: a third Checkout is refused, and the account syncs.
    const third = await call("POST", "/v2/billing/checkout", { plan: "standard" });
    expect(third.status).toBe(409);
    expect(await account()).toMatchObject({ plan: "standard", status: "active" });
    // A second live subscription appears anyway (made outside the app): it is cancelled, the first one stays.
    const dup = { ...stripe.snapshot(subscription), id: "sub_test_duplicate", created: subscription.created + 60 };
    stripe.subscriptions.set(dup.id, dup);
    await hook("customer.subscription.created", dup);
    expect(stripe.subscriptions.get(dup.id)!.status).toBe("canceled");
    expect(stripe.subscriptions.get(subscription.id)!.status).toBe("active");
    expect((await h.db.select().from(schema.billingAccounts))[0]!.stripeSubscriptionId).toBe(subscription.id);
  });

  it("a new subscription after an ended one becomes the account's; enterprise accounts are never moved by Stripe", async () => {
    const { subscription } = await upgrade();
    await hook("customer.subscription.deleted", stripe.updateSubscription(subscription.id, { status: "canceled" }));
    expect((await account()).status).toBe("canceled");
    const again = await upgrade();
    await hook("customer.subscription.created", again.subscription);
    expect(await account()).toMatchObject({ plan: "standard", status: "active" });
    expect((await h.db.select().from(schema.billingAccounts))[0]!.stripeSubscriptionId).toBe(again.subscription.id);
    await h.db.update(schema.billingAccounts).set({ plan: "enterprise", status: "active" });
    await hook("customer.subscription.deleted", stripe.updateSubscription(again.subscription.id, { status: "canceled" }));
    expect((await h.db.select().from(schema.billingAccounts))[0]).toMatchObject({ plan: "enterprise", status: "active" });
  });

  it("events about objects Stripe does not know are acknowledged and ignored", async () => {
    await upgrade();
    expect((await hook("invoice.paid", { id: "in_missing", customer: "cus_nobody" })).body.result).toBe("unknown to Stripe");
    expect((await hook("customer.subscription.updated", { id: "sub_x", customer: "cus_nobody", status: "active" })).body.result).toBe("unknown customer");
  });
});

describe("where billing does not run", () => {
  it("self-host has no billing at all", async () => {
    const selfHost = createApp({ db: h.db, now: h.now, stores: defaultStores(), billing: config(), fetch: stripe.fetch });
    const r = await call("GET", "/v2/billing", undefined, selfHost);
    expect(r.status).toBe(404);
    expect(r.body.message).toMatch(/only on RevenueDot Cloud/);
    expect((await call("GET", "/auth/me", undefined, selfHost)).body.account.billing_status).toBeNull();
  });

  it("Cloud without Stripe keys: usage is measured for the page, but no usage email goes out", async () => {
    await txn({ usd: 12_000 });
    await runBilling({ db: h.db, now: h.now(), fetch: stripe.fetch, mailer: mail, publicUrl: "https://app.revenuedot.test", config: null });
    await runBilling({ db: h.db, now: h.now(), fetch: stripe.fetch, mailer: mail, config: config({ secretKey: "" }), force: true });
    await runBilling({ db: h.db, now: h.now(), fetch: stripe.fetch, mailer: mail, config: config({ secretKey: "sk_live_abc" }), force: true });
    expect(mail.sent).toEqual([]);
    expect(stripe.calls).toEqual([]);
    expect((await accountUsage(h.db, "usr_1", "2026-10")).tracked_revenue_usd).toBe(12_000);
    expect(await h.db.select().from(schema.billingNotices)).toEqual([]);
    // Once Stripe is set up, the first pass sends the email it held back.
    await runBilling({ db: h.db, now: h.now(), fetch: stripe.fetch, mailer: mail, config: config(), force: true });
    expect(mail.sent.map((m) => m.subject)).toEqual(["Your apps passed RevenueDot Cloud Free's $10,000 for October 2026"]);
  });

  it("a live key without REVENUEDOT_BILLING_LIVE never reaches Stripe; no key means 'not set up yet'", async () => {
    expect(stripeProblem(config({ secretKey: "sk_live_abc" }))).toMatch(/REVENUEDOT_BILLING_LIVE/);
    expect(stripeProblem(config({ secretKey: "sk_live_abc", live: true }))).toBeNull();
    expect(stripeProblem(undefined)).toMatch(/not set up/);
    const live = createApp({ db: h.db, now: h.now, stores: defaultStores(), edition: "cloud", billing: config({ secretKey: "rk_live_abc" }), fetch: stripe.fetch });
    const before = stripe.calls.length;
    const r = await call("POST", "/v2/billing/checkout", { plan: "standard" }, live);
    expect(r.status).toBe(503);
    expect(stripe.calls.length).toBe(before);
    const none = createApp({ db: h.db, now: h.now, stores: defaultStores(), edition: "cloud" });
    const page = await call("GET", "/v2/billing", undefined, none);
    expect(page.body).toMatchObject({ stripe_ready: false, account: { plan: "free" } });
    // Until Stripe is set up the dashboard links no Billing page (production today); with it, it does.
    expect((await call("GET", "/auth/me", undefined, none)).body.account).toMatchObject({ edition: "cloud", billing_ready: false });
    expect((await call("GET", "/auth/me", undefined, live)).body.account.billing_ready).toBe(false);
    expect((await call("GET", "/auth/me")).body.account.billing_ready).toBe(true);
    // Without a session: 401.
    expect((await app.fetch(new Request("https://app.revenuedot.test/v2/billing"))).status).toBe(401);
    const [acct] = await h.db.select().from(schema.billingAccounts).where(eq(schema.billingAccounts.userId, "usr_1"));
    expect(acct).toBeUndefined();
    void DAY;
  });
});
