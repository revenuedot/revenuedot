import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { harness, type Harness } from "../../../packages/contract/src/harness.js";
import { FAKE_BILLING_KEY, FAKE_BILLING_PRICE, FAKE_BILLING_WEBHOOK_SECRET, FakeBillingStripe } from "../../../packages/contract/src/fake-billing-stripe.js";
import { createApp } from "../src/app.js";
import { defaultStores } from "../src/stores/index.js";
import { memoryMailer } from "../src/mail/index.js";
import { createSession } from "../src/services/sessions.js";
import { runGate } from "../src/services/billing/meter.js";
import { EXISTING_GRACE_DAYS, GATE_SHIPPED, GRACE_DAYS, HOLD_DAYS, gateOf, holdAndRelease, markLive } from "../src/services/billing/gate.js";
import { needsPlan } from "../src/routes/v2/live-gate.js";
import { PRO_CHECKOUT_TEXT, type BillingConfig } from "../src/services/billing/stripe.js";
import { tick } from "../src/services/tick.js";

/**
 * The go-live gate of RevenueDot Cloud (prd/cloud-billing/PRD.md, "The go-live gate"): building and testing are free; the
 * first live sale starts 14 days to start Pro; after them, without a plan, live data answers 402 plan_required and
 * production webhook and integration deliveries are held until Pro starts. The SDK, purchases and entitlements never stop.
 */

const DAY = 86_400_000;
const T0 = new Date("2026-10-15T12:00:00Z");
const P = "/v2/projects/proj1";
const OWNER_402 = "Live data is paused because this account has no plan. Start Pro on the Billing page: it costs $0 until your apps make $10,000 a month.";
const KEY_402 = "Live data is paused because this project's owner has no plan. The owner can start Pro on the Billing page: it costs $0 until their apps make $10,000 a month.";
const MEMBER_402 = "Live data is paused because the project owner, Founder, has not started Pro. Ask them to start it on their Billing page: it costs $0 until their apps make $10,000 a month.";
const SUBJECT = { grace: "RevenueDot recorded your first live sale", reminder: "Start Pro by October 29 to keep your live data", paused: "Your live data and webhooks are paused" };

let h: Harness;
let stripe: FakeBillingStripe;
let mail: ReturnType<typeof memoryMailer>;
let app: ReturnType<typeof createApp>;
let cookie = "";
let memberCookie = "";
/** Requests the webhook endpoint received (event ids, in order). */
let hookCalls: string[] = [];
const config = (over: Partial<BillingConfig> = {}): BillingConfig => ({ secretKey: FAKE_BILLING_KEY, webhookSecret: FAKE_BILLING_WEBHOOK_SECRET, pricePro: FAKE_BILLING_PRICE, meterEvent: "revenuedot_cloud_bill_cents", live: false, ...over });
/** Stripe for RevenueDot's own account; anything else is a customer's webhook endpoint, which answers 200. */
const outbound: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.host === "api.stripe.com") return stripe.fetch(input, init);
  hookCalls.push(String(JSON.parse(String(init?.body ?? "{}")).id ?? "?"));
  return new Response("ok", { status: 200 });
};

beforeEach(async () => {
  h = await harness();
  h.setNow(T0);
  stripe = new FakeBillingStripe();
  stripe.clock = h.now;
  mail = memoryMailer();
  hookCalls = [];
  await h.db.insert(schema.users).values([
    { id: "usr_1", email: "founder@example.com", name: "Founder", emailVerifiedAt: h.now() },
    { id: "usr_2", email: "dev@example.com", name: "Dev", emailVerifiedAt: h.now() },
  ]);
  await h.db.update(schema.projects).set({ ownerUserId: "usr_1" });
  await h.db.insert(schema.memberships).values([{ userId: "usr_1", projectId: "proj1", role: "admin" }, { userId: "usr_2", projectId: "proj1", role: "admin" }]);
  app = cloudApp();
  cookie = `rd_session=${await createSession(h.db, "usr_1", h.now())}`;
  memberCookie = `rd_session=${await createSession(h.db, "usr_2", h.now())}`;
});
afterEach(async () => { await h.close(); });

function cloudApp(over: Partial<Parameters<typeof createApp>[0]> = {}) {
  return createApp({ db: h.db, now: h.now, stores: defaultStores(), edition: "cloud", billing: config(), fetch: outbound, mailer: mail, publicUrl: "https://app.revenuedot.test", ...over });
}

type Auth = { cookie?: string; key?: string };
const call = async (method: string, path: string, o: Auth & { body?: unknown; a?: ReturnType<typeof createApp> } = {}) => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (o.key) headers.authorization = `Bearer ${o.key}`;
  else headers.cookie = o.cookie ?? cookie;
  const res = await (o.a ?? app).fetch(new Request(`https://app.revenuedot.test${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) }));
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body };
};
const hook = async (type: string, object: Record<string, unknown>) => {
  const e = await stripe.event(type, object);
  const res = await app.fetch(new Request("https://api.revenuedot.test/v2/billing/stripe/webhook", { method: "POST", headers: { "stripe-signature": e.signature, "content-type": "application/json" }, body: e.body }));
  return { status: res.status, body: await res.json() as any };
};
/** The gate's part of a billing pass, now (markLive and the emails run every 10 minutes; `force` skips that wait). */
const gatePass = () => runGate({ db: h.db, now: h.now(), mailer: mail, publicUrl: "https://app.revenuedot.test", config: config(), force: true });
const account = async (userId = "usr_1") => (await h.db.select().from(schema.billingAccounts).where(eq(schema.billingAccounts.userId, userId)))[0];

let n = 0;
async function txn(o: { usd: number; at?: Date; kind?: string; sandbox?: boolean; project?: string; createdAt?: Date; source?: string; user?: string }) {
  const project = o.project ?? "proj1";
  const id = `t${++n}`;
  await h.db.insert(schema.customers).values({ id: `c_${id}`, projectId: project, originalAppUserId: o.user ?? `u_${id}` });
  await h.db.insert(schema.customerAliases).values({ projectId: project, appUserId: o.user ?? `u_${id}`, customerId: `c_${id}` });
  await h.db.insert(schema.transactions).values({ id, projectId: project, customerId: `c_${id}`, store: "app_store", storeTransactionId: id, productIdentifier: "pro_monthly", kind: o.kind ?? "purchase", isSandbox: !!o.sandbox, purchasedAt: o.at ?? h.now(), revenueUsd: o.usd, createdAt: o.createdAt ?? h.now(), source: o.source ?? null });
  return id;
}
/** Live at T0, paused 14 days later: the account's first live sale, the pass that sees it, then the clock past its 14 days. */
async function pause() {
  await txn({ usd: 9.99, user: "buyer_1" });
  await gatePass();
  h.setNow(new Date(T0.getTime() + GRACE_DAYS * DAY + 60_000));
  await gatePass();
}
async function startPro() {
  const co = await call("POST", "/v2/billing/checkout", { body: { plan: "pro" } });
  expect(co.status).toBe(200);
  const { subscription } = stripe.complete(co.body.id);
  expect((await hook("checkout.session.completed", stripe.sessions.get(co.body.id)!)).body.result).toBe("subscribed");
  return subscription;
}

/** Every gated read, as [path, path with environment=sandbox]. */
const LIVE_READS: [string, string][] = [
  [`${P}/metrics/overview`, `${P}/metrics/overview?environment=sandbox`],
  [`${P}/charts/revenue`, `${P}/charts/revenue?environment=sandbox`],
  [`${P}/customers`, `${P}/customers?environment=sandbox`],
  [`${P}/transactions`, `${P}/transactions?environment=sandbox`],
  [`${P}/integrations/exports`, `${P}/integrations/exports?environment=sandbox`],
];
/** Never gated: setup and catalog. */
const SETUP_READS = [`${P}/apps`, `${P}/products`, `${P}/entitlements`, `${P}/offerings`, `${P}/paywalls`, `${P}/experiments`, `${P}/integrations/webhooks`];

async function expectAllOpen(auth: Auth = {}) {
  for (const [live] of LIVE_READS) expect((await call("GET", live, auth)).status, live).toBe(200);
  for (const path of SETUP_READS) expect((await call("GET", path, auth)).status, path).toBe(200);
  expect((await call("GET", `${P}/customers/buyer_1`, auth)).status).toBe(200);
  for (const path of [`${P}/paywalls`, `${P}/experiments`]) expect((await call("POST", path, { ...auth, body: {} })).status, path).not.toBe(402);
}

describe("building: no live sale yet", () => {
  it("nothing is gated; sandbox, Test Store, imported, moved-in and unpaid transactions never make an account live", async () => {
    // A Test Store purchase through the SDK, a sandbox App Store purchase, an import, a trial, a refund and a moved-in sale.
    const buy = await h.fetch("/v1/receipts", { method: "POST", key: h.ids.testKey, json: { app_user_id: "tester", fetch_token: `test_${h.now().getTime()}_${crypto.randomUUID()}`, product_id: "pro_monthly", price: 9.99, currency: "USD" } });
    expect([200, 201]).toContain(buy.status);
    await txn({ usd: 50, sandbox: true });
    await txn({ usd: 99, source: "import", at: new Date(T0.getTime() - 30 * DAY) });
    await txn({ usd: 0, kind: "trial" });
    await txn({ usd: -9.99, kind: "refund" });
    await h.db.insert(schema.projects).values({ id: "proj2", name: "Moved", ownerUserId: "usr_1", movedInAt: T0 });
    await txn({ usd: 20, project: "proj2", at: new Date(T0.getTime() - DAY), createdAt: new Date(T0.getTime() - DAY) });
    await txn({ usd: 5, user: "buyer_1", sandbox: true });
    expect(await markLive(h.db, h.now())).toEqual([]);
    await gatePass();
    expect(await account()).toBeUndefined();
    expect(mail.sent).toEqual([]);

    const me = (await call("GET", "/auth/me")).body.account;
    expect(me.gate).toEqual({ stage: "building", live_at: null, grace_ends_at: null });
    expect(me.project_gates.proj1).toEqual({ stage: "building", live_at: null, grace_ends_at: null, owner_is_you: true, owner_name: "Founder" });
    const billing = (await call("GET", "/v2/billing")).body;
    expect(billing.gate).toEqual({ stage: "building", live_at: null, grace_ends_at: null, grace_days: 14 });
    expect(billing.flags).toEqual([]);
    // Building has no time limit.
    h.setNow(new Date(T0.getTime() + 90 * DAY));
    await gatePass();
    expect(await account()).toBeUndefined();
    cookie = `rd_session=${await createSession(h.db, "usr_1", h.now())}`;
    expect((await call("GET", "/auth/me")).body.account.gate.stage).toBe("building");
    await expectAllOpen();
    await expectAllOpen({ key: h.ids.secretKey });
  });

  it("an account already live before the gate shipped gets 30 days, as the Terms of Service promise", async () => {
    await txn({ usd: 9.99, createdAt: new Date(GATE_SHIPPED.getTime() - 3 * DAY) });
    expect(await markLive(h.db, h.now())).toEqual(["usr_1"]);
    const [a] = await h.db.select().from(schema.billingAccounts).where(eq(schema.billingAccounts.userId, "usr_1"));
    expect(a!.graceEndsAt!.getTime()).toBe(h.now().getTime() + EXISTING_GRACE_DAYS * DAY);
  });

  it("a moved-in project's own later sale does make the account live", async () => {
    await h.db.insert(schema.projects).values({ id: "proj2", name: "Moved", ownerUserId: "usr_1", movedInAt: new Date(T0.getTime() - DAY) });
    await txn({ usd: 20, project: "proj2" });
    expect(await markLive(h.db, h.now())).toEqual(["usr_1"]);
  });
});

describe("going live: 14 days of grace, three emails at most", () => {
  it("the first live sale starts 14 days; the grace email once, the reminder 2 days before the end once, the pause email once", async () => {
    await txn({ usd: 9.99, user: "buyer_1" });
    await gatePass();
    const a = await account();
    expect(a).toMatchObject({ plan: "none", status: "none" });
    expect(a!.liveAt!.getTime()).toBe(T0.getTime());
    const ends = T0.getTime() + 14 * DAY;
    expect(a!.graceEndsAt!.getTime()).toBe(ends);
    expect(mail.sent.map((m) => m.subject)).toEqual([SUBJECT.grace]);
    expect(mail.sent[0]!.to).toBe("founder@example.com");
    expect(mail.sent[0]!.text).toContain("Start Pro by October 29");
    expect(mail.sent[0]!.text).toContain("https://app.revenuedot.test/account/billing");
    expect(mail.sent[0]!.subject).toMatch(/^[\x20-\x7E]+$/);

    // Another pass, and a later sale, change nothing: the date stays, no second email.
    h.setNow(new Date(T0.getTime() + DAY));
    await txn({ usd: 4.99 });
    await gatePass();
    expect((await account())!.graceEndsAt!.getTime()).toBe(ends);
    expect(mail.sent).toHaveLength(1);

    // Grace: the banners' data, and everything works.
    const me = (await call("GET", "/auth/me")).body.account;
    expect(me.gate).toEqual({ stage: "grace", live_at: T0.getTime(), grace_ends_at: ends });
    expect(me.project_gates.proj1).toMatchObject({ stage: "grace", grace_ends_at: ends, owner_is_you: true });
    expect((await call("GET", "/auth/me", { cookie: memberCookie })).body.account.project_gates.proj1).toMatchObject({ stage: "grace", owner_is_you: false, owner_name: "Founder" });
    const billing = (await call("GET", "/v2/billing")).body;
    expect(billing.flags).toEqual(["live_grace"]);
    expect(billing.gate).toMatchObject({ stage: "grace", grace_ends_at: ends, grace_days: 14 });
    await expectAllOpen();
    await expectAllOpen({ key: h.ids.secretKey });
    await expectAllOpen({ cookie: memberCookie });

    // The reminder: not before 2 days before the end, then once.
    h.setNow(new Date(ends - 2 * DAY - 60_000));
    await gatePass();
    expect(mail.sent).toHaveLength(1);
    h.setNow(new Date(ends - 2 * DAY + 60_000));
    await gatePass();
    await gatePass();
    expect(mail.sent.map((m) => m.subject)).toEqual([SUBJECT.grace, SUBJECT.reminder]);
    expect(mail.sent[1]!.text).toContain("Your app keeps working and every purchase still unlocks");
    expect((await call("GET", "/v2/billing")).body.flags).toEqual(["live_grace"]);

    // The end: paused, one email.
    h.setNow(new Date(ends - 1));
    expect((await call("GET", `${P}/metrics/overview`)).status).toBe(200);
    h.setNow(new Date(ends));
    expect((await call("GET", `${P}/metrics/overview`)).status).toBe(402);
    await gatePass();
    h.setNow(new Date(ends + DAY));
    await gatePass();
    expect(mail.sent.map((m) => m.subject)).toEqual([SUBJECT.grace, SUBJECT.reminder, SUBJECT.paused]);
    expect(mail.sent[2]!.text).toContain("Your app still works and every purchase still unlocks");
    expect((await call("GET", "/v2/billing")).body.flags).toEqual(["live_paused"]);
    expect((await call("GET", "/auth/me")).body.account.gate.stage).toBe("paused");
    const keys = (await h.db.select().from(schema.billingNotices).where(eq(schema.billingNotices.userId, "usr_1"))).map((r) => r.key).sort();
    expect(keys).toEqual([`live_grace:${ends}`, `live_paused:${ends}`, `live_reminder:${ends}`]);
  });

  it("a pass that first sees the account late sends only the email due then, not the ones it replaced", async () => {
    await h.db.insert(schema.billingAccounts).values({ userId: "usr_1", liveAt: new Date(T0.getTime() - 20 * DAY), graceEndsAt: new Date(T0.getTime() - 6 * DAY) });
    await gatePass();
    await gatePass();
    expect(mail.sent.map((m) => m.subject)).toEqual([SUBJECT.paused]);
  });

  it("an account whose Pro ended because every payment failed gets no pause email (the unpaid email said it), a canceled one does", async () => {
    await h.db.insert(schema.users).values({ id: "usr_3", email: "gone@example.com", name: "Gone" });
    await h.db.insert(schema.billingAccounts).values([
      { userId: "usr_1", plan: "none", status: "unpaid", liveAt: new Date(T0.getTime() - 40 * DAY), graceEndsAt: new Date(T0.getTime() - 26 * DAY) },
      { userId: "usr_3", plan: "none", status: "canceled", liveAt: new Date(T0.getTime() - 40 * DAY), graceEndsAt: new Date(T0.getTime() - 26 * DAY) },
    ]);
    await gatePass();
    expect(mail.sent.map((m) => [m.to, m.subject])).toEqual([["gone@example.com", SUBJECT.paused]]);
    // Paused all the same.
    expect((await call("GET", `${P}/metrics/overview`)).status).toBe(402);
  });

  it("Pro and Enterprise accounts get no gate email when they go live", async () => {
    await h.db.insert(schema.billingAccounts).values({ userId: "usr_1", plan: "pro", status: "active" });
    await txn({ usd: 9.99 });
    await gatePass();
    expect((await account())!.liveAt!.getTime()).toBe(T0.getTime());
    h.setNow(new Date(T0.getTime() + 30 * DAY));
    await gatePass();
    expect(mail.sent).toEqual([]);
  });

  it("the tick marks live once every 10 minutes and only with Stripe set up", async () => {
    await txn({ usd: 9.99 });
    const opts = { edition: "cloud" as const, billing: config(), mailer: mail, publicUrl: "https://app.revenuedot.test", accountNotifications: false, archives: false, exports: false };
    // No Stripe: nothing.
    await tick(h.db, h.now(), outbound, { ...opts, billing: null });
    expect(await account()).toBeUndefined();
    expect((await runGate({ db: h.db, now: h.now(), config: config({ secretKey: "" }), force: true }))).toBe(0);
    expect(await account()).toBeUndefined();
    // With Stripe: the first tick of the 10 minutes marks it; the claim keeps a second one from repeating the work.
    const r = await tick(h.db, h.now(), outbound, opts);
    expect(r.gate).toBeGreaterThanOrEqual(2);
    expect((await account())!.liveAt!.getTime()).toBe(T0.getTime());
    expect(mail.sent.map((m) => m.subject)).toEqual([SUBJECT.grace]);
  });
});

describe("paused: live data needs Pro, apps keep working", () => {
  it("live reads answer 402 plan_required with the upgrade link, by session and by secret key; sandbox reads keep working", async () => {
    await pause();
    // The owner is told to start Pro; a secret key's caller is told who has to.
    for (const [auth, message] of [[{}, OWNER_402], [{ key: h.ids.secretKey }, KEY_402]] as [Auth, string][]) {
      for (const [live, sandbox] of LIVE_READS) {
        const r = await call("GET", live, auth);
        expect(r.status, live).toBe(402);
        expect(r.body).toMatchObject({ object: "error", type: "plan_required", message, upgrade_url: "https://app.revenuedot.app/account/billing" });
        expect((await call("GET", sandbox, auth)).status, sandbox).toBe(200);
      }
      // Writes of live data too: a new scheduled export. A move's full export is never gated (the data can always leave).
      expect((await call("POST", `${P}/integrations/exports`, { ...auth, body: {} })).status).toBe(402);
      expect((await call("GET", `${P}/exports`, auth)).status).not.toBe(402);
      for (const path of SETUP_READS) expect((await call("GET", path, auth)).status, path).toBe(200);
    }
    // One customer: a backend checks access with a secret key, so that works; the dashboard's customer page is paused.
    expect((await call("GET", `${P}/customers/buyer_1`, { key: h.ids.secretKey })).status).toBe(200);
    expect((await call("GET", `${P}/customers/buyer_1/active_entitlements`, { key: h.ids.secretKey })).status).not.toBe(402);
    expect((await call("GET", `${P}/customers/buyer_1`)).status).toBe(402);
    expect((await call("GET", `${P}/customers/buyer_1?environment=sandbox`)).status).not.toBe(402);
    // Paywalls and experiments: running ones keep serving and can be read; creating or editing them needs Pro.
    for (const path of [`${P}/paywalls`, `${P}/experiments`]) {
      expect((await call("GET", path)).status).toBe(200);
      const r = await call("POST", path, { body: {} });
      expect(r.status, path).toBe(402);
      expect(r.body.type).toBe("plan_required");
    }
  });

  it("another member is told who has to start Pro", async () => {
    await pause();
    const r = await call("GET", `${P}/metrics/overview`, { cookie: memberCookie });
    expect(r.status).toBe(402);
    expect(r.body.message).toBe(MEMBER_402);
    const me = (await call("GET", "/auth/me", { cookie: memberCookie })).body.account;
    // The member's own account is still building; the project follows its owner.
    expect(me.gate.stage).toBe("building");
    expect(me.project_gates.proj1).toMatchObject({ stage: "paused", owner_is_you: false, owner_name: "Founder" });
  });

  it("the SDK never stops: customer info, purchases and entitlements", async () => {
    await pause();
    const info = await h.fetch("/v1/subscribers/buyer_1");
    expect(info.status).toBe(200);
    const buy = await h.fetch("/v1/receipts", { method: "POST", key: h.ids.testKey, json: { app_user_id: "late_buyer", fetch_token: `test_${h.now().getTime()}_${crypto.randomUUID()}`, product_id: "pro_monthly", price: 9.99, currency: "USD" } });
    expect([200, 201]).toContain(buy.status);
    const body = await buy.json() as any;
    expect(body.subscriber.entitlements.pro).toBeTruthy();
    expect(Date.parse(body.subscriber.entitlements.pro.expires_date)).toBeGreaterThan(h.now().getTime());
    expect((await h.fetch("/v1/subscribers/late_buyer", { key: h.ids.testKey })).status).toBe(200);
  });

  it("the account overview leaves a paused project out of the live totals, with the reason; sandbox totals keep it", async () => {
    await pause();
    const live = await call("GET", "/v2/overview");
    expect(live.status).toBe(200);
    expect(live.body.projects).toEqual([{ id: "proj1", name: "Scanner", included: false, reason: OWNER_402 }]);
    expect((await call("GET", "/v2/overview", { cookie: memberCookie })).body.projects).toEqual([{ id: "proj1", name: "Scanner", included: false, reason: MEMBER_402 }]);
    expect((await call("GET", "/v2/overview/transactions")).body.projects[0]).toMatchObject({ included: false });
    const sandbox = await call("GET", "/v2/overview?environment=sandbox");
    expect(sandbox.body.projects).toEqual([{ id: "proj1", name: "Scanner", included: true }]);
  });

  it("starting Pro opens everything at once; a lapse (unpaid) puts the live account straight back to paused", async () => {
    await pause();
    const sub = await startPro();
    expect((await call("GET", "/auth/me")).body.account.gate.stage).toBe("active");
    expect((await call("GET", "/v2/billing")).body.flags).toEqual([]);
    await expectAllOpen();
    // Past due keeps Pro while Stripe retries.
    await hook("customer.subscription.updated", stripe.updateSubscription(sub.id, { status: "past_due" }));
    expect((await call("GET", `${P}/metrics/overview`)).status).toBe(200);
    // Every retry failed: no plan again, and its 14 days were used.
    await hook("customer.subscription.updated", stripe.updateSubscription(sub.id, { status: "unpaid" }));
    expect((await account())).toMatchObject({ plan: "none", status: "unpaid" });
    expect((await call("GET", `${P}/metrics/overview`)).status).toBe(402);
    expect((await call("GET", "/v2/billing")).body.flags).toEqual(["unpaid", "live_paused"]);
  });
});

describe("webhooks and integrations of a paused project", () => {
  async function setupDeliveries() {
    await h.db.insert(schema.webhooks).values({ id: "wh_1", projectId: "proj1", name: "Backend", url: "https://hooks.example.com/rd", signingSecret: "whsec_x", environment: "both" });
    let i = 0;
    const event = async (id: string, environment: "production" | "sandbox", at: Date, status = "pending", deliveryAt = at) => {
      await h.db.insert(schema.events).values({ id, projectId: "proj1", type: "INITIAL_PURCHASE", environment, payload: { id, type: "INITIAL_PURCHASE", environment: environment.toUpperCase() }, eventTimestampMs: at.getTime(), createdAt: at });
      await h.db.insert(schema.webhookDeliveries).values({ id: `whd_${++i}`, webhookId: "wh_1", eventId: id, status, nextAttemptAt: at, createdAt: deliveryAt });
    };
    return event;
  }
  const deliveries = async () => Object.fromEntries((await h.db.select().from(schema.webhookDeliveries)).map((d) => [d.eventId, d.status]));
  const cloudTick = () => tick(h.db, h.now(), outbound, { edition: "cloud", billing: config(), mailer: mail, publicUrl: "https://app.revenuedot.test", accountNotifications: false, archives: false, exports: false });

  it("production deliveries are held, sandbox ones go out; Pro sends the held ones oldest first; held over 30 days are failed", async () => {
    const event = await setupDeliveries();
    await pause();
    const now = h.now().getTime();
    await event("evt_old", "production", new Date(now - (HOLD_DAYS + 1) * DAY), "held");
    await event("evt_p1", "production", new Date(now - 3 * 60_000));
    await event("evt_s1", "sandbox", new Date(now - 2 * 60_000));
    await event("evt_p2", "production", new Date(now - 60_000));
    await cloudTick();
    expect(hookCalls).toEqual(["evt_s1"]);
    expect(await deliveries()).toEqual({ evt_old: "failed", evt_p1: "held", evt_s1: "delivered", evt_p2: "held" });
    const [held] = await h.db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.eventId, "evt_p1"));
    expect(held!.lastError).toBe("Held: the project owner has no plan. Start Pro to send it.");
    expect(held!.attempts).toBe(0);
    const [old] = await h.db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.eventId, "evt_old"));
    expect(old!.lastError).toMatch(/Held for 30 days/);
    // The dashboard's delivery list shows the held status.
    const list = await call("GET", `${P}/webhooks/wh_1/deliveries`);
    expect(list.status).toBe(200);
    expect(list.body.items.filter((d: { status: string }) => d.status === "held")).toHaveLength(2);
    // A manual retry while paused is held again before it can go out.
    const retry = await call("POST", `${P}/webhooks/wh_1/deliveries/${held!.id}/retry`);
    expect(retry.status).toBeLessThan(300);
    h.setNow(new Date(h.now().getTime() + 60_000));
    await cloudTick();
    expect(hookCalls).toEqual(["evt_s1"]);
    expect((await deliveries()).evt_p1).toBe("held");

    // The owner starts Pro: the next run sends the held deliveries in the order their events happened.
    await startPro();
    h.setNow(new Date(h.now().getTime() + 60_000));
    const r = await cloudTick();
    expect(r.gate).toBeGreaterThanOrEqual(2);
    expect(hookCalls).toEqual(["evt_s1", "evt_p1", "evt_p2"]);
    expect(await deliveries()).toEqual({ evt_old: "failed", evt_p1: "delivered", evt_s1: "delivered", evt_p2: "delivered" });
  });

  it("a request-kicked run (the Worker's, without the cloud edition) holds a paused account's new deliveries before sending", async () => {
    const event = await setupDeliveries();
    await pause();
    await event("evt_p1", "production", new Date(h.now().getTime() - 1000));
    await tick(h.db, h.now(), outbound, { liveGate: true, billing: config(), accountNotifications: false, archives: false, exports: false });
    expect(hookCalls).toEqual([]);
    expect(await deliveries()).toEqual({ evt_p1: "held" });
    // A kicked run only holds and releases: no live marking or emails there.
    expect(mail.sent.map((m) => m.subject)).toEqual([SUBJECT.grace, SUBJECT.paused]);
  });

  it("deliveries are held only after the 14 days, and never for Pro or Enterprise", async () => {
    const event = await setupDeliveries();
    await txn({ usd: 9.99 });
    await gatePass();
    await event("evt_grace", "production", new Date(h.now().getTime() - 1000));
    await cloudTick();
    expect(await deliveries()).toEqual({ evt_grace: "delivered" });
    for (const plan of ["pro", "enterprise", "standard"]) {
      await h.db.update(schema.billingAccounts).set({ plan, status: "active", liveAt: new Date(T0.getTime() - 60 * DAY), graceEndsAt: new Date(T0.getTime() - 46 * DAY) });
      await event(`evt_${plan}`, "production", new Date(h.now().getTime() - 1000));
      h.setNow(new Date(h.now().getTime() + 60_000));
      await cloudTick();
      expect((await deliveries())[`evt_${plan}`], plan).toBe("delivered");
    }
  });

  it("integration deliveries are held, released and expired the same way", async () => {
    await pause();
    await h.db.insert(schema.integrations).values({ id: "int_1", projectId: "proj1", kind: "slack", name: "Slack", environment: "both" });
    const now = h.now().getTime();
    const add = async (id: string, environment: string, at: number, status = "pending") => {
      await h.db.insert(schema.events).values({ id, projectId: "proj1", type: "INITIAL_PURCHASE", environment, payload: { id }, eventTimestampMs: at, createdAt: new Date(at) });
      await h.db.insert(schema.integrationDeliveries).values({ id: `ind_${id}`, integrationId: "int_1", eventId: id, status, nextAttemptAt: new Date(at), createdAt: new Date(at) });
    };
    await add("e_old", "production", now - (HOLD_DAYS + 1) * DAY, "held");
    await add("e_prod", "production", now - 60_000);
    await add("e_sand", "sandbox", now - 60_000);
    const status = async () => Object.fromEntries((await h.db.select().from(schema.integrationDeliveries)).map((d) => [d.eventId, d.status]));
    expect(await holdAndRelease(h.db, h.now())).toEqual({ held: 1, released: 0, expired: 1 });
    expect(await status()).toEqual({ e_old: "failed", e_prod: "held", e_sand: "pending" });
    // Still paused: nothing moves.
    expect(await holdAndRelease(h.db, h.now())).toEqual({ held: 0, released: 0, expired: 0 });
    await h.db.update(schema.billingAccounts).set({ plan: "pro", status: "active" });
    expect(await holdAndRelease(h.db, h.now())).toEqual({ held: 0, released: 1, expired: 0 });
    const [released] = await h.db.select().from(schema.integrationDeliveries).where(and(eq(schema.integrationDeliveries.eventId, "e_prod")));
    expect(released).toMatchObject({ status: "pending" });
    expect(released!.nextAttemptAt.getTime()).toBe(h.now().getTime());
  });
});

describe("where the gate never applies", () => {
  async function pausedAccount() {
    await txn({ usd: 9.99, user: "buyer_1" });
    await h.db.insert(schema.billingAccounts).values({ userId: "usr_1", liveAt: new Date(T0.getTime() - 30 * DAY), graceEndsAt: new Date(T0.getTime() - 16 * DAY) });
    expect((await call("GET", `${P}/metrics/overview`)).status).toBe(402);
  }

  it("Pro (also past due) and Enterprise accounts, live for months", async () => {
    await pausedAccount();
    for (const [plan, status] of [["pro", "active"], ["pro", "past_due"], ["enterprise", "active"]]) {
      await h.db.update(schema.billingAccounts).set({ plan, status });
      expect((await call("GET", "/auth/me")).body.account.gate.stage, plan).toBe("active");
      expect((await call("GET", "/v2/billing")).body.flags.filter((f: string) => f.startsWith("live_"))).toEqual([]);
      await expectAllOpen();
      await expectAllOpen({ key: h.ids.secretKey });
      expect((await call("GET", "/v2/overview")).body.projects[0].included).toBe(true);
    }
  });

  it("self-hosted servers and Cloud without Stripe keys", async () => {
    await pausedAccount();
    const selfHosted = createApp({ db: h.db, now: h.now, stores: defaultStores(), fetch: outbound });
    const noStripe = cloudApp({ billing: undefined });
    const liveKeyOff = cloudApp({ billing: config({ secretKey: "sk_live_abc" }) });
    for (const a of [selfHosted, noStripe, liveKeyOff]) {
      for (const [live] of LIVE_READS) expect((await call("GET", live, { a })).status, live).toBe(200);
      expect((await call("GET", `${P}/customers/buyer_1`, { a })).status).toBe(200);
      expect((await call("POST", `${P}/paywalls`, { a, body: {} })).status).not.toBe(402);
      const me = (await call("GET", "/auth/me", { a })).body.account;
      expect(me.gate.stage).toBe("off");
      expect(me.project_gates).toEqual({});
      expect((await call("GET", "/v2/overview", { a })).body.projects[0].included).toBe(true);
    }
    // Their ticks never hold a delivery.
    await h.db.insert(schema.webhooks).values({ id: "wh_1", projectId: "proj1", name: "Backend", url: "https://hooks.example.com/rd", signingSecret: "whsec_x" });
    await h.db.insert(schema.events).values({ id: "evt_1", projectId: "proj1", type: "INITIAL_PURCHASE", environment: "production", payload: { id: "evt_1" }, eventTimestampMs: h.now().getTime() });
    await h.db.insert(schema.webhookDeliveries).values({ id: "whd_1", webhookId: "wh_1", eventId: "evt_1", nextAttemptAt: h.now() });
    await tick(h.db, h.now(), outbound, { edition: "cloud", billing: null, accountNotifications: false, archives: false, exports: false });
    expect(hookCalls).toEqual(["evt_1"]);
  });

  it("the stages, as a function", () => {
    const now = T0;
    const live = { liveAt: new Date(T0.getTime() - 20 * DAY), graceEndsAt: new Date(T0.getTime() - 6 * DAY) };
    expect(gateOf(null, now, true).stage).toBe("building");
    expect(gateOf({ plan: "none", liveAt: null, graceEndsAt: null }, now, true).stage).toBe("building");
    expect(gateOf({ plan: "none", liveAt: live.liveAt, graceEndsAt: new Date(T0.getTime() + 1) }, now, true).stage).toBe("grace");
    expect(gateOf({ plan: "none", ...live }, now, true).stage).toBe("paused");
    expect(gateOf({ plan: "free", ...live }, now, true).stage).toBe("paused");
    for (const plan of ["pro", "standard", "enterprise"]) expect(gateOf({ plan, ...live }, now, true).stage).toBe("active");
    expect(gateOf({ plan: "none", ...live }, now, false).stage).toBe("off");
  });

  it("which paths need a plan", () => {
    const q = (o: Record<string, string> = {}) => (k: string) => o[k];
    const sandbox = q({ environment: "sandbox" });
    expect(needsPlan("GET", ["metrics", "overview"], q(), false)).toBe(true);
    expect(needsPlan("GET", ["metrics", "overview"], sandbox, true)).toBe(false);
    expect(needsPlan("GET", ["charts", "mrr"], q({ env: "sandbox" }), false)).toBe(false);
    expect(needsPlan("POST", ["exports"], q(), false)).toBe(false);
    expect(needsPlan("POST", ["integrations", "exports"], sandbox, false)).toBe(true);
    expect(needsPlan("GET", ["ai"], q(), false)).toBe(false);
    expect(needsPlan("POST", ["ai", "conversations"], q(), false)).toBe(true);
    expect(needsPlan("GET", ["audiences"], q(), false)).toBe(false);
    expect(needsPlan("POST", ["audiences", "actions", "preview"], q(), false)).toBe(true);
    expect(needsPlan("GET", ["integrations", "exports"], q(), true)).toBe(true);
    expect(needsPlan("GET", ["integrations", "webhooks"], q(), true)).toBe(false);
    expect(needsPlan("GET", ["customers"], q(), true)).toBe(true);
    expect(needsPlan("GET", ["customers", "u1"], q(), true)).toBe(false);
    expect(needsPlan("GET", ["customers", "u1"], q(), false)).toBe(true);
    expect(needsPlan("GET", ["subscriptions", "sub_1"], q(), true)).toBe(false);
    expect(needsPlan("POST", ["customers", "u1", "actions", "grant_entitlement"], q(), false)).toBe(false);
    expect(needsPlan("GET", ["paywalls"], q(), false)).toBe(false);
    expect(needsPlan("POST", ["paywalls"], q(), true)).toBe(true);
    expect(needsPlan("DELETE", ["experiments", "exp_1"], q(), false)).toBe(true);
    expect(needsPlan("POST", ["targeting_rules"], q(), false)).toBe(true);
    for (const head of ["apps", "products", "entitlements", "offerings", "api_keys", "import", "members"]) expect(needsPlan("POST", [head], q(), false), head).toBe(false);
  });
});

describe("Checkout for Pro", () => {
  it("collects a card for $0 today, explains the price under the button, and marks the plan pro; 'standard' still opens it", async () => {
    const co = await call("POST", "/v2/billing/checkout", { body: { plan: "pro" } });
    expect(co.status).toBe(200);
    const sent = stripe.calls.filter((c) => c.method === "POST" && c.path === "/v1/checkout/sessions");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.params).toMatchObject({
      mode: "subscription", payment_method_collection: "always", custom_text: { submit: { message: PRO_CHECKOUT_TEXT } },
      line_items: [{ price: FAKE_BILLING_PRICE }], metadata: { plan: "pro", revenuedot_user_id: "usr_1" }, subscription_data: { metadata: { plan: "pro" } },
    });
    expect(PRO_CHECKOUT_TEXT).toMatch(/^\$0 today\./);
    expect(PRO_CHECKOUT_TEXT.length).toBeLessThanOrEqual(1200);
    // Pro's old name, from a dashboard opened before the rename.
    const old = await call("POST", "/v2/billing/checkout", { body: { plan: "standard" } });
    expect(old.status).toBe(200);
    expect(stripe.calls.filter((c) => c.method === "POST" && c.path === "/v1/checkout/sessions").at(-1)!.params.metadata.plan).toBe("pro");
    for (const plan of ["enterprise", "free", undefined]) {
      const r = await call("POST", "/v2/billing/checkout", { body: { plan } });
      expect(r.status).toBe(400);
      expect(r.body.message).toMatch(/Only Pro starts with a self-serve checkout/);
    }
  });
});
