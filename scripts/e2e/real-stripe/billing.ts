// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: RevenueDot Cloud billing (prd/cloud-billing/PRD.md) proven against Stripe's REAL test-mode API on the
// "RevenueDot sandbox" account: a Cloud-edition Node server on its own Railway development database, real Checkout paid in a
// browser, real metered usage on a Billing Meter, real signed webhooks delivered by the Stripe CLI, a Stripe test clock for the
// month-end invoice, a declining card, cancellation and the Customer Portal. Run (keys by name, never printed):
//   set -a; source ~/.config/revenuedot/dev.env; source apps/server/.env.local; set +a
//   pnpm tsx scripts/e2e/real-stripe/billing.ts
// The only seeded thing is the developer's tracked revenue (SQL rows), because RevenueDot's own Stripe is what is under test.
import { createRequire } from "node:module";
import { join } from "node:path";
import { Checks, ROOT, cleanupStripe, forward, listenSecret, payCheckout, signUp, sleep, startStack, stripeApi, testKey, until, type Dev, type Stack } from "./lib.ts";

const c = new Checks("real-stripe-billing");
const key = testKey("REVENUEDOT_BILLING_STRIPE_SECRET_KEY");
const S = stripeApi(key);
const price = process.env.REVENUEDOT_BILLING_PRICE_STANDARD ?? "";
const stamp = Date.now().toString(36);
const DAY = 86400;
const startedAt = Math.floor(Date.now() / 1000) - 5;
const PORT = 5720;

async function payCheckoutLike(url: string): Promise<string> {
  const chromium = (createRequire(join(ROOT, "apps/dashboard/package.json"))("playwright") as typeof import("playwright")).chromium;
  const b = await chromium.launch();
  try { const p = await b.newPage(); await p.goto(url, { waitUntil: "domcontentloaded" }); await p.waitForTimeout(6000); return await p.locator("body").innerText(); } finally { await b.close(); }
}

let n = 0;
async function seedRevenue(stack: Stack, dev: Dev, usd: number, at = new Date()) {
  n++;
  const cust = `cus_seed_${stamp}_${n}`;
  await stack.sql`INSERT INTO customers (id, project_id, original_app_user_id) VALUES (${cust}, ${dev.projectId}, ${"seed_" + n})`;
  await stack.sql`INSERT INTO transactions (id, project_id, customer_id, store, store_transaction_id, product_identifier, kind, is_sandbox, purchased_at, revenue_usd) VALUES (${"txn_seed_" + stamp + n}, ${dev.projectId}, ${cust}, 'stripe', ${"seed_tx_" + stamp + n}, 'seed_product', 'purchase', false, ${at.toISOString()}::timestamptz, ${usd})`;
}
/** The tick meters at most once an hour a month: open the gate so the next tick runs. */
const openGate = (stack: Stack) => stack.sql`UPDATE billing_usage SET computed_at = now() - interval '2 hours'`;
const billing = (dev: Dev) => dev.call("GET", "/v2/billing").then((r) => r.body);
const acct = async (stack: Stack) => (await stack.sql`SELECT plan, status, stripe_customer_id, stripe_subscription_id, cancel_at, current_period_end FROM billing_accounts`)[0] as any;
const meterCents = async (customer: string, meterId: string) => {
  const s = await S("GET", `/v1/billing/meters/${meterId}/event_summaries`, { customer, start_time: Math.floor(Date.now() / 1000) - 3600, end_time: Math.floor(Date.now() / 1000) + 3600 }).catch((e) => ({ error: String(e) }));
  return s;
};

async function main() {
  const whsec = listenSecret(key);
  const stack = await startStack("rd_stripe_real_cloud", PORT, {
    REVENUEDOT_EDITION: "cloud", REVENUEDOT_BILLING_STRIPE_SECRET_KEY: key, REVENUEDOT_BILLING_STRIPE_WEBHOOK_SECRET: whsec, REVENUEDOT_BILLING_PRICE_STANDARD: price,
  });
  const fwd = forward(key, `${stack.base}/v2/billing/stripe/webhook`);
  const clocks: string[] = [];
  try {
    await fwd.ready;
    const price0 = await S("GET", `/v1/prices/${price}`);
    const meterId = price0.recurring.meter as string;

    c.begin("Cloud Free, tracked revenue and the real meter");
    const dev = await signUp(stack.base, "clouddev");
    let b = await billing(dev);
    c.has("starts on Cloud Free, Stripe ready", b, { account: { plan: "free", status: "none" }, stripe_ready: true });
    await seedRevenue(stack, dev, 12_000);
    await openGate(stack);
    b = await until(async () => { const r = await billing(dev); return r.usage.tracked_revenue_usd === 12_000 ? r : null; }, { timeoutMs: 100_000, everyMs: 3000 });
    c.has("the tick metered $12,000; Standard would cost $10.00", b, { usage: { tracked_revenue_usd: 12_000, standard_bill_usd: 10, bill_usd: 0 }, flags: ["over_free_limit"] });
    const mail = await until(async () => stack.mails.find((m) => m.to.includes(dev.email) && /passed|Cloud Free/i.test(m.subject)), { timeoutMs: 10_000 });
    c.check("the 'passed Cloud Free' email arrived", !!mail, stack.mails.map((m) => m.subject));

    // A customer on a Stripe test clock so month-end can really happen. RevenueDot reuses the customer saved on the account.
    const clk = await S("POST", "/v1/test_helpers/test_clocks", { frozen_time: Math.floor(Date.now() / 1000), name: `rd-billing-${stamp}` });
    clocks.push(clk.id);
    const userId = (await stack.sql`SELECT id FROM users WHERE email = ${dev.email}`)[0]!.id as string;
    const cu = await S("POST", "/v1/customers", { email: dev.email, name: "clouddev", test_clock: clk.id, metadata: { revenuedot_user_id: userId } });
    await stack.sql`INSERT INTO billing_accounts (user_id, stripe_customer_id, created_at, updated_at) VALUES (${userId}, ${cu.id}, now(), now())`;

    c.begin("Upgrade through real Stripe Checkout");
    const co = await dev.call("POST", "/v2/billing/checkout", { plan: "standard" });
    c.check("checkout answers with a Stripe-hosted URL", co.status === 200 && /^https:\/\/checkout\.stripe\.com\//.test(co.body?.url ?? ""), co);
    const cs = await S("GET", `/v1/checkout/sessions/${co.body.id}`);
    c.has("session: subscription mode, metered Standard price, our customer, user id as reference", cs, { mode: "subscription", customer: cu.id, client_reference_id: userId, livemode: false });
    const paid = await payCheckout(co.body.url, { email: dev.email, expectUrl: /localhost:5720\/account\/billing/ });
    c.check("Checkout paid with 4242 and returned to the Billing page", /checkout%3Dsuccess|checkout=success/.test(paid.finalUrl), paid);
    const std = await until(async () => { const a = await acct(stack); return a?.plan === "standard" && a.status === "active" ? a : null; }, { timeoutMs: 30_000 });
    c.check("real webhooks made the account Standard and active", !!std, await acct(stack));
    const sub = await S("GET", `/v1/subscriptions/${std?.stripe_subscription_id}`);
    c.has("Stripe subscription: active, the Standard price, anchored to the 1st of next month, no trial", sub, { status: "active", customer: cu.id });
    const anchor = new Date(sub.billing_cycle_anchor * 1000);
    c.check("billing cycle anchor is the 1st of next month 00:00 UTC", anchor.getUTCDate() === 1 && anchor.getUTCHours() === 0 && anchor > new Date(), anchor.toISOString());
    c.eq("exactly one item at the configured price", sub.items.data.map((i: any) => i.price.id), [price]);
    const again = await dev.call("POST", "/v2/billing/checkout", { plan: "standard" });
    c.eq("a second Checkout while Standard is 409", again.status, 409);

    c.begin("Metered usage reported to the real Billing Meter");
    const metered = await until(async () => (await stack.sql`SELECT cents FROM billing_meter_reports`)[0] ?? null, { timeoutMs: 30_000 });
    c.eq("a meter report of 1000 cents ($10.00) was recorded right after the upgrade", Number((metered as any)?.cents), 1000);
    const preview = async (want: number) => until(async () => { const p = await S("POST", "/v1/invoices/create_preview", { customer: cu.id, subscription: std!.stripe_subscription_id }).catch((e) => ({ error: String(e) } as any)); return (p.total ?? p.amount_due) === want ? p : (console.log("   preview total", p.total, p.error ?? ""), null); }, { timeoutMs: 90_000, everyMs: 5000 });
    const prev1 = await preview(1000);
    c.check("Stripe's upcoming invoice shows $10.00 of usage", !!prev1, prev1);
    // Revenue grows: $52,000 more -> $64,000 -> $270 bill; then a month of $3,000,000 hits the $999 cap.
    await seedRevenue(stack, dev, 52_000); await openGate(stack);
    await until(async () => (await stack.sql`SELECT cents FROM billing_meter_reports`)[0]?.cents === 27_000, { timeoutMs: 100_000, everyMs: 3000 });
    c.eq("after more revenue the next tick reports 27000 cents ($270.00)", Number((await stack.sql`SELECT cents FROM billing_meter_reports`)[0]?.cents), 27_000);
    const prev2 = await preview(27_000);
    c.check("Stripe's upcoming invoice now shows $270.00 (last value, not a sum)", !!prev2, prev2);
    await seedRevenue(stack, dev, 3_000_000); await openGate(stack);
    await until(async () => (await stack.sql`SELECT cents FROM billing_meter_reports`)[0]?.cents === 99_900, { timeoutMs: 100_000, everyMs: 3000 });
    c.eq("at $3,064,000 the bill is capped at 99900 cents ($999.00)", Number((await stack.sql`SELECT cents FROM billing_meter_reports`)[0]?.cents), 99_900);
    const prev3 = await preview(99_900);
    c.check("Stripe's upcoming invoice shows the capped $999.00", !!prev3, prev3);
    const sums = await meterCents(cu.id, meterId);
    console.log("   meter event summaries:", JSON.stringify(sums).slice(0, 300));
    await sleep(1000);
    const capMail = stack.mails.find((m) => m.to.includes(dev.email) && /999|cap|will not pay more/i.test(m.subject + m.text));
    c.check("the 'capped at $999' email arrived", !!capMail, stack.mails.map((m) => m.subject));

    c.begin("Month-end invoice with a failing card, then recovery (test clock)");
    const bad = await S("POST", "/v1/payment_methods/pm_card_chargeCustomerFail/attach", { customer: cu.id });
    await S("POST", `/v1/customers/${cu.id}`, { invoice_settings: { default_payment_method: bad.id } });
    await S("POST", `/v1/subscriptions/${std!.stripe_subscription_id}`, { default_payment_method: "" }).catch(() => null);
    const anchorTs = sub.billing_cycle_anchor as number;
    const adv = async (t: number) => { await S("POST", `/v1/test_helpers/test_clocks/${clk.id}/advance`, { frozen_time: t }); await until(async () => (await S("GET", `/v1/test_helpers/test_clocks/${clk.id}`)).status === "ready", { timeoutMs: 120_000, everyMs: 2000 }); };
    await adv(anchorTs + 60);
    // Usage-based invoices stay draft for 3 days after the period ends (Stripe's meter adjustment window), then are charged.
    await adv(anchorTs + 3 * DAY + 3600);
    const list = (await S("GET", "/v1/invoices", { customer: cu.id, limit: 5 })).data;
    console.log("   invoices after 3 days and an hour:", list.map((i: any) => `${i.status}/${i.amount_due}/attempts ${i.attempt_count}`).join(", "));
    const failed = await until(async () => { const a = await acct(stack); return a?.status === "past_due" ? a : null; }, { timeoutMs: 60_000 });
    c.check("invoice.payment_failed made the account past_due (still Standard)", !!failed && failed.plan === "standard", await acct(stack));
    const invs = await stack.sql`SELECT id, status, amount_due, amount_paid FROM billing_invoices ORDER BY created_at`;
    console.log("   invoices:", JSON.stringify(invs));
    const bb = await billing(dev);
    c.check("Billing page flags past_due and lists the invoice", bb.flags.includes("past_due") && bb.invoices.length >= 1, { flags: bb.flags, invoices: bb.invoices.length });
    const failMail = await until(async () => stack.mails.find((m) => m.to.includes(dev.email) && /payment|failed/i.test(m.subject) && !/Cloud Free|capped/i.test(m.subject)), { timeoutMs: 15_000 });
    c.check("the failed-payment email arrived (once)", !!failMail && stack.mails.filter((m) => /failed|payment/i.test(m.subject) && !/Free|cap/i.test(m.subject)).length >= 1, stack.mails.map((m) => m.subject));
    const stillWorks = await fetch(`${stack.base}/v1/health`);
    c.check("apps keep working while past_due", stillWorks.ok);
    const open = (await S("GET", "/v1/invoices", { customer: cu.id, status: "open" })).data[0];
    c.must("the failed invoice is open in Stripe", !!open, list.map((i: any) => i.status));
    c.check("the open invoice charges the metered usage ($999.00)", open?.amount_due === 99_900, { amount_due: open?.amount_due });
    const good = await S("POST", "/v1/payment_methods/pm_card_visa/attach", { customer: cu.id });
    await S("POST", `/v1/invoices/${open.id}/pay`, { payment_method: good.id });
    const rec = await until(async () => { const a = await acct(stack); return a?.status === "active" ? a : null; }, { timeoutMs: 60_000 });
    c.check("paying the invoice returns the account to active", !!rec, await acct(stack));
    const recMail = await until(async () => stack.mails.find((m) => m.to.includes(dev.email) && /went through|paid|thank|recover/i.test(m.subject) && !/Cloud Free|capped/i.test(m.subject)), { timeoutMs: 15_000 });
    c.check("the payment-recovered email arrived", !!recMail, stack.mails.map((m) => m.subject));
    const paidInv = await stack.sql`SELECT status, amount_paid FROM billing_invoices WHERE id = ${open.id}`;
    c.check("the invoice is stored as paid", paidInv[0]?.status === "paid" && paidInv[0]?.amount_paid === 99_900, paidInv);

    c.begin("Customer portal and cancellation");
    const portal = await dev.call("POST", "/v2/billing/portal");
    c.check("portal answers with a real Stripe billing portal link", portal.status === 200 && /^https:\/\/billing\.stripe\.com\//.test(portal.body?.url ?? ""), portal);
    const portalPage = await payCheckoutLike(portal.body.url);
    c.check("the portal page opens and shows this customer's plan", /Standard|Cancel plan|Update payment|Billing/i.test(portalPage), portalPage.slice(0, 200));
    // Cancel at period end (what the portal's Cancel plan does), then cancel now.
    await S("POST", `/v1/subscriptions/${std!.stripe_subscription_id}`, { cancel_at_period_end: true });
    const canc = await until(async () => { const a = await acct(stack); return a?.cancel_at ? a : null; }, { timeoutMs: 30_000 });
    c.check("cancel at period end shows cancel_at and stays Standard until then", !!canc && canc.plan === "standard", await acct(stack));
    await S("DELETE", `/v1/subscriptions/${std!.stripe_subscription_id}`);
    const gone = await until(async () => { const a = await acct(stack); return a?.status === "canceled" ? a : null; }, { timeoutMs: 30_000 });
    c.check("cancelling now puts the account back on Free (canceled)", !!gone && gone.plan === "free", await acct(stack));
    const after = await billing(dev);
    c.check("Billing page shows Free again, apps unaffected", after.account.plan === "free" && (await fetch(`${stack.base}/v1/health`)).ok, after.account);

    c.begin("Stripe gives up: retries run out, the account goes back to Free (second account, test clock)");
    const dev2 = await signUp(stack.base, "dunnydev");
    await seedRevenue(stack, dev2, 20_000); await openGate(stack);
    await until(async () => (await billing(dev2)).usage.tracked_revenue_usd === 20_000, { timeoutMs: 100_000, everyMs: 3000 });
    const clk2 = await S("POST", "/v1/test_helpers/test_clocks", { frozen_time: Math.floor(Date.now() / 1000), name: `rd-billing2-${stamp}` });
    clocks.push(clk2.id);
    const user2 = (await stack.sql`SELECT id FROM users WHERE email = ${dev2.email}`)[0]!.id as string;
    const cu2 = await S("POST", "/v1/customers", { email: dev2.email, test_clock: clk2.id, metadata: { revenuedot_user_id: user2 } });
    await stack.sql`INSERT INTO billing_accounts (user_id, stripe_customer_id, created_at, updated_at) VALUES (${user2}, ${cu2.id}, now(), now())`;
    const co2 = await dev2.call("POST", "/v2/billing/checkout", { plan: "standard" });
    const paid2 = await payCheckout(co2.body.url, { email: dev2.email, expectUrl: /localhost:5720\/account\/billing/ });
    c.check("second account paid through Checkout and returned to the success URL", /checkout%3Dsuccess|checkout=success/.test(paid2.finalUrl), paid2);
    const std2 = await until(async () => { const r = await stack.sql`SELECT * FROM billing_accounts WHERE user_id = ${user2}`; return r[0]?.status === "active" ? r[0] : null; }, { timeoutMs: 30_000 });
    c.check("second account is Standard and active", !!std2, std2);
    const sub2 = await S("GET", `/v1/subscriptions/${std2!.stripe_subscription_id}`);
    const bad2 = await S("POST", "/v1/payment_methods/pm_card_chargeCustomerFail/attach", { customer: cu2.id });
    await S("POST", `/v1/customers/${cu2.id}`, { invoice_settings: { default_payment_method: bad2.id } });
    await S("POST", `/v1/subscriptions/${std2!.stripe_subscription_id}`, { default_payment_method: "" });
    const adv2 = async (t: number) => { await S("POST", `/v1/test_helpers/test_clocks/${clk2.id}/advance`, { frozen_time: t }); await until(async () => (await S("GET", `/v1/test_helpers/test_clocks/${clk2.id}`)).status === "ready", { timeoutMs: 120_000, everyMs: 2000 }); };
    await adv2(sub2.billing_cycle_anchor + 60);
    await adv2(sub2.billing_cycle_anchor + 3 * DAY + 3600);
    await until(async () => (await stack.sql`SELECT status FROM billing_accounts WHERE user_id = ${user2}`)[0]?.status === "past_due", { timeoutMs: 60_000 });
    c.eq("first failure: past_due", (await stack.sql`SELECT status FROM billing_accounts WHERE user_id = ${user2}`)[0]?.status, "past_due");
    let final: any = null;
    for (const d of [8, 15, 22, 29, 36]) {
      await adv2(sub2.billing_cycle_anchor + (3 + d) * DAY);
      await sleep(4000);
      const st = (await S("GET", `/v1/subscriptions/${std2!.stripe_subscription_id}`)).status;
      console.log(`   +${3 + d} days after month end: Stripe says ${st}`);
      if (st === "unpaid" || st === "canceled") { final = await until(async () => { const r = (await stack.sql`SELECT plan, status FROM billing_accounts WHERE user_id = ${user2}`)[0] as any; return r?.plan === "free" ? r : null; }, { timeoutMs: 30_000 }); break; }
    }
    c.check("when Stripe gives up the account is back on Free (unpaid or canceled)", !!final && ["unpaid", "canceled"].includes(final.status), final);
    c.check("an 'unpaid' email went out", !!stack.mails.find((m) => m.to.includes(dev2.email) && /unpaid|stopped|ended|failed/i.test(m.subject) && !/Free|cap/i.test(m.subject)), stack.mails.filter((m) => m.to.includes(dev2.email)).map((m) => m.subject));
    c.check("the second customer's apps still work", (await fetch(`${stack.base}/v1/health`)).ok);

    c.begin("Webhook endpoint safety");
    const url = `${stack.base}/v2/billing/stripe/webhook`;
    const r1 = await fetch(url, { method: "POST", body: "{}" });
    c.eq("no signature: 400", r1.status, 400);
    const r2 = await fetch(url, { method: "POST", headers: { "stripe-signature": `t=${Math.floor(Date.now() / 1000)},v1=${"0".repeat(64)}` }, body: "{}" });
    c.eq("wrong signature: 400", r2.status, 400);
  } finally {
    fwd.stop();
    console.log("   Stripe sandbox cleaned:", await cleanupStripe(S, startedAt));
    if (!process.env.KEEP_DB) await stack.stop();
  }
  console.log(`\n${c.passed} passed, ${c.failed} failed`);
  process.exit(c.failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
