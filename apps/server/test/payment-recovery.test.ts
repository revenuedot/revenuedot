import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { CONN_APP_ID, CONN_APP_KEY, FAKE_CONNECT_CONFIG, webEnv, type WebEnv } from "../../../packages/contract/src/web-env.js";
import { FAKE_PLATFORM_TEST_KEY } from "../../../packages/contract/src/fake-stripe.js";
import { CustomerInfoSchema } from "../../../packages/contract/src/sdk-schemas.js";
import { memoryMailer } from "../src/mail/index.js";
import { tick } from "../src/services/tick.js";
import { DEFAULT_STEPS, PORTAL_LINK_TTL_MS, runPaymentRecovery, trackRecovery } from "../src/services/payment-recovery.js";
import { hit } from "../src/services/rate-limit.js";
import { setAppleRootsForTesting } from "../src/stores/apple/index.js";
import { appleHarness, makePki, notificationBody, renewalInfo, signJws, T0, transaction, type AppleHarness, type Pki } from "./apple-fixtures.js";
import { env as googleEnv, makeKeys, sub as playSub, type Env as GoogleEnv, type Keys } from "./google-helpers.js";

/**
 * Failed-payment recovery (prd/payment-recovery/PRD.md): cases from billing issues on Stripe (restricted key and Connect),
 * the App Store, Google Play and the Test Store; the schedule, caps and skips; the link per store, the Stripe portal and its
 * fallback; unsubscribe; recovered, attributed, without a message and lost; stats, the case list and management_url.
 */
const DAY = 86_400_000;
let web: WebEnv | undefined;
let apple: AppleHarness | undefined;
let play: GoogleEnv | undefined;
afterEach(async () => { await web?.h.close(); await apple?.close(); await play?.h.close(); web = apple = play = undefined; });
const P = () => `/v2/projects/${web!.h.ids.project}`;
const recoveryMails = (m: { sent: Array<{ subject: string }> }) => m.sent.filter((x) => !x.subject.startsWith("[Test]") && /payment|subscription/i.test(x.subject) && !/redeem/i.test(x.subject));
const linkIn = (text: string, kind: "l" | "u") => new RegExp(`https?://[^\\s"]+/v1/recovery/${kind}/[A-Za-z0-9_-]+`).exec(text)?.[0];
const settings = (o: Record<string, unknown> = {}) => ({ enabled: true, steps: DEFAULT_STEPS, window_days: 30, include_sandbox: true, ...o });

/** Web env with recovery on, the web catalog, and pay_user subscribed to the annual plan through a purchase link. */
async function stripeSubscriber(o: { connect?: boolean } = {}) {
  web = await webEnv(o.connect ? { connect: FAKE_CONNECT_CONFIG } : {});
  let acct = web.stripe;
  let appId = "app_web";
  if (o.connect) {
    const start = await web.api("POST", `${P()}/apps/${CONN_APP_ID}/stripe_connect/actions/start`, { method: "oauth", mode: "test" });
    const { redirect, account } = web.platform.approve(start.body.url);
    const back = new URL(redirect);
    await web.api("POST", `${P()}/apps/${CONN_APP_ID}/stripe_connect/actions/finish`, { state: back.searchParams.get("state"), code: back.searchParams.get("code"), nonce: start.body.nonce });
    acct = web.platform.accounts.get(account)!;
    appId = CONN_APP_ID;
  }
  const ids = await web.setupWeb(appId);
  expect((await web.api("POST", `${P()}/payment_recovery`, settings())).status).toBe(200);
  const link = (await web.api("POST", `${P()}/purchase_links`, { name: "Annual", offering_id: ids.offeringId, app_id: appId })).body;
  const u = new URL(link.url);
  const [, , project, slug] = u.pathname.split("/");
  const start = await (await web.raw(`${u.origin}/pay/api/checkout`, { method: "POST", json: { project, slug, package: "$rc_annual", app_user_id: "pay_user" } })).json() as { url: string };
  const sessionId = new URL(start.url).pathname.split("/").pop()!;
  acct.complete(sessionId, { email: "buyer@example.com" });
  const evt = acct.completedEvent(sessionId);
  expect((await (o.connect ? web.connectWebhook(evt) : web.webhook(evt))).status).toBe(200);
  const subId = acct.sessions.get(sessionId)!.subscription as string;
  return { acct, subId, appId, hook: (e: Record<string, unknown>) => (o.connect ? web!.connectWebhook(e) : web!.webhook(e)) };
}

const cases = async (q = "") => (await web!.api("GET", `${P()}/payment_recovery/cases?environment=sandbox${q}`)).body.items as any[];
const stats = async (days = 28) => (await web!.api("GET", `${P()}/payment_recovery/stats?days=${days}&environment=sandbox`)).body;
const run = async () => (await web!.api("POST", `${P()}/payment_recovery/actions/run`, {})).body;

describe("Stripe", () => {
  it("past_due opens a case; day 0 and day 3 emails with a portal link; the paid invoice recovers it, attributed", async () => {
    const { acct, subId, hook } = await stripeSubscriber();
    const h = web!.h;
    // A year later the renewal charge fails.
    h.setNow(new Date(h.now().getTime() + 365 * DAY + 3_600_000));
    const inv = acct.failRenewal(subId, { retryInDays: 3 });
    expect(await (await hook(acct.event("invoice.payment_failed", inv))).json()).toMatchObject({ status: "processed" });
    expect((await web!.events("BILLING_ISSUE"))).toHaveLength(1);
    let [c] = await cases();
    expect(c).toMatchObject({ object: "payment_recovery_case", app_user_id: "pay_user", store: "stripe", status: "open", at_risk_in_usd: 59.99, messages_sent: 0, environment: "sandbox" });
    expect(c.grace_period_expires_at).toBe(inv.next_payment_attempt * 1000);
    expect((await stats()).at_risk).toEqual({ count: 1, revenue_in_usd: 59.99 });

    // The SDK's Customer Center gets the recovery link as management_url while the case is open.
    const ci = await web!.h.fetch("/v1/subscribers/pay_user", { key: "strp_webtest123" });
    const info = CustomerInfoSchema.parse(await ci.json());
    expect(info.subscriber.management_url).toMatch(/^http:\/\/localhost\/v1\/recovery\/c\/[A-Za-z0-9_-]{32,80}$/);

    // Day 0: one email, to the Stripe customer's address, from the app, with the link and an unsubscribe link.
    expect(await run()).toMatchObject({ sent: 1, failed: 0 });
    let mails = recoveryMails(web!.mail);
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: "buyer@example.com", subject: "Your payment for Scanner didn't go through", fromName: "Scanner" });
    expect((mails[0] as any).text).toContain("Update payment: http://localhost/v1/recovery/l/");
    expect((mails[0] as any).html).toContain("a payment for your Scanner subscription failed");
    // http links: no List-Unsubscribe header (mail providers need https).
    expect((mails[0] as any).headers).toBeUndefined();
    expect(await run()).toMatchObject({ sent: 0 });
    c = (await cases())[0];
    expect(c).toMatchObject({ messages_sent: 1, email: "buyer@example.com" });
    expect(c.next_message_at).toBe(c.detected_at + 3 * DAY);

    // The link opens a Stripe customer portal session to update the payment method, made at the click.
    const tok = linkIn((mails[0] as any).text, "l")!.split("/").pop()!;
    const click = await web!.raw(`/v1/recovery/l/${tok}`, { redirect: "manual" });
    expect(click.status).toBe(303);
    const portal = [...acct.portalSessions.values()][0]!;
    expect(click.headers.get("location")).toBe(portal.url);
    expect(portal).toMatchObject({ customer: acct.subscriptions.get(subId)!.customer, flow: { type: "payment_method_update" }, return_url: `http://localhost/v1/recovery/done/${tok}` });
    expect((await cases())[0].clicked_at).toBe(h.now().getTime());
    expect(await (await web!.raw(`/v1/recovery/done/${tok}`)).text()).toContain("Your payment details are saved");

    // Day 3: the second step; day 4: nothing.
    h.setNow(new Date(h.now().getTime() + 3 * DAY));
    expect(await run()).toMatchObject({ sent: 1 });
    mails = recoveryMails(web!.mail);
    expect(mails.map((m) => m.subject)).toEqual(["Your payment for Scanner didn't go through", "Action needed: keep your Scanner subscription"]);
    h.setNow(new Date(h.now().getTime() + DAY));
    expect(await run()).toMatchObject({ sent: 0 });

    // The customer fixed their card; Stripe collected the invoice: RENEWAL, and the case is recovered and attributed.
    acct.payInvoice(inv.id);
    expect(await (await hook(acct.event("invoice.paid", acct.invoices.get(inv.id)!))).json()).toMatchObject({ status: "processed" });
    expect(await web!.events("RENEWAL")).toHaveLength(1);
    c = (await cases())[0];
    expect(c).toMatchObject({ status: "recovered", attributed: true, recovered_revenue_in_usd: 59.99, messages_sent: 2, next_message_at: null });
    const s = await stats();
    expect(s).toMatchObject({ at_risk: { count: 0, revenue_in_usd: 0 }, messages_sent: 2, clicked: 1, recovered: { count: 1, revenue_in_usd: 59.99 }, recovered_without_message: { count: 0 }, lost: { count: 0 }, recovery_rate: 1 });
    expect(s.by_store).toEqual([{ store: "stripe", at_risk: 0, recovered: 1, recovered_revenue_in_usd: 59.99, recovered_without_message: 0, lost: 0 }]);
    // No more emails, management_url is null again, and the link says it is done.
    h.setNow(new Date(h.now().getTime() + 5 * DAY));
    expect(await run()).toMatchObject({ sent: 0 });
    expect(CustomerInfoSchema.parse(await (await web!.h.fetch("/v1/subscribers/pay_user", { key: "strp_webtest123" })).json()).subscriber.management_url).toBeNull();
    expect(await (await web!.raw(`/v1/recovery/l/${tok}`)).text()).toContain("Your payment went through");
    // Production numbers are separate.
    expect((await web!.api("GET", `${P()}/payment_recovery/stats`)).body.recovered.count).toBe(0);
  });

  it("without a portal set up the link opens the open invoice; the Stripe customer's email is used when $email is missing", async () => {
    const { acct, subId, hook } = await stripeSubscriber();
    await web!.h.db.delete(schema.customerAttributes).where(eq(schema.customerAttributes.key, "$email"));
    acct.portalConfigured = false;
    web!.h.setNow(new Date(web!.h.now().getTime() + 366 * DAY));
    const inv = acct.failRenewal(subId);
    await hook(acct.event("invoice.payment_failed", inv));
    expect(await run()).toMatchObject({ sent: 1 });
    expect(recoveryMails(web!.mail)[0]).toMatchObject({ to: "buyer@example.com" });
    expect(acct.calls.some((c) => c.path.startsWith("/v1/customers/"))).toBe(true);
    const tok = linkIn((recoveryMails(web!.mail)[0] as any).text, "l")!.split("/").pop()!;
    const click = await web!.raw(`/v1/recovery/l/${tok}`, { redirect: "manual" });
    expect(click.status).toBe(303);
    expect(click.headers.get("location")).toBe(`https://invoice.stripe.com/i/${inv.id}`);
    // With the invoice paid elsewhere and no portal: a page that points to support.
    acct.payInvoice(inv.id);
    const page = await web!.raw(`/v1/recovery/l/${tok}`, { redirect: "manual" });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("app&#39;s support team");
  });

  it("works on a connected account: the portal session is made with the platform key and Stripe-Account", async () => {
    const { acct, subId, hook } = await stripeSubscriber({ connect: true });
    web!.h.setNow(new Date(web!.h.now().getTime() + 366 * DAY));
    const inv = acct.failRenewal(subId);
    expect(await (await hook(acct.event("invoice.payment_failed", inv))).json()).toMatchObject({ status: "processed" });
    expect(await run()).toMatchObject({ sent: 1 });
    const tok = linkIn((recoveryMails(web!.mail)[0] as any).text, "l")!.split("/").pop()!;
    const click = await web!.raw(`/v1/recovery/l/${tok}`, { redirect: "manual" });
    expect(click.status).toBe(303);
    const call = acct.calls.find((c) => c.path === "/v1/billing_portal/sessions")!;
    expect(call).toMatchObject({ auth: `Bearer ${FAKE_PLATFORM_TEST_KEY}`, account: acct.connect!.accountId });
    acct.payInvoice(inv.id);
    await hook(acct.event("invoice.paid", acct.invoices.get(inv.id)!));
    expect((await cases())[0]).toMatchObject({ status: "recovered", attributed: true, app_user_id: "pay_user" });
    void CONN_APP_KEY;
  });

  it("a closed case's link no longer opens the Stripe customer portal", async () => {
    const { acct, subId, hook } = await stripeSubscriber();
    web!.h.setNow(new Date(web!.h.now().getTime() + 366 * DAY));
    await hook(acct.event("invoice.payment_failed", acct.failRenewal(subId)));
    expect(await run()).toMatchObject({ sent: 1 });
    const tok = linkIn((recoveryMails(web!.mail)[0] as any).text, "l")!.split("/").pop()!;
    // The window passes: the case is lost, and the old email's link must not hand out a portal session any more.
    web!.h.setNow(new Date(web!.h.now().getTime() + 31 * DAY));
    expect(await run()).toMatchObject({ closed: 1 });
    const before = acct.calls.filter((c) => c.path === "/v1/billing_portal/sessions").length;
    const page = await web!.raw(`/v1/recovery/l/${tok}`, { redirect: "manual" });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("This link has expired");
    expect(acct.calls.filter((c) => c.path === "/v1/billing_portal/sessions").length).toBe(before);
  });

  it("Customer Center: the public link never opens the portal; it emails a one-time 30-minute link, rate limited", async () => {
    const { acct, subId, hook } = await stripeSubscriber();
    const h = web!.h;
    h.setNow(new Date(h.now().getTime() + 366 * DAY));
    await hook(acct.event("invoice.payment_failed", acct.failRenewal(subId)));
    const info = await (await h.fetch("/v1/subscribers/pay_user", { key: "strp_webtest123" })).json() as any;
    const center = new URL(info.subscriber.management_url);
    const ct = center.pathname.split("/").pop()!;
    const portals = () => acct.calls.filter((c) => c.path === "/v1/billing_portal/sessions").length;
    const mails = () => web!.mail.sent.filter((m) => m.subject.startsWith("Your link to update your payment"));
    // The Customer Center token is not the emailed one: it neither opens the email link nor unsubscribes.
    expect((await web!.raw(`/v1/recovery/l/${ct}`, { redirect: "manual" })).status).toBe(404);
    expect((await web!.raw(`/v1/recovery/u/${ct}`, { method: "POST" })).status).toBe(404);
    // GET explains and offers a button; nothing is sent and no portal session is made.
    const get = await web!.raw(center.pathname, { redirect: "manual" });
    expect(get.status).toBe(200);
    expect(await get.text()).toContain("We&#39;ll email you a secure link");
    expect(mails()).toHaveLength(0);
    expect(portals()).toBe(0);
    // POST emails a one-time link to the address on file.
    const ip = { "cf-connecting-ip": "203.0.113.7" };
    const post = await web!.raw(center.pathname, { method: "POST", headers: ip });
    expect(await post.text()).toContain("Check your email");
    expect(mails()).toEqual([expect.objectContaining({ to: "buyer@example.com" })]);
    expect(portals()).toBe(0);
    const link = new URL(/https?:\/\/\S+\/v1\/recovery\/p\/[A-Za-z0-9_-]+/.exec(mails()[0]!.text)![0]);
    const [stored] = await h.db.select().from(schema.recoveryPortalLinks);
    expect(stored!.tokenHash).not.toContain(link.pathname.split("/").pop());
    // Opening the emailed link shows a button (a mail scanner's GET does not spend it); the button makes the portal session.
    expect(await (await web!.raw(link.pathname)).text()).toContain("Update payment method");
    expect(portals()).toBe(0);
    const use = await web!.raw(link.pathname, { method: "POST", redirect: "manual" });
    expect(use.status).toBe(303);
    expect(use.headers.get("location")).toMatch(/\/__stripe\/portal\/|billing\.stripe\.com|portal/);
    expect(portals()).toBe(1);
    // Used once: a second use is refused without a new session.
    const again = await web!.raw(link.pathname, { method: "POST", redirect: "manual" });
    expect(await again.text()).toContain("already used");
    expect(portals()).toBe(1);
    // A second link expires after 30 minutes.
    await web!.raw(center.pathname, { method: "POST", headers: ip });
    const link2 = new URL(/https?:\/\/\S+\/v1\/recovery\/p\/[A-Za-z0-9_-]+/.exec(mails()[1]!.text)![0]);
    h.setNow(new Date(h.now().getTime() + PORTAL_LINK_TTL_MS + 1000));
    expect(await (await web!.raw(link2.pathname)).text()).toContain("This link has expired");
    expect(await (await web!.raw(link2.pathname, { method: "POST", redirect: "manual" })).text()).toContain("This link has expired");
    expect(portals()).toBe(1);
    // Three links an hour per customer: the fourth request is refused.
    expect((await web!.raw(center.pathname, { method: "POST", headers: { "cf-connecting-ip": "203.0.113.8" } })).status).toBe(200);
    const limited = await web!.raw(center.pathname, { method: "POST", headers: { "cf-connecting-ip": "203.0.113.9" } });
    expect(limited.status).toBe(429);
    expect(mails()).toHaveLength(3);
    // Ten requests an hour per IP address, whichever customer they are for.
    for (let i = 0; i < 10; i++) await hit(h.db, "recovery-portal:ip:198.51.100.1", 10, 3600_000, h.now());
    h.setNow(new Date(h.now().getTime() + 2 * 3600_000));
    for (let i = 0; i < 10; i++) await hit(h.db, "recovery-portal:ip:198.51.100.1", 10, 3600_000, h.now());
    expect((await web!.raw(center.pathname, { method: "POST", headers: { "cf-connecting-ip": "198.51.100.1" } })).status).toBe(429);
    expect((await web!.raw(center.pathname, { method: "POST", headers: { "cf-connecting-ip": "198.51.100.2" } })).status).toBe(200);
    // Paid: the Customer Center link says so; the old emailed link too.
    const inv = [...acct.invoices.values()].find((i) => i.status === "open")!;
    acct.payInvoice(inv.id);
    await hook(acct.event("invoice.paid", acct.invoices.get(inv.id)!));
    expect(await (await web!.raw(center.pathname)).text()).toContain("Your payment went through");
  });

  it("Customer Center without an email on file explains where to update the payment instead", async () => {
    const { acct, subId, hook } = await stripeSubscriber();
    await web!.h.db.delete(schema.customerAttributes).where(eq(schema.customerAttributes.key, "$email"));
    for (const c of acct.customers.values()) c.email = null;
    web!.h.setNow(new Date(web!.h.now().getTime() + 366 * DAY));
    await hook(acct.event("invoice.payment_failed", acct.failRenewal(subId)));
    const info = await (await web!.h.fetch("/v1/subscribers/pay_user", { key: "strp_webtest123" })).json() as any;
    const path = new URL(info.subscriber.management_url).pathname;
    expect(await (await web!.raw(path)).text()).toContain("We have no email address for your subscription");
    const post = await web!.raw(path, { method: "POST" });
    expect(await post.text()).toContain("We have no email address for your subscription");
    expect(web!.mail.sent.filter((m) => m.subject.startsWith("Your link"))).toHaveLength(0);
    expect(acct.calls.some((c) => c.path === "/v1/billing_portal/sessions")).toBe(false);
  });

  it("unsubscribe stops the steps and suppresses the address for win-back too; GET never unsubscribes", async () => {
    const { acct, subId, hook } = await stripeSubscriber();
    web!.h.setNow(new Date(web!.h.now().getTime() + 366 * DAY));
    await hook(acct.event("invoice.payment_failed", acct.failRenewal(subId)));
    await run();
    const tok = linkIn((recoveryMails(web!.mail)[0] as any).text, "u")!.split("/").pop()!;
    const get = await web!.raw(`/v1/recovery/u/${tok}`);
    expect(await get.text()).toContain("<form method=\"post\">");
    expect((await cases())[0].unsubscribed_at).toBeNull();
    // Another open case for the same address (another subscription), due for its next email.
    const [first] = await web!.h.db.select().from(schema.recoveryCases);
    await web!.h.db.insert(schema.recoveryCases).values({ ...first!, id: "rc_same_address", storeKey: "sub_same_address", token: "tok_same_address_0123456789", centerToken: "center_same_address_0123456789", email: "Buyer@Example.com", nextStepAt: new Date(web!.h.now().getTime() + DAY), skipReason: null });
    const post = await web!.raw(`/v1/recovery/u/${tok}`, { method: "POST" });
    expect(await post.text()).toContain("buyer@example.com will get no more of these emails");
    const [sup] = await web!.h.db.select().from(schema.emailSuppressions).where(eq(schema.emailSuppressions.email, "buyer@example.com"));
    expect(sup).toBeTruthy();
    expect((await cases())[0]).toMatchObject({ skip_reason: "unsubscribed", next_message_at: null });
    const [other] = await web!.h.db.select().from(schema.recoveryCases).where(eq(schema.recoveryCases.id, "rc_same_address"));
    expect(other).toMatchObject({ skipReason: "unsubscribed", nextStepAt: null, unsubscribedAt: null });
    web!.h.setNow(new Date(web!.h.now().getTime() + 8 * DAY));
    expect(await run()).toMatchObject({ sent: 0 });
    expect(recoveryMails(web!.mail)).toHaveLength(1);
    expect((await web!.raw("/v1/recovery/u/not-a-real-token-at-all")).status).toBe(404);
  });

  it("settings: validation, off by default, the schedule moves open cases, Send test, Run now needs it on", async () => {
    web = await webEnv();
    const g = await web.api("GET", `${P()}/payment_recovery`);
    expect(g.body).toMatchObject({ enabled: false, window_days: 30, include_sandbox: false, steps: DEFAULT_STEPS });
    expect((await web.api("POST", `${P()}/payment_recovery/actions/run`, {})).status).toBe(422);
    const bad = [
      settings({ steps: [DEFAULT_STEPS[1], DEFAULT_STEPS[0]] }),
      settings({ steps: [] }),
      settings({ steps: Array.from({ length: 6 }, (_, i) => ({ ...DEFAULT_STEPS[0], day: i })) }),
      settings({ window_days: 7, steps: [{ ...DEFAULT_STEPS[0], day: 0 }, { ...DEFAULT_STEPS[0], day: 7 }] }),
      settings({ window_days: 90 }),
      settings({ steps: [{ ...DEFAULT_STEPS[0], subject: "" }] }),
    ];
    for (const b of bad) expect((await web.api("POST", `${P()}/payment_recovery`, b)).status, JSON.stringify(b)).toBe(400);
    const saved = await web.api("POST", `${P()}/payment_recovery`, settings({ sender_name: "Scanner Pro", steps: [{ ...DEFAULT_STEPS[0], day: 1 }] }));
    expect(saved.body).toMatchObject({ enabled: true, sender_name: "Scanner Pro", steps: [{ day: 1 }] });
    const t = await web.api("POST", `${P()}/payment_recovery/actions/send_test`, { email: "dev@scanner.example" });
    expect(t.status).toBe(200);
    expect(web.mail.sent.at(-1)).toMatchObject({ to: "dev@scanner.example", subject: "[Test] Your payment for Scanner Pro didn't go through", fromName: "Scanner Pro" });
    // The test email's unsubscribe link changes nothing.
    const tp = await web.h.fetch("/v1/recovery/u/test-email-preview-token", { key: "", method: "POST", body: "List-Unsubscribe=One-Click", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(tp.status).toBe(200);
    expect(await tp.text()).toContain("This was a test email");
    expect((await web.api("POST", `${P()}/payment_recovery/actions/send_test`, { email: "a@b.c, d@e.f" })).status).toBe(400);
    expect((await web.api("POST", `${P()}/payment_recovery/actions/send_test`, { email: "dev@scanner.example", step: 3 })).status).toBe(400);
  });
});

describe("App Store", () => {
  let pki: Pki;
  beforeAll(async () => { pki = await makePki(); setAppleRootsForTesting([pki.rootPem]); });
  afterAll(() => setAppleRootsForTesting(null));
  const send = async (type: string, subtype: string | undefined, tx: ReturnType<typeof transaction>, renewal = renewalInfo()) =>
    apple!.notify(await notificationBody(pki, type, subtype, tx, renewal, { signedDate: apple!.now().getTime() }));

  it("DID_FAIL_TO_RENEW opens a case; the tick emails a link to Apple's payment page; BILLING_RECOVERY recovers it", async () => {
    apple = await appleHarness();
    const first = transaction();
    expect((await apple.postReceipt("user1", await signJws(first, pki))).status).toBe(200);
    await apple.request("/v1/subscribers/user1/attributes", { method: "POST", headers: { Authorization: "Bearer appl_testkey123", "content-type": "application/json" }, body: JSON.stringify({ attributes: { $email: { value: "user1@example.com", updated_at_ms: T0 } } }) });
    await apple.db.update(schema.projects).set({ recoverySettings: settings({ include_sandbox: false }) }).where(eq(schema.projects.id, "proj1"));
    apple.setNow(T0 + 30 * DAY + 60_000);
    expect((await send("DID_FAIL_TO_RENEW", "GRACE_PERIOD", first, renewalInfo({ isInBillingRetryPeriod: true, gracePeriodExpiresDate: T0 + 46 * DAY, expirationIntent: 2 }))).status).toBe(200);
    const [c] = await apple.db.select().from(schema.recoveryCases);
    expect(c).toMatchObject({ store: "app_store", status: "open", isSandbox: false, atRiskUsd: 9.99, graceExpiresAt: new Date(T0 + 46 * DAY) });
    // The same notification again opens nothing new.
    await send("DID_FAIL_TO_RENEW", "GRACE_PERIOD", first, renewalInfo({ isInBillingRetryPeriod: true, gracePeriodExpiresDate: T0 + 46 * DAY, expirationIntent: 2 }));
    expect(await apple.db.select().from(schema.recoveryCases)).toHaveLength(1);

    // The minute tick sends day 0, with https links and List-Unsubscribe.
    const mail = memoryMailer();
    const r = await tick(apple.db, apple.now(), fetch, { mailer: mail, publicUrl: "https://api.example.com" });
    expect(r.recovery).toMatchObject({ sent: 1 });
    expect(mail.sent[0]).toMatchObject({ to: "user1@example.com", headers: { "List-Unsubscribe": `<https://api.example.com/v1/recovery/u/${c!.token}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } });
    const click = await apple.request(`/v1/recovery/l/${c!.token}`, { redirect: "manual" });
    expect(click.status).toBe(303);
    expect(click.headers.get("location")).toBe("https://apps.apple.com/account/billing");

    apple.setNow(T0 + 31 * DAY);
    const recovered = transaction({ transactionId: "2000000004", originalTransactionId: "2000000001", purchaseDate: apple.now().getTime(), expiresDate: T0 + 61 * DAY, signedDate: apple.now().getTime() });
    expect((await send("DID_RENEW", "BILLING_RECOVERY", recovered)).status).toBe(200);
    const [done] = await apple.db.select().from(schema.recoveryCases);
    expect(done).toMatchObject({ status: "recovered", attributed: true, recoveredUsd: 9.99, recoveredTransactionId: "2000000004" });
  });

  it("a recovery before any email counts as recovered without a message; a case past its window is lost", async () => {
    apple = await appleHarness();
    const first = transaction();
    await apple.postReceipt("user1", await signJws(first, pki));
    // Recovery is off: the case is tracked, nothing is sent.
    apple.setNow(T0 + 30 * DAY + 60_000);
    await send("DID_FAIL_TO_RENEW", undefined, first, renewalInfo({ isInBillingRetryPeriod: true, expirationIntent: 2 }));
    const mail = memoryMailer();
    expect((await runPaymentRecovery({ db: apple.db, mailer: mail, now: apple.now, publicUrl: "https://api.example.com" })).sent).toBe(0);
    apple.setNow(T0 + 32 * DAY);
    await send("DID_RENEW", "BILLING_RECOVERY", transaction({ transactionId: "2000000005", originalTransactionId: "2000000001", purchaseDate: apple.now().getTime(), expiresDate: T0 + 62 * DAY, signedDate: apple.now().getTime() }));
    let [c] = await apple.db.select().from(schema.recoveryCases);
    expect(c).toMatchObject({ status: "recovered", attributed: false, recoveredUsd: 9.99 });

    // A second failure a month later, never recovered: lost after the 30-day window.
    apple.setNow(T0 + 62 * DAY + 60_000);
    await send("DID_FAIL_TO_RENEW", undefined, transaction({ transactionId: "2000000005", originalTransactionId: "2000000001", purchaseDate: T0 + 32 * DAY, expiresDate: T0 + 62 * DAY }), renewalInfo({ isInBillingRetryPeriod: true, expirationIntent: 2 }));
    expect(await apple.db.select().from(schema.recoveryCases).where(eq(schema.recoveryCases.status, "open"))).toHaveLength(1);
    apple.setNow(T0 + 93 * DAY);
    expect((await runPaymentRecovery({ db: apple.db, mailer: mail, now: apple.now })).closed).toBe(1);
    [c] = await apple.db.select().from(schema.recoveryCases).where(eq(schema.recoveryCases.status, "lost"));
    expect(c).toMatchObject({ lostReason: "window_passed", nextStepAt: null });
    expect(mail.sent).toHaveLength(0);
  });

  it("no address: the step is skipped and the next one goes once $email is set; enabling late sends only the latest due step", async () => {
    apple = await appleHarness();
    const first = transaction();
    await apple.postReceipt("user1", await signJws(first, pki));
    apple.setNow(T0 + 30 * DAY + 60_000);
    await send("DID_FAIL_TO_RENEW", undefined, first, renewalInfo({ isInBillingRetryPeriod: true, expirationIntent: 2 }));
    const mail = memoryMailer();
    const go = () => runPaymentRecovery({ db: apple!.db, mailer: mail, now: apple!.now, publicUrl: "https://api.example.com" });
    // Turned on four days in: only day 3's email is due (day 0's is skipped).
    apple.setNow(T0 + 34 * DAY);
    await apple.db.update(schema.projects).set({ recoverySettings: settings({ include_sandbox: false }) }).where(eq(schema.projects.id, "proj1"));
    expect(await go()).toMatchObject({ sent: 0, skipped: 1 });
    let [c] = await apple.db.select().from(schema.recoveryCases);
    expect(c).toMatchObject({ skipReason: "no_email", stepsSent: 2 });
    await apple.request("/v1/subscribers/user1/attributes", { method: "POST", headers: { Authorization: "Bearer appl_testkey123", "content-type": "application/json" }, body: JSON.stringify({ attributes: { $email: { value: "late@example.com", updated_at_ms: T0 + 34 * DAY } } }) });
    apple.setNow(T0 + 37 * DAY + 60_000);
    expect(await go()).toMatchObject({ sent: 1 });
    expect(mail.sent.map((m) => [m.to, m.subject])).toEqual([["late@example.com", "Last reminder: your Scanner subscription"]]);
    [c] = await apple.db.select().from(schema.recoveryCases);
    expect(c).toMatchObject({ stepsSent: 3, nextStepAt: null, skipReason: null });
    // A refund closes the case as lost.
    await send("REFUND", undefined, { ...first, revocationDate: apple.now().getTime(), revocationReason: 0 } as never);
    [c] = await apple.db.select().from(schema.recoveryCases);
    expect(c).toMatchObject({ status: "lost", lostReason: "refunded" });
  });
});

describe("Google Play", () => {
  let keys: Keys;
  beforeAll(async () => { keys = await makeKeys(); });
  const T = new Date("2026-09-01T12:00:00Z");
  const note = (type: number, token: string) => ({ subscriptionNotification: { version: "1.0", notificationType: type, purchaseToken: token, subscriptionId: "pro" } });

  it("account hold opens a case with a link to the Play subscription page; SUBSCRIPTION_RECOVERED recovers it", async () => {
    play = await googleEnv(keys);
    play.g.subs.set("tok_1", playSub({ start: T, expiry: new Date("2026-10-01T12:00:00Z"), order: "GPA.1" }));
    expect((await play.receipt({ app_user_id: "user_g", fetch_token: "tok_1", product_id: "pro", platform_product_ids: [{ product_id: "pro", base_plan_id: "monthly" }] })).status).toBe(200);
    await play.call("/v1/subscribers/user_g/attributes", { method: "POST", key: play.h.ids.androidKey, json: { attributes: { $email: { value: "g@example.com", updated_at_ms: T.getTime() } } } });
    await play.h.db.update(schema.projects).set({ recoverySettings: settings({ include_sandbox: false }) }).where(eq(schema.projects.id, play.h.ids.project));
    play.h.setNow(new Date("2026-10-01T13:00:00Z"));
    play.g.subs.set("tok_1", playSub({ start: T, expiry: new Date("2026-10-01T12:00:00Z"), order: "GPA.1", state: "SUBSCRIPTION_STATE_ON_HOLD", ack: true }));
    expect((await play.rtdn(note(5, "tok_1"))).status).toBe(200);
    const [c] = await play.h.db.select().from(schema.recoveryCases);
    expect(c).toMatchObject({ store: "play_store", status: "open", productId: "pro" });
    const mail = memoryMailer();
    expect((await runPaymentRecovery({ db: play.h.db, mailer: mail, now: play.h.now, publicUrl: "https://api.example.com" })).sent).toBe(1);
    const click = await play.call(`/v1/recovery/l/${c!.token}`, { redirect: "manual" });
    expect(click.headers.get("location")).toBe("https://play.google.com/store/account/subscriptions?sku=pro&package=com.example.scanner");
    play.h.setNow(new Date("2026-10-03T12:00:00Z"));
    play.g.subs.set("tok_1", playSub({ start: T, expiry: new Date("2026-11-03T12:00:00Z"), order: "GPA.1..0", ack: true }));
    await play.rtdn(note(1, "tok_1"));
    const [done] = await play.h.db.select().from(schema.recoveryCases);
    expect(done).toMatchObject({ status: "recovered", attributed: true });
    expect(done!.recoveredUsd).toBeCloseTo(9.99);
  });
});

describe("Test Store and sandbox", () => {
  it("a Test Store billing issue opens a sandbox case: no email unless sandbox is on; its link explains the test", async () => {
    web = await webEnv();
    const r = await web.api("POST", `${P()}/test_purchases`, { app_user_id: "tester", product_id: "p4", scenario: "billing_issue", offset_days: 31 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    await web.api("POST", `${P()}/customers/tester/attributes`, { attributes: [{ name: "$email", value: "tester@example.com" }] });
    await web.api("POST", `${P()}/payment_recovery`, settings({ include_sandbox: false }));
    expect(await run()).toMatchObject({ sent: 0 });
    const [c] = await cases("&status=open");
    expect(c).toMatchObject({ store: "test_store", environment: "sandbox", status: "open" });
    await web.api("POST", `${P()}/payment_recovery`, settings({ include_sandbox: true }));
    expect(await run()).toMatchObject({ sent: 1 });
    const [row] = await web.h.db.select().from(schema.recoveryCases).where(and(eq(schema.recoveryCases.store, "test_store")));
    const page = await web.raw(`/v1/recovery/l/${row!.token}`);
    expect(await page.text()).toContain("This is a test purchase");
    expect((await cases()).length).toBe(1);
    // A new schedule moves the open case's next step to its new day.
    const before = (await cases())[0];
    expect(before.messages_sent).toBe(1);
    await web.api("POST", `${P()}/payment_recovery`, settings({ include_sandbox: true, steps: [DEFAULT_STEPS[0], { ...DEFAULT_STEPS[1], day: 5 }] }));
    expect((await cases())[0].next_message_at).toBe(before.detected_at + 5 * DAY);
    await web.api("POST", `${P()}/payment_recovery`, settings({ include_sandbox: true, steps: [DEFAULT_STEPS[0]] }));
    expect((await cases())[0].next_message_at).toBeNull();
  });
});

describe("tick fairness", () => {
  /** A project with recovery on and `n` open App Store cases due now, each with an address. */
  async function projectWithDueCases(db: WebEnv["h"]["db"], projectId: string, n: number, now: Date, o: { linkBase?: string | null } = {}) {
    const [base] = await db.select().from(schema.projects).limit(1);
    await db.insert(schema.projects).values({ ...base!, id: projectId, name: `Project ${projectId}`, recoverySettings: { ...settings(), link_base: o.linkBase === undefined ? "https://api.example.com" : o.linkBase } }).onConflictDoNothing();
    for (let i = 0; i < n; i++) {
      const cid = `cus_${projectId}_${i}`, sid = `sub_${projectId}_${i}`;
      await db.insert(schema.customers).values({ id: cid, projectId, originalAppUserId: `u_${projectId}_${i}` });
      await db.insert(schema.customerAttributes).values({ customerId: cid, key: "$email", value: `u${i}@${projectId.replace(/_/g, "-")}.example.com`, updatedAtMs: now.getTime() });
      await db.insert(schema.subscriptions).values({ id: sid, projectId, customerId: cid, store: "app_store", storeKey: `otx_${projectId}_${i}`, productIdentifier: "pro.monthly", storeTransactionId: `tx_${projectId}_${i}`, purchaseDate: new Date(now.getTime() - 31 * DAY), originalPurchaseDate: new Date(now.getTime() - 31 * DAY), expiresDate: new Date(now.getTime() - DAY), billingIssuesDetectedAt: new Date(now.getTime() - 60_000) } as typeof schema.subscriptions.$inferInsert);
      await db.insert(schema.recoveryCases).values({ id: `rcv_${projectId}_${i}`, projectId, customerId: cid, subscriptionId: sid, store: "app_store", storeKey: `otx_${projectId}_${i}`, productId: "pro.monthly", detectedAt: new Date(now.getTime() - 60_000 - i), nextStepAt: new Date(now.getTime() - 60_000 - i), token: `tok_${projectId}_${i}_000000000000` });
    }
  }

  it("a project at its daily cap, or without a link base, does not hold back other projects' emails", async () => {
    web = await webEnv({});
    const { db } = web.h;
    const now = web.h.now();
    // Project A has hit its daily cap (2,000 emails in the last 24 hours) and has the oldest due cases.
    await projectWithDueCases(db, "proj_capped", 3, new Date(now.getTime() - 3_600_000));
    await db.insert(schema.recoveryCases).values({ id: "rcv_capped_sent", projectId: "proj_capped", customerId: "cus_proj_capped_0", store: "app_store", storeKey: "otx_old", productId: "pro.monthly", status: "lost", detectedAt: new Date(now.getTime() - 2 * DAY), token: "tok_capped_sent_000000000000" });
    await db.insert(schema.recoveryMessages).values(Array.from({ length: 2_000 }, (_, i) => ({ id: `rcm_cap_${i}`, caseId: "rcv_capped_sent", projectId: "proj_capped", step: 0, email: "x@example.com", sentAt: new Date(now.getTime() - 3_600_000) })));
    // Project B (self-hosted server, no public URL) never saved its settings from the dashboard: no link base.
    await projectWithDueCases(db, "proj_nobase", 3, new Date(now.getTime() - 3_000_000), { linkBase: null });
    // Project C has one due case, newer than all of them.
    await projectWithDueCases(db, "proj_ok", 1, now);
    const mail = memoryMailer();
    const r = await runPaymentRecovery({ db, mailer: mail, now: () => now }, { limit: 2 });
    expect(r.sent).toBe(1);
    expect(mail.sent.map((m) => m.to)).toEqual(["u0@proj-ok.example.com"]);
    // The capped project's cases stay due for when its cap frees up.
    const [capped] = await db.select().from(schema.recoveryCases).where(eq(schema.recoveryCases.id, "rcv_proj_capped_0"));
    expect(capped).toMatchObject({ status: "open", stepsSent: 0 });
  });

  it("the Customer Center link of a store purchase opens the store's own page directly", async () => {
    web = await webEnv({});
    await projectWithDueCases(web.h.db, "proj_cc", 1, web.h.now());
    const [c] = await web.h.db.select().from(schema.recoveryCases).where(eq(schema.recoveryCases.projectId, "proj_cc"));
    expect(c!.centerToken).toMatch(/^[0-9a-f]{64}$/);
    expect(c!.centerToken).not.toBe(c!.token);
    const r = await web.raw(`/v1/recovery/c/${c!.centerToken}`, { redirect: "manual" });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("https://apps.apple.com/account/billing");
  });

  it("an imported chain whose billing issue is older than the recovery window opens no case", async () => {
    web = await webEnv({});
    const { db } = web.h;
    const now = web.h.now();
    await projectWithDueCases(db, "proj_imp", 1, now);
    await db.delete(schema.recoveryCases).where(eq(schema.recoveryCases.projectId, "proj_imp"));
    const base = { projectId: "proj_imp", customerId: "cus_proj_imp_0", subscriptionId: "sub_proj_imp_0", appId: null, store: "app_store", productId: "pro.monthly", isSandbox: false,
      derived: [{ type: "INITIAL_PURCHASE" }] as never, gracePeriodExpiresAt: null, priceUsd: 9.99, transactionId: "tx_imp", now };
    // A billing issue from 90 days ago (an import of history): already past the 30-day window, nothing to recover.
    await trackRecovery(db, { ...base, storeKey: "otx_proj_imp_0", billingIssuesDetectedAt: new Date(now.getTime() - 90 * DAY) });
    expect(await db.select().from(schema.recoveryCases).where(eq(schema.recoveryCases.projectId, "proj_imp"))).toHaveLength(0);
    // One from yesterday still opens a case.
    await trackRecovery(db, { ...base, storeKey: "otx_proj_imp_0", billingIssuesDetectedAt: new Date(now.getTime() - DAY) });
    expect(await db.select().from(schema.recoveryCases).where(eq(schema.recoveryCases.projectId, "proj_imp"))).toEqual([expect.objectContaining({ status: "open" })]);
  });
});
