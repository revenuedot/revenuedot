// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: Stripe as a STORE (apps of type `stripe`) proven against Stripe's REAL test-mode API: a real Stripe sandbox
// plays a developer's own account; RevenueDot runs as a real Node server on its own Railway development database; the
// Stripe CLI forwards real webhook events to it; Stripe test clocks advance time. Run (keys by name, never printed):
//   set -a; source ~/.config/revenuedot/dev.env; source apps/server/.env.local; set +a
//   pnpm tsx scripts/e2e/real-stripe/store.ts [scenario ...]
import { createRequire } from "node:module";
import { join } from "node:path";
import { Checks, ROOT, cleanupStripe, payCheckout, forward, listenSecret, signUp, sleep, startStack, stripeApi, testKey, until, type Dev, type Stack } from "./lib.ts";

const c = new Checks("real-stripe-store");
const key = testKey("REVENUEDOT_TEST_STRIPE_SECRET_KEY");
const S = stripeApi(key);
const stamp = Date.now().toString(36);
const DAY = 86400;
const startedAt = Math.floor(Date.now() / 1000) - 5;
const CODE = `REAL20${stamp.toUpperCase()}`;

interface World { stack: Stack; dev: Dev; appId: string; pub: string; whsec: string; pro: any; prices: Record<string, string>; ents: any }

const ci = async (w: World, user: string) => {
  const r = await fetch(`${w.stack.base}/v1/subscribers/${encodeURIComponent(user)}`, { headers: { authorization: `Bearer ${w.pub}`, "x-platform": "stripe" } });
  return (await r.json() as any).subscriber ?? null;
};
const events = async (w: World, user?: string, type?: string) => {
  const rows = await w.stack.sql<{ payload: any }[]>`SELECT payload FROM events WHERE project_id = ${w.dev.projectId} ORDER BY event_timestamp_ms, created_at`;
  return rows.map((r) => r.payload.event as any).filter((e) => (!type || e.type === type) && (!user || e.app_user_id === user || (e.aliases ?? []).includes(user)));
};
const notes = async (w: World) => (await w.stack.sql<any[]>`SELECT type, processed_at IS NOT NULL AS done, error, to_char(created_at, 'HH24:MI:SS') AS at FROM store_notifications WHERE project_id = ${w.dev.projectId} ORDER BY created_at`).map((r) => `${r.at} ${r.type}${r.done ? "" : " (NOT PROCESSED)"}${r.error ? ` ERROR ${String(r.error).slice(0, 160)}` : ""}`);
const types = async (w: World, user: string) => (await events(w, user)).map((e) => e.type);
const receipt = (w: World, user: string, token: string) => fetch(`${w.stack.base}/v1/receipts`, { method: "POST", headers: { authorization: `Bearer ${w.pub}`, "x-platform": "stripe", "content-type": "application/json" }, body: JSON.stringify({ app_user_id: user, fetch_token: token }) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) as any }));

/** A customer with a card (and optionally a test clock). */
async function customer(name: string, o: { pm?: string; clock?: { id: string }; email?: string } = {}) {
  const cu = await S("POST", "/v1/customers", { name, email: o.email ?? `${name}-${stamp}@real-stripe.test`, test_clock: o.clock?.id, metadata: { rd_test: stamp } });
  const pm = await S("POST", `/v1/payment_methods/${o.pm ?? "pm_card_visa"}/attach`, { customer: cu.id });
  await S("POST", `/v1/customers/${cu.id}`, { invoice_settings: { default_payment_method: pm.id } });
  return { ...cu, pm: pm.id as string };
}
const clock = (name: string, t = Math.floor(Date.now() / 1000)) => S("POST", "/v1/test_helpers/test_clocks", { frozen_time: t, name: `${name}-${stamp}` });
async function advance(clk: { id: string }, to: number) {
  await S("POST", `/v1/test_helpers/test_clocks/${clk.id}/advance`, { frozen_time: to });
  await until(async () => (await S("GET", `/v1/test_helpers/test_clocks/${clk.id}`)).status === "ready", { timeoutMs: 120_000, everyMs: 1500 });
}

async function setup(): Promise<World> {
  const whsec = listenSecret(key);
  const stack = await startStack("rd_stripe_real", 5710);
  const dev = await signUp(stack.base, "storedev");
  const app = await dev.v2("POST", "/apps", { name: "Web", type: "stripe", stripe: { stripe_secret_key: key, stripe_webhook_secret: whsec, track_new_purchases: true } });
  const pub = (await dev.v2("GET", `/apps/${app.id}/public_api_keys`)).items[0].key as string;
  const prod = await S("POST", "/v1/products", { name: `RD Pro ${stamp}`, metadata: { rd_test: stamp } });
  const mk = (nick: string, amt: number, interval: "month" | "year") => S("POST", "/v1/prices", { product: prod.id, currency: "usd", unit_amount: amt, recurring: { interval }, nickname: nick }).then((p) => p.id as string);
  const prices = { monthly: await mk("monthly", 999, "month"), annual: await mk("annual", 7999, "year"), } as Record<string, string>;
  prices.once = (await S("POST", "/v1/prices", { product: prod.id, currency: "usd", unit_amount: 499, nickname: "coins" })).id;
  const pro = await dev.v2("POST", "/entitlements", { lookup_key: "pro", display_name: "Pro" });
  const ids: string[] = [];
  for (const [k, type, dur] of [["monthly", "subscription", "P1M"], ["annual", "subscription", "P1Y"], ["once", "non_consumable", undefined]] as const) {
    const p = await dev.v2("POST", "/products", { store_identifier: prices[k], app_id: app.id, type, display_name: `Pro ${k}`, ...(dur ? { subscription: { duration: dur } } : {}) });
    ids.push(p.id);
  }
  await dev.v2("POST", `/entitlements/${pro.id}/actions/attach_products`, { product_ids: ids });
  return { stack, dev, appId: app.id, pub, whsec, pro, prices, ents: null };
}

type Scenario = (w: World) => Promise<void>;
const scenarios: Record<string, Scenario> = {
  async credentials(w) {
    c.begin("credential check against real Stripe");
    const ok = await w.dev.v2r("POST", `/apps/${w.appId}/actions/verify_credentials`, {});
    c.has("the sandbox key is valid and in test mode", ok.body, { valid: true, mode: "test" });
    const bad = await w.dev.v2r("POST", `/apps/${w.appId}/actions/verify_credentials`, { stripe: { stripe_secret_key: "sk_test_" + "a".repeat(60) } });
    c.has("a made-up key is reported invalid", bad.body, { valid: false });
    console.log("   bad key answer:", JSON.stringify(bad.body).slice(0, 300));
    const pk = await w.dev.v2r("POST", "/apps", { name: "pk", type: "stripe", stripe: { stripe_secret_key: "pk_test_" + "a".repeat(40), stripe_webhook_secret: w.whsec } });
    c.check("a publishable key is refused", pk.status >= 400, pk);
  },

  async subscribe(w) {
    c.begin("subscription posted as a receipt, then the real webhooks");
    const user = `sub_user_${stamp}`;
    const cu = await customer("subscribe");
    const sub = await S("POST", "/v1/subscriptions", { customer: cu.id, items: [{ price: w.prices.monthly }], metadata: { app_user_id: user } });
    c.check("Stripe made the subscription active (card charged)", sub.status === "active", sub.status);
    const r = await receipt(w, user, sub.id);
    c.check("POST /v1/receipts answers 200", r.status === 200, r);
    const info = await ci(w, user);
    c.check("pro entitlement is active", info?.entitlements?.pro && new Date(info.entitlements.pro.expires_date) > new Date(), info?.entitlements);
    c.has("subscription recorded as Stripe, sandbox, normal period", info?.subscriptions?.[w.prices.monthly], { store: "stripe", is_sandbox: true, period_type: "normal" });
    await until(async () => (await events(w, user)).length >= 1, { timeoutMs: 15_000 });
    const ev = (await events(w, user, "INITIAL_PURCHASE"))[0];
    c.has("INITIAL_PURCHASE with price 9.99 USD, sandbox, STRIPE", ev, { store: "STRIPE", price: 9.99, currency: "USD", environment: "SANDBOX", entitlement_ids: ["pro"] });
    await sleep(6000); // let real webhooks (subscription.created, invoice.paid, ...) arrive
    c.eq("the real webhooks change nothing: still one INITIAL_PURCHASE and nothing else", await types(w, user), ["INITIAL_PURCHASE"]);
    const tx = await w.stack.sql`SELECT kind, revenue_usd, is_sandbox FROM transactions WHERE project_id = ${w.dev.projectId} AND app_user_id = ${user}`.catch(async () => w.stack.sql`SELECT * FROM transactions WHERE project_id = ${w.dev.projectId}`);
    console.log("   transactions:", JSON.stringify(tx).slice(0, 300));
    const notif = await w.stack.sql`SELECT count(*)::int AS n FROM store_notifications WHERE project_id = ${w.dev.projectId}`.catch(() => [{ n: -1 }]);
    c.check("real signed webhooks reached the server and were stored", (notif[0] as any).n > 0, notif);
  },

  async renewal(w) {
    c.begin("renewal with a Stripe test clock");
    const user = `renew_user_${stamp}`;
    const clk = await clock("renew");
    const cu = await customer("renew", { clock: clk });
    const sub = await S("POST", "/v1/subscriptions", { customer: cu.id, items: [{ price: w.prices.monthly }], metadata: { app_user_id: user } });
    c.eq("first receipt 200", (await receipt(w, user, sub.id)).status, 200);
    const t0 = clk.frozen_time as number;
    await advance(clk, t0 + 31 * DAY);
    await advance(clk, t0 + 31 * DAY + 2 * 3600); // Stripe finalizes and pays a renewal invoice about an hour after creating it
    const ok = await until(async () => (await types(w, user)).includes("RENEWAL"), { timeoutMs: 30_000 });
    c.check("RENEWAL arrives from the real webhook, with no receipt posted", ok, { types: await types(w, user), notes: await notes(w) });
    console.log("   notifications:\n    " + (await notes(w)).join("\n    "));
    const ev = (await events(w, user, "RENEWAL"))[0];
    c.has("RENEWAL at 9.99 USD", ev, { price: 9.99, currency: "USD", store: "STRIPE" });
    const info = await ci(w, user);
    const exp = info?.subscriptions?.[w.prices.monthly]?.expires_date;
    console.log("   after renewal expires_date:", exp, "now:", new Date().toISOString());
    c.check("entitlement runs to the new period end", info?.entitlements?.pro?.expires_date === exp, info?.entitlements);
    const tx = await w.stack.sql`SELECT kind, revenue_usd FROM transactions WHERE project_id = ${w.dev.projectId} AND customer_id IN (SELECT id FROM customers WHERE project_id = ${w.dev.projectId} AND app_user_id = ${user}) ORDER BY purchased_at`.catch((e) => [String(e)]);
    console.log("   transactions:", JSON.stringify(tx));
    await S("DELETE", `/v1/test_helpers/test_clocks/${clk.id}`);
  },

  async trial(w) {
    c.begin("free trial and its conversion (test clock)");
    const user = `trial_user_${stamp}`;
    const clk = await clock("trial");
    const cu = await customer("trial", { clock: clk });
    const sub = await S("POST", "/v1/subscriptions", { customer: cu.id, items: [{ price: w.prices.monthly }], trial_period_days: 7, metadata: { app_user_id: user } });
    c.eq("Stripe says trialing", sub.status, "trialing");
    c.eq("receipt 200", (await receipt(w, user, sub.id)).status, 200);
    const info = await ci(w, user);
    c.has("trial period type, entitlement active until about 7 days", info?.subscriptions?.[w.prices.monthly], { period_type: "trial", store: "stripe" });
    c.check("pro active during the trial", !!info?.entitlements?.pro, info?.entitlements);
    const ev = (await events(w, user, "INITIAL_PURCHASE"))[0];
    c.has("INITIAL_PURCHASE is a TRIAL at price 0", ev, { period_type: "TRIAL", price: 0 });
    const t0 = clk.frozen_time as number;
    await advance(clk, t0 + 8 * DAY); await advance(clk, t0 + 8 * DAY + 2 * 3600);
    const ok = await until(async () => (await types(w, user)).includes("RENEWAL"), { timeoutMs: 30_000 });
    c.check("RENEWAL after the trial", ok, { types: await types(w, user), notes: await notes(w) });
    const rn = (await events(w, user, "RENEWAL"))[0];
    c.has("it is a trial conversion at 9.99", rn, { is_trial_conversion: true, price: 9.99, period_type: "NORMAL" });
    await S("DELETE", `/v1/test_helpers/test_clocks/${clk.id}`);
  },

  async trialNoCard(w) {
    c.begin("trial without a card ends in cancellation");
    const user = `trialnc_user_${stamp}`;
    const clk = await clock("trialnc");
    const cu = await S("POST", "/v1/customers", { name: "nc", email: `nc-${stamp}@real-stripe.test`, test_clock: clk.id });
    const sub = await S("POST", "/v1/subscriptions", { customer: cu.id, items: [{ price: w.prices.monthly }], trial_period_days: 3, trial_settings: { end_behavior: { missing_payment_method: "cancel" } }, metadata: { app_user_id: user } });
    c.eq("receipt 200", (await receipt(w, user, sub.id)).status, 200);
    const t0 = clk.frozen_time as number;
    await advance(clk, t0 + 4 * DAY); await advance(clk, t0 + 4 * DAY + 2 * 3600);
    await until(async () => (await types(w, user)).includes("CANCELLATION"), { timeoutMs: 25_000 });
    // The test clock runs ahead of this server's real clock, so access to the trial's end date (3 real days away) is still
    // honest here; the event is what proves the trial ended without a card.
    c.check("trial ends without a card: CANCELLATION", (await types(w, user)).includes("CANCELLATION"), { types: await types(w, user), notes: await notes(w) });
    const info = await ci(w, user);
    c.check("access stops at the trial's end date", !!info?.entitlements?.pro && new Date(info.entitlements.pro.expires_date).getTime() - Date.now() < 4 * DAY * 1000, info?.entitlements);
    await S("DELETE", `/v1/test_helpers/test_clocks/${clk.id}`);
  },

  async cancel(w) {
    c.begin("cancel at period end, undo, then cancel immediately");
    const user = `cancel_user_${stamp}`;
    const cu = await customer("cancel");
    const sub = await S("POST", "/v1/subscriptions", { customer: cu.id, items: [{ price: w.prices.monthly }], metadata: { app_user_id: user } });
    await receipt(w, user, sub.id);
    await S("POST", `/v1/subscriptions/${sub.id}`, { cancel_at_period_end: true });
    await until(async () => (await types(w, user)).includes("CANCELLATION"), { timeoutMs: 20_000 });
    const cancel = (await events(w, user, "CANCELLATION"))[0];
    c.has("CANCELLATION UNSUBSCRIBE", cancel, { cancel_reason: "UNSUBSCRIBE" });
    let info = await ci(w, user);
    c.check("still entitled until the period ends, unsubscribe_detected_at set", !!info?.entitlements?.pro && !!info?.subscriptions?.[w.prices.monthly]?.unsubscribe_detected_at, info?.subscriptions);
    await S("POST", `/v1/subscriptions/${sub.id}`, { cancel_at_period_end: false });
    await until(async () => (await types(w, user)).includes("UNCANCELLATION"), { timeoutMs: 20_000 });
    c.check("UNCANCELLATION", (await types(w, user)).includes("UNCANCELLATION"), { types: await types(w, user), notes: await notes(w) });
    await S("DELETE", `/v1/subscriptions/${sub.id}`);
    await until(async () => (await types(w, user)).includes("EXPIRATION"), { timeoutMs: 20_000 });
    c.check("immediate cancellation: EXPIRATION", (await types(w, user)).includes("EXPIRATION"), { types: await types(w, user), notes: await notes(w) });
    info = await ci(w, user);
    c.check("pro ended at once", !info?.entitlements?.pro || new Date(info.entitlements.pro.expires_date) <= new Date(), info?.entitlements);
  },

  async refund(w) {
    c.begin("full and partial refunds");
    const user = `refund_user_${stamp}`;
    const cu = await customer("refund");
    const sub = await S("POST", "/v1/subscriptions", { customer: cu.id, items: [{ price: w.prices.monthly }], metadata: { app_user_id: user } });
    await receipt(w, user, sub.id);
    const inv = await S("GET", `/v1/invoices/${sub.latest_invoice}`, { expand: ["payments"] });
    const pi = inv.payments?.data?.[0]?.payment?.payment_intent;
    c.check("found the payment intent", !!pi, inv.payments);
    await S("POST", "/v1/refunds", { payment_intent: pi, amount: 300 });
    await sleep(6000);
    c.check("a partial refund does not end the subscription", !(await types(w, user)).includes("CANCELLATION"), { types: await types(w, user) });
    await S("POST", "/v1/refunds", { payment_intent: pi });
    await until(async () => (await types(w, user)).includes("CANCELLATION"), { timeoutMs: 20_000 });
    const cx = (await events(w, user, "CANCELLATION"))[0];
    c.has("full refund is CANCELLATION CUSTOMER_SUPPORT", cx, { cancel_reason: "CUSTOMER_SUPPORT" });
    const info = await ci(w, user);
    c.check("pro ended after the refund", !info?.entitlements?.pro || new Date(info.entitlements.pro.expires_date) <= new Date(), info?.entitlements);
    const tx = await w.stack.sql`SELECT kind, revenue_usd FROM transactions t JOIN customers c ON c.id = t.customer_id WHERE t.project_id = ${w.dev.projectId} AND c.original_app_user_id = ${user} ORDER BY t.created_at`;
    console.log("   transactions:", JSON.stringify(tx));
    c.check("refund row has negative revenue summing to zero", tx.reduce((a: number, r: any) => a + r.revenue_usd, 0) === 0, tx);
  },

  async switchPlan(w) {
    c.begin("switch monthly to annual");
    const user = `switch_user_${stamp}`;
    const cu = await customer("switch");
    const sub = await S("POST", "/v1/subscriptions", { customer: cu.id, items: [{ price: w.prices.monthly }], metadata: { app_user_id: user } });
    await receipt(w, user, sub.id);
    await S("POST", `/v1/subscriptions/${sub.id}`, { items: [{ id: sub.items.data[0].id, price: w.prices.annual }], proration_behavior: "create_prorations", payment_behavior: "pending_if_incomplete" });
    await until(async () => (await types(w, user)).length > 1, { timeoutMs: 20_000 });
    await sleep(4000);
    console.log("   events:", await types(w, user), "notes tail:", (await notes(w)).slice(-6));
    const info = await ci(w, user);
    c.check("now on the annual price", !!info?.subscriptions?.[w.prices.annual], Object.keys(info?.subscriptions ?? {}));
    c.check("event is PRODUCT_CHANGE", (await types(w, user)).includes("PRODUCT_CHANGE"), await types(w, user));
  },

  async pause(w) {
    c.begin("pause collection");
    const user = `pause_user_${stamp}`;
    const cu = await customer("pause");
    const sub = await S("POST", "/v1/subscriptions", { customer: cu.id, items: [{ price: w.prices.monthly }], metadata: { app_user_id: user } });
    await receipt(w, user, sub.id);
    await S("POST", `/v1/subscriptions/${sub.id}`, { pause_collection: { behavior: "void", resumes_at: Math.floor(Date.now() / 1000) + 20 * DAY } });
    await until(async () => (await types(w, user)).includes("SUBSCRIPTION_PAUSED"), { timeoutMs: 20_000 });
    c.check("SUBSCRIPTION_PAUSED", (await types(w, user)).includes("SUBSCRIPTION_PAUSED"), { types: await types(w, user), notes: await notes(w) });
  },

  async webhookOnly(w) {
    c.begin("purchases first seen in a webhook (no receipt posted)");
    const user = `hook_user_${stamp}`;
    const cu = await customer("hook");
    await S("POST", "/v1/subscriptions", { customer: cu.id, items: [{ price: w.prices.monthly }], metadata: { app_user_id: user } });
    const ok = await until(async () => (await types(w, user)).includes("INITIAL_PURCHASE"), { timeoutMs: 25_000 });
    c.check("INITIAL_PURCHASE for the user in the subscription's metadata", ok, { notes: await notes(w) });
    c.check("entitled", !!(await ci(w, user))?.entitlements?.pro);
    const cu2 = await customer("hook2");
    await S("POST", "/v1/subscriptions", { customer: cu2.id, items: [{ price: w.prices.monthly }] });
    await sleep(8000);
    const anon = await w.stack.sql`SELECT original_app_user_id FROM customers WHERE project_id = ${w.dev.projectId} AND original_app_user_id LIKE '%RCAnonymousID%' OR original_app_user_id = ${cu2.id}`;
    console.log("   no-metadata customers:", JSON.stringify(anon));
  },

  async webhookSecurity(w) {
    c.begin("webhook endpoint refuses what Stripe did not sign");
    const url = `${w.stack.base}/v1/notifications/stripe/${w.appId}`;
    const body = JSON.stringify({ id: "evt_forged", object: "event", type: "customer.subscription.updated", data: { object: { id: "sub_x" } } });
    const r1 = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
    c.eq("no signature: 400", r1.status, 400);
    const r2 = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": `t=${Math.floor(Date.now() / 1000)},v1=${"0".repeat(64)}` }, body });
    c.eq("wrong signature: 400", r2.status, 400);
    const bad = await receipt(w, "u", "sub_doesnotexist");
    c.check("a subscription that does not exist: 400 (7103)", bad.status === 400 && bad.body?.code === 7103, bad);
    const bad2 = await receipt(w, "u", "pi_whatever");
    c.check("a token that is not sub_ or cs_: 400", bad2.status === 400, bad2);
    const noauth = await fetch(`${w.stack.base}/v1/receipts`, { method: "POST", headers: { "x-platform": "stripe", "content-type": "application/json" }, body: JSON.stringify({ app_user_id: "u", fetch_token: "sub_x" }) });
    c.check("no API key: 401", noauth.status === 401, noauth.status);
  },

  async failedFirst(w) {
    c.begin("first payment fails (card 4000 0000 0000 0341)");
    const user = `ff_user_${stamp}`;
    const cu = await S("POST", "/v1/customers", { name: "ff", email: `ff-${stamp}@real-stripe.test` });
    const good = await S("POST", "/v1/payment_methods/pm_card_visa/attach", { customer: cu.id });
    // Attach the failing card as the default for the subscription.
    const bad = await S("POST", "/v1/payment_methods/pm_card_chargeCustomerFail/attach", { customer: cu.id });
    const sub = await S("POST", "/v1/subscriptions", { customer: cu.id, items: [{ price: w.prices.monthly }], default_payment_method: bad.id, payment_behavior: "default_incomplete", metadata: { app_user_id: user }, expand: ["latest_invoice.payments"] });
    c.eq("Stripe: incomplete", sub.status, "incomplete");
    const r = await receipt(w, user, sub.id);
    c.check("receipt for an unpaid first invoice is 503 so the backend retries", r.status === 503, r);
    const info = await ci(w, user);
    c.check("no entitlement", !info?.entitlements?.pro, info?.entitlements);
    // Pay with the good card: the receipt now works.
    await S("POST", `/v1/subscriptions/${sub.id}`, { default_payment_method: good.id });
    const inv = await S("POST", `/v1/invoices/${sub.latest_invoice.id}/pay`, { payment_method: good.id });
    c.eq("invoice paid with another card", inv.status, "paid");
    const r2 = await receipt(w, user, sub.id);
    c.check("after payment the receipt is 200", r2.status === 200, r2);
    c.check("entitled", !!(await ci(w, user))?.entitlements?.pro);
  },

  async failedRenewal(w) {
    c.begin("renewal fails, recovery email, then the customer pays");
    const cur = await w.dev.v2("GET", "/payment_recovery");
    await w.dev.v2("POST", "/payment_recovery", { enabled: true, include_sandbox: true, window_days: 30, steps: cur.steps });
    const user = `fr_user_${stamp}`;
    const clk = await clock("fr");
    const cu = await customer("fr", { clock: clk });
    const sub = await S("POST", "/v1/subscriptions", { customer: cu.id, items: [{ price: w.prices.monthly }], metadata: { app_user_id: user } });
    await receipt(w, user, sub.id);
    // The card now declines.
    const bad = await S("POST", "/v1/payment_methods/pm_card_chargeCustomerFail/attach", { customer: cu.id });
    await S("POST", `/v1/customers/${cu.id}`, { invoice_settings: { default_payment_method: bad.id } });
    const t0 = clk.frozen_time as number;
    await advance(clk, t0 + 31 * DAY); await advance(clk, t0 + 31 * DAY + 2 * 3600);
    const ok = await until(async () => (await types(w, user)).includes("BILLING_ISSUE"), { timeoutMs: 30_000 });
    c.check("BILLING_ISSUE arrives from the real invoice.payment_failed", ok, { types: await types(w, user), notes: await notes(w) });
    console.log("   events:", await types(w, user));
    const s1 = await S("GET", `/v1/subscriptions/${sub.id}`);
    c.eq("Stripe: past_due", s1.status, "past_due");
    let info = await ci(w, user);
    console.log("   entitlement during billing issue:", JSON.stringify(info?.entitlements?.pro), "billing_issues:", JSON.stringify(Object.values(info?.subscriptions ?? {}).map((x: any) => x.billing_issues_detected_at)));
    c.check("billing_issues_detected_at is set", Object.values(info?.subscriptions ?? {}).some((x: any) => x.billing_issues_detected_at), info?.subscriptions);
    // Recovery case and email.
    const cases = await until(async () => { const r = await w.dev.v2r("GET", "/payment_recovery/cases?environment=sandbox"); return r.body?.items?.length ? r.body : null; }, { timeoutMs: 20_000 });
    c.check("a payment recovery case is open for this subscription", !!cases?.items?.some((x: any) => x.status === "open"), cases);
    const mail = await until(async () => w.stack.mails.find((m) => m.to.includes(`fr-${stamp}@real-stripe.test`)), { timeoutMs: 90_000, everyMs: 2000 });
    c.check("the recovery email arrived by SMTP at the Stripe customer's address", !!mail, w.stack.mails.map((m) => m.to + " " + m.subject));
    if (mail) {
      const link = /https?:\/\/[^\s"'<>]+\/v1\/recovery\/l\/[^\s"'<>]+/.exec(mail.text + mail.html)?.[0]?.replace(/&amp;/g, "&");
      c.check("the email has a recovery link", !!link, mail.text.slice(0, 300));
      if (link) {
        const res = await fetch(link, { redirect: "manual" });
        const loc = res.headers.get("location") ?? "";
        console.log("   recovery link status", res.status, "->", loc.slice(0, 60), "…");
        c.check("the link opens a real Stripe customer portal or hosted invoice page", res.status >= 300 && res.status < 400 && /stripe\.com/.test(loc), { status: res.status, loc: loc.slice(0, 80) });
      }
    }
    // The customer fixes the card; Stripe's retry (or a manual pay) succeeds.
    const inv = (await S("GET", "/v1/invoices", { subscription: sub.id, status: "open" })).data[0];
    await S("POST", `/v1/payment_methods/pm_card_visa/attach`, { customer: cu.id }).then((pm) => S("POST", `/v1/invoices/${inv.id}/pay`, { payment_method: pm.id }));
    await until(async () => (await types(w, user)).includes("RENEWAL"), { timeoutMs: 30_000 });
    c.check("RENEWAL after the customer paid", (await types(w, user)).includes("RENEWAL"), { types: await types(w, user), notes: await notes(w) });
    const rec = await until(async () => { const r = await w.dev.v2r("GET", "/payment_recovery/cases?environment=sandbox"); return r.body?.items?.find((x: any) => x.status === "recovered") ?? null; }, { timeoutMs: 20_000 });
    c.check("the case is recovered", !!rec, (await w.dev.v2r("GET", "/payment_recovery/cases?environment=sandbox")).body);
    info = await ci(w, user);
    c.check("billing issue cleared", !Object.values(info?.subscriptions ?? {}).some((x: any) => x.billing_issues_detected_at), info?.subscriptions);
    await S("DELETE", `/v1/test_helpers/test_clocks/${clk.id}`);
  },

  async failedRenewalRunsOut(w) {
    c.begin("renewal fails and Stripe's retries run out");
    const user = `fo_user_${stamp}`;
    const clk = await clock("fo");
    const cu = await customer("fo", { clock: clk });
    const sub = await S("POST", "/v1/subscriptions", { customer: cu.id, items: [{ price: w.prices.monthly }], metadata: { app_user_id: user } });
    await receipt(w, user, sub.id);
    const bad = await S("POST", "/v1/payment_methods/pm_card_chargeCustomerFail/attach", { customer: cu.id });
    await S("POST", `/v1/customers/${cu.id}`, { invoice_settings: { default_payment_method: bad.id } });
    const t0 = clk.frozen_time as number;
    await advance(clk, t0 + 31 * DAY); await advance(clk, t0 + 31 * DAY + 2 * 3600);
    await until(async () => (await types(w, user)).includes("BILLING_ISSUE"), { timeoutMs: 30_000 });
    c.check("BILLING_ISSUE (insufficient funds)", (await types(w, user)).includes("BILLING_ISSUE"), { types: await types(w, user), notes: await notes(w) });
    for (const d of [4, 8, 12, 16, 20, 24, 28]) await advance(clk, t0 + (31 + d) * DAY).catch(() => null);
    const sNow = await S("GET", `/v1/subscriptions/${sub.id}`);
    console.log("   Stripe status after the retries:", sNow.status);
    await sleep(8000);
    console.log("   events:", await types(w, user), (await notes(w)).filter((n) => !/test_clock|customer\.updated|payment_method|setup_intent/.test(n)).join(" | "));
    console.log("   notification types processed:", JSON.stringify(await w.stack.sql`SELECT type, count(*)::int AS n, count(error)::int AS errors, count(processed_at)::int AS done FROM store_notifications WHERE project_id = ${w.dev.projectId} AND type IN ('customer.subscription.deleted','customer.subscription.updated') GROUP BY type`));
    console.log("   subscription rows:", JSON.stringify(await w.stack.sql`SELECT s.expires_date, s.billing_issues_detected_at, s.grace_period_expires_date, s.unsubscribe_detected_at FROM subscriptions s JOIN customers c ON c.id = s.customer_id WHERE c.original_app_user_id = ${user}`));
    // The test clock runs weeks ahead of this server's real clock, so the period end (a month away in real time) has not
    // passed here and EXPIRATION is rightly not due yet; what is provable is that Stripe's cancellation was read and the
    // customer's access never extends past the last paid period.
    const doneDeleted = await w.stack.sql`SELECT count(*)::int AS n FROM store_notifications WHERE project_id = ${w.dev.projectId} AND type = 'customer.subscription.deleted' AND subtype = ${sub.id} AND processed_at IS NOT NULL AND error IS NULL`;
    c.check("Stripe's final cancellation (customer.subscription.deleted) was processed without error", (doneDeleted[0] as any).n >= 1, doneDeleted);
    const infoEnd = await ci(w, user);
    c.check("access still ends at the last paid period, never later", new Date(infoEnd?.entitlements?.pro?.expires_date ?? 0).getTime() - Date.now() < 32 * DAY * 1000, infoEnd?.entitlements);
    c.check("no further RENEWAL was invented", !(await types(w, user)).includes("RENEWAL"), await types(w, user));
    const cases = await w.dev.v2r("GET", "/payment_recovery/cases?environment=sandbox");
    console.log("   cases:", JSON.stringify(cases.body?.items?.map((x: any) => ({ status: x.status, store: x.store }))));
    await S("DELETE", `/v1/test_helpers/test_clocks/${clk.id}`);
  },

  async checkout(w) {
    c.begin("Stripe Checkout (hosted page, paid in a real browser) posted as cs_ receipts");
    const user = `co_user_${stamp}`;
    const sess = await S("POST", "/v1/checkout/sessions", { mode: "subscription", line_items: [{ price: w.prices.monthly, quantity: 1 }], success_url: `${w.stack.base}/v1/health?s={CHECKOUT_SESSION_ID}`, cancel_url: `${w.stack.base}/v1/health?no=1`, metadata: { app_user_id: user }, customer_email: `co-${stamp}@real-stripe.test` });
    const open = await receipt(w, user, sess.id);
    c.check("an unpaid (open) session is 503 so the backend retries", open.status === 503, open);
    const paid = await payCheckout(sess.url, { email: `co-${stamp}@real-stripe.test`, expectUrl: /localhost:5710\/v1\/health/ });
    c.check("Checkout paid with 4242", /localhost:5710\/v1\/health/.test(paid.finalUrl), paid);
    const r = await receipt(w, user, sess.id);
    c.check("cs_ receipt is 200", r.status === 200, r);
    c.check("entitled to pro", !!(await ci(w, user))?.entitlements?.pro);
    const csObj = await S("GET", `/v1/checkout/sessions/${sess.id}`);
    c.eq("one INITIAL_PURCHASE for that subscription, whichever id the first webhook used", (await events(w)).filter((e) => e.type === "INITIAL_PURCHASE" && e.original_transaction_id === csObj.subscription).length, 1);
    c.eq("the webhook-first anonymous customer was merged into the session's app user (one SUBSCRIBER_ALIAS)", (await events(w, user, "SUBSCRIBER_ALIAS")).length, 1);
    console.log("   events:", await events(w).then((e) => e.map((x) => `${x.type}:${x.app_user_id}`)));
    // One-time payment mode.
    const user2 = `co1_user_${stamp}`;
    const one = await S("POST", "/v1/checkout/sessions", { mode: "payment", line_items: [{ price: w.prices.once, quantity: 1 }], success_url: `${w.stack.base}/v1/health`, cancel_url: `${w.stack.base}/v1/health?no=1`, metadata: { app_user_id: user2 }, customer_email: `co1-${stamp}@real-stripe.test` });
    const p2 = await payCheckout(one.url, { email: `co1-${stamp}@real-stripe.test`, expectUrl: /localhost:5710\/v1\/health/ });
    c.check("one-time Checkout paid", /localhost:5710\/v1\/health/.test(p2.finalUrl), p2);
    const r2 = await receipt(w, user2, one.id);
    c.check("one-time cs_ receipt is 200", r2.status === 200, r2);
    const info = await ci(w, user2);
    c.check("pro through the one-time purchase", !!info?.entitlements?.pro, info);
    c.check("NON_RENEWING_PURCHASE event at 4.99", (await events(w, user2, "NON_RENEWING_PURCHASE"))[0]?.price === 4.99, await types(w, user2));
    // Declined card at Checkout.
    const user3 = `co3_user_${stamp}`;
    const bad = await S("POST", "/v1/checkout/sessions", { mode: "subscription", line_items: [{ price: w.prices.monthly, quantity: 1 }], success_url: `${w.stack.base}/v1/health`, cancel_url: `${w.stack.base}/v1/health?no=1`, metadata: { app_user_id: user3 } });
    const p3 = await payCheckout(bad.url, { email: `co3-${stamp}@real-stripe.test`, card: "4000000000000002", expectUrl: /localhost:5710\/v1\/health/ });
    c.check("a declined card stays on Checkout with an error", !/localhost:5710\/v1\/health/.test(p3.finalUrl) && !!p3.error, p3);
    const r3 = await receipt(w, user3, bad.id);
    c.check("receipt for the never-paid session is 503 (still open)", r3.status === 503, r3);
    await S("POST", `/v1/checkout/sessions/${bad.id}/expire`);
    const r4 = await receipt(w, user3, bad.id);
    c.check("receipt for an expired session is 400", r4.status === 400, r4);
  },

  async webCheckout(w) {
    c.begin("web billing on the developer's Stripe: web products, discount, purchase link, hosted Checkout, redemption");
    const { dev } = w;
    const pro2 = await dev.v2("POST", "/entitlements", { lookup_key: "webpro", display_name: "Web pro" });
    await dev.v2("PUT", `/apps/${w.appId}/web_config`, { app_name: "Real Stripe App", support_email: "help@real-stripe.test", terms_url: "https://real-stripe.test/terms", privacy_url: "https://real-stripe.test/privacy", app_scheme: "realstripe", app_store_url: "https://apps.apple.com/app/id1" });
    const mkp = async (json: Record<string, unknown>) => (await dev.v2("POST", `/apps/${w.appId}/web_products`, json)).product;
    const monthly = await mkp({ display_name: "Web monthly", type: "subscription", price: { amount: 9.99, currency: "USD" }, duration: "P1M", trial_days: 7, entitlement_ids: [pro2.id] });
    const lifetime = await mkp({ display_name: "Web lifetime", type: "non_consumable", price: { amount: 49.0, currency: "USD" }, entitlement_ids: [pro2.id] });
    const sp = await S("GET", `/v1/prices/${monthly.store_identifier}`);
    c.has("the web product is a real Stripe price ($9.99 a month) in the developer's account", sp, { unit_amount: 999, currency: "usd", recurring: { interval: "month" } });
    const sl = await S("GET", `/v1/prices/${lifetime.store_identifier}`);
    c.has("the lifetime web product is a real one-time price ($49.00)", sl, { unit_amount: 4900 });
    const off = await dev.v2("POST", "/offerings", { lookup_key: "web", display_name: "Go Pro on the web" });
    for (const [lk, name, prod, pos] of [["$rc_monthly", "Monthly", monthly, 1], ["$rc_lifetime", "Lifetime", lifetime, 2]] as const) {
      const pk = await dev.v2("POST", `/offerings/${off.id}/packages`, { lookup_key: lk, display_name: name, position: pos });
      await dev.v2("POST", `/packages/${pk.id}/actions/attach_products`, { products: [{ product_id: prod.id, eligibility_criteria: "all" }] });
    }
    const disc = await dev.v2("POST", "/discounts", { identifier: "real_sale", customer_facing_name: "Real sale", type: "percentage", percentage: 20, duration_mode: "time_window", time_window: "P3M", eligibility: "everyone" });
    const dc = await dev.v2r("POST", `/discounts/${disc.id}/discount_codes`, { codes: [CODE] });
    c.check("adding a discount code works against real Stripe", dc.status === 201, dc);
    if (dc.status !== 201) return;
    const coupons = (await S("GET", "/v1/coupons", { limit: 20 })).data;
    c.check("the discount is a real Stripe coupon (20% for 3 months)", coupons.some((cp: any) => cp.percent_off === 20 && cp.duration === "repeating" && cp.duration_in_months === 3), coupons.map((x: any) => x.name));
    const promos = (await S("GET", "/v1/promotion_codes", { code: CODE })).data;
    c.check("and a real promotion code", promos.length === 1 && promos[0].active, promos.length);

    const link = await dev.v2("POST", "/purchase_links", { name: "Real sale", offering_id: off.id });
    const chromium = (createRequire(join(ROOT, "apps/dashboard/package.json"))("playwright") as typeof import("playwright")).chromium;
    const browser = await chromium.launch();
    const buyerEmail = `webbuyer-${stamp}@real-stripe.test`;
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
      await page.goto(`${link.url}?app_user_id=web_buyer_${stamp}&email=${encodeURIComponent(buyerEmail)}&code=${CODE}`);
      await page.getByRole("heading", { name: "Go Pro on the web" }).waitFor({ timeout: 15_000 });
      await page.getByRole("radio", { name: /Monthly/ }).click();
      const body = await page.locator("body").innerText();
      console.log("   purchase page mentions code:", /20% off/.test(body));
      await page.getByRole("button", { name: "Continue to payment" }).click();
      await page.waitForURL(/checkout\.stripe\.com/, { timeout: 30_000 });
      const sessionId = /cs_test_[A-Za-z0-9]+/.exec(page.url())?.[0] ?? "";
      const cs = await S("GET", `/v1/checkout/sessions/${sessionId}`, { expand: ["line_items", "total_details.breakdown"] });
      c.has("a real Checkout Session: subscription, the web price, 7 day trial", cs, { mode: "subscription", livemode: false });
      c.check("the session carries the price and the trial", cs.line_items?.data?.[0]?.price?.id === monthly.store_identifier, cs.line_items?.data?.[0]?.price?.id);
      await page.close();
      const paid = await payCheckout(cs.url, { email: buyerEmail, expectUrl: /localhost:5710\/pay\/.*success/ });
      c.check("paid on Stripe Checkout and sent to the success page", /\/success/.test(paid.finalUrl), paid);
      const done = await until(async () => (await events(w, `web_buyer_${stamp}`, "INITIAL_PURCHASE")).length > 0, { timeoutMs: 30_000 });
      c.check("INITIAL_PURCHASE recorded for the app user in the purchase link", done, { types: await types(w, `web_buyer_${stamp}`), notes: await notes(w) });
      await sleep(5000);
      c.eq("success page and webhooks together recorded it once", (await events(w, `web_buyer_${stamp}`, "INITIAL_PURCHASE")).length, 1);
      const info = await ci(w, `web_buyer_${stamp}`);
      c.check("entitled to webpro", !!info?.entitlements?.webpro, info?.entitlements);
      c.has("event: Stripe, trial, web offering", (await events(w, `web_buyer_${stamp}`, "INITIAL_PURCHASE"))[0], { store: "STRIPE", period_type: "TRIAL", presented_offering_id: "web" });
      const disc2 = await S("GET", `/v1/checkout/sessions/${sessionId}`, { expand: ["total_details.breakdown"] });
      console.log("   discounts on the session:", JSON.stringify(disc2.total_details?.breakdown?.discounts?.map((d: any) => d.discount?.coupon?.percent_off)));
      const mail = await until(async () => w.stack.mails.find((m) => m.to.includes(buyerEmail)), { timeoutMs: 20_000 });
      c.check("the redemption email reached the buyer", !!mail, w.stack.mails.map((m) => m.to + m.subject));
      const dlist = await dev.v2("GET", "/web_discounts");
      c.check("the discount counts the redemption", dlist.items?.[0]?.times_redeemed >= 1, dlist.items?.[0]);

      // The SDK's hosted checkout (the iOS paywall's web purchase).
      const hcUser = `hc_user_${stamp}`;
      const hc = await fetch(`${w.stack.base}/rcbilling/v1/hosted-checkout`, { method: "POST", headers: { authorization: `Bearer ${w.pub}`, "content-type": "application/json", "x-platform": "ios" }, body: JSON.stringify({ app_user_id: hcUser, presented_offering_identifier: "web", package_id: "$rc_lifetime" }) });
      const hcb: any = await hc.json();
      c.check("the paywall's hosted checkout answers a real Stripe Checkout URL", hc.status === 200 && /checkout\.stripe\.com/.test(hcb.checkout_url ?? ""), hcb);
      const p2 = await payCheckout(hcb.checkout_url, { email: `hc-${stamp}@real-stripe.test`, expectUrl: /localhost:5710\/pay\/.*success/ });
      c.check("lifetime paid", /\/success/.test(p2.finalUrl), p2);
      const hcDone = await until(async () => !!(await ci(w, hcUser))?.entitlements?.webpro, { timeoutMs: 30_000 });
      c.check("the iOS app user has the entitlement at once", hcDone, await types(w, hcUser));
      c.check("NON_RENEWING_PURCHASE at $49 for that user", (await events(w, hcUser, "NON_RENEWING_PURCHASE"))[0]?.price === 49, await types(w, hcUser));
    } finally { await browser.close(); }
  },

  async ui(w) {
    c.begin("dashboard pages in a real browser, with the real Stripe data (desktop and phone width)");
    const chromium = (createRequire(join(ROOT, "apps/dashboard/package.json"))("playwright") as typeof import("playwright")).chromium;
    const browser = await chromium.launch();
    const errors: string[] = [];
    const shots = join(ROOT, "scripts/e2e/real-stripe/build");
    try {
      for (const [label, viewport] of [["desktop", { width: 1440, height: 1000 }], ["phone", { width: 390, height: 844 }]] as const) {
        const ctx = await browser.newContext({ viewport });
        await ctx.addCookies([{ name: "rd_session", value: w.dev.cookie.split("=")[1]!, url: w.stack.base }]);
        const page = await ctx.newPage();
        page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(`${label}: ${m.text()}`); });
        page.on("pageerror", (e) => errors.push(`${label}: ${e}`));
        const P = `${w.stack.base}/projects/${w.dev.projectId}`;
        const visit = async (path: string, mustHave: RegExp, name: string) => {
          await page.goto(`${P}${path}`, { waitUntil: "networkidle" }).catch(() => {});
          const ok = await page.getByText(mustHave).first().waitFor({ timeout: 20_000 }).then(() => true, () => false);
          c.check(`${label}: ${name}`, ok, (await page.locator("body").innerText()).slice(0, 200));
          await page.screenshot({ path: join(shots, `ui-${label}-${name.replace(/\W+/g, "-")}.png`), fullPage: true });
        };
        await visit(`/apps/${w.appId}`, /Webhook|Signing secret|webhook/i, "Stripe app page shows its webhook");
        const appText = await page.locator("body").innerText();
        c.check(`${label}: the app page shows the webhook URL and no secret key`, /\/v1\/notifications\/stripe\//.test(appText) && !/sk_test_[A-Za-z0-9]{20}/.test(appText), appText.slice(0, 200));
        await visit(`/customers/${encodeURIComponent(`sub_user_${stamp}`)}`, /pro/i, "customer detail of a Stripe subscriber");
        await visit(`/customers/${encodeURIComponent(`renew_user_${stamp}`)}`, /Renewal|renewal/i, "customer timeline shows the renewal");
        await visit(`/lifecycle/payment-recovery`, /Payment recovery/i, "payment recovery page");
        await visit(`/web`, /Stripe|web/i, "Web page");
        await visit(`/web-discounts`, /Real sale|REAL20/i, "web discounts page lists the discount");
        await visit(`/product-catalog/products`, /Pro monthly|Web monthly|price_/i, "products page");
        await visit(`/overview`, /Revenue|MRR/i, "overview");
        await ctx.close();
      }
    } finally { await browser.close(); }
    c.check("no browser console or page errors", errors.length === 0, errors.slice(0, 5));
  },
};

async function main() {
  const only = process.argv.slice(2);
  const w = await setup();
  const fwd = forward(key, `${w.stack.base}/v1/notifications/stripe/${w.appId}`);
  try {
    await fwd.ready;
    for (const [name, fn] of Object.entries(scenarios)) {
      if (only.length && !only.includes(name)) continue;
      try { await fn(w); } catch (e) { c.check(`${name} ran to the end`, false, String(e).slice(0, 500)); }
    }
  } finally {
    fwd.stop();
    console.log("   Stripe sandbox cleaned:", await cleanupStripe(S, startedAt));
    if (!process.env.KEEP_DB) await w.stack.stop();
  }
  console.log(`\n${c.passed} passed, ${c.failed} failed`);
  process.exit(c.failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
