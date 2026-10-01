// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: journey (g), the Lifecycle tools a developer and their customers use (prd/lifecycle/PRD.md):
//   1. Refund Control: policies from the four templates, reorder, default, customer consent, customer counts per policy;
//      Apple's CONSUMPTION_REQUEST. The real server trusts only Apple's root certificate for App Store notifications, so a
//      forged one is refused. The developer's own Xcode StoreKit test certificate is a supported entry point: Xcode-signed
//      CONSUMPTION_REQUEST, REFUND and REFUND_DECLINED notifications run policy evaluation, consent and outcomes for real,
//      but the Xcode environment has no App Store Server API, so Send Consumption Information (the PUT to Apple) needs an
//      Apple-signed notification and is covered by apps/server/test/refund-control.test.ts. Cards and stats on Test Store
//      refunds (test_purchases scenario refund).
//   2. Retention: Customer Center cancel and refund offers in the SDK's config (GET /v1/customercenter/{id}); Apple
//      Retention Messaging messages, defaults and rules saved; "Sync to Apple" (Apple's hosts are blocked in journeys);
//      Apple's real-time endpoint refuses unsigned, forged and Xcode-signed requests.
//   3. Win-back: production churned subscribers come from Amazon Appstore purchases through the SDK's receipt call, with
//      Amazon's Receipt Verification Service answered locally (as in integrations.ts); Test Store customers are sandbox, and
//      win-back emails production subscribers only. The tick sends at the campaign's UTC hour; the email arrives over SMTP;
//      open pixel, tracked click and one-click unsubscribe; once per customer; a second campaign skips the unsubscribed
//      address; a reactivation within 30 days shows in the stats.
//   4. Support: the iOS SDK's create-ticket call stores, emails (SMTP) and rate-limits tickets; the v2 ticket list; the help
//      desk summary by app user id and by email.
//   5. Customer lists: built-in lists, a saved audience, filters, search, the summary cards and the CSV export.
import { randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { Journey } from "./run.ts";
import { sleep, until } from "./lib/check.ts";
import { type Ctx, type Dev, sdkClient, signUp, standardCatalog } from "./lib/context.ts";
import { type Captured, type Mail, linksOf } from "./lib/stack.ts";
import { makeP8, makePki, makeXcodePki, signJws, transaction, type Pki } from "../../../apps/server/test/apple-fixtures.ts";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const BUNDLE = "com.example.scanner";
const APPLE_ID = "1234567890";
const rnd = (n = 12) => randomBytes(n).toString("hex").slice(0, n);
const rawHeader = (m: Mail, name: string) => new RegExp(`^${name}:\\s*(.*(?:\\r?\\n[ \\t].*)*)`, "im").exec(m.raw.split(/\r?\n\r?\n/)[0] ?? "")?.[1]?.replace(/\r?\n[ \t]+/g, " ").trim() ?? null;
const round2 = (n: number) => Math.round(n * 100) / 100;

const journey: Journey = {
  name: "lifecycle-tools",
  title: "Lifecycle tools: Refund Control, Retention, Win-back (SMTP, clicks, unsubscribe, reactivation), Support tickets, Customer lists and CSV",
  async run(ctx: Ctx) {
    const xcode = await makeXcodePki();
    const appR = await refundControl(ctx, xcode);
    await retention(ctx, appR, xcode);
    await support(ctx, appR);
    const w = await winback(ctx);
    await customerLists(ctx, w);

    const { c } = ctx;
    c.begin("Apple and Google Play were never called");
    // The tick checks a new app's store credentials once (then hourly while failing): wait for that check of the App Store
    // app, so its blocked call to Apple happens inside this journey.
    const checked = await until(async () => (await ctx.sql`SELECT credentials_checked_at FROM apps WHERE id = ${appR.appleAppId}`)[0]?.credentials_checked_at, { timeoutMs: 70_000, everyMs: 1000 });
    c.check("the server's credential check of the App Store key ran (its call to Apple was blocked)", checked && ctx.server.outbound().some((o) => o.host === "api.storekit.itunes.apple.com" && o.routed === "blocked"), ctx.server.outbound().filter((o) => o.host.endsWith("apple.com")));
    const store = ctx.server.outbound().filter((o) => /(^|\.)apple\.com$|googleapis\.com$/.test(o.host) && !/^oauth2\./.test(o.host));
    c.check("every outbound call to an Apple or Google Play host was blocked by the journey (none reached the internet)", store.every((o) => o.routed === "blocked"), store.filter((o) => o.routed !== "blocked"));
    c.check("no Send Consumption Information call was attempted (it needs an Apple-signed notification)", !ctx.server.outbound().some((o) => o.path.includes("/inApps/v1/transactions/consumption/")), store.map((o) => o.path));
  },
};
export default journey;

// ---------------------------------------------------------------------------------------------------------------------
// 1. Refund Control
// ---------------------------------------------------------------------------------------------------------------------

interface RefundProject { dev: Dev; appleAppId: string; testKey: string; iosKey: string; S: string; ids: Record<string, string> }

async function refundControl(ctx: Ctx, xcode: Pki): Promise<RefundProject> {
  const { c, sql } = ctx;
  const S = ctx.stamp;
  const u = (n: string) => `${n}_${S}`;
  const dev = await signUp(ctx, "lctools", "Scanner Pro");
  const cat = await standardCatalog(dev);
  const weekly = await dev.v2("POST", "/products", { store_identifier: "pro_weekly", app_id: cat.app.id, type: "subscription", display_name: "pro_weekly", subscription: { duration: "P1W" }, test_store_price: { amount_micros: 2_990_000, currency: "USD" } });
  await dev.v2("POST", `/entitlements/${cat.pro.id}/actions/attach_products`, { product_ids: [weekly.id] });
  const sdk = sdkClient(ctx, cat.testKey);
  const android = { "x-platform": "android", "x-platform-flavor": "native", "x-version": "8.10.0" };

  c.begin("Refund Control: an App Store app with its In-App Purchase key and the developer's Xcode StoreKit certificate");
  const ios = await dev.v2("POST", "/apps", {
    name: "Scanner iOS", type: "app_store",
    app_store: { bundle_id: BUNDLE, key_id: "JOURNEYKEY", issuer_id: "57246542-96fe-1a63-e053-0824d011072a", private_key: await makeP8(), app_apple_id: APPLE_ID, xcode_certificate: xcode.rootPem },
  });
  const iosKey = (await dev.v2("GET", `/apps/${ios.id}/public_api_keys`)).items[0].key as string;
  for (const [sid, type, dur] of [["pro_monthly", "subscription", "P1M"], ["lifetime", "non_consumable", null]] as const) {
    const p = await dev.v2("POST", "/products", { store_identifier: sid, app_id: ios.id, type, display_name: `${sid} (App Store)`, ...(dur ? { subscription: { duration: dur } } : {}) });
    await dev.v2("POST", `/entitlements/${cat.pro.id}/actions/attach_products`, { product_ids: [p.id] });
  }
  c.check("App Store app created (appl_ key)", ios.type === "app_store" && /^appl_/.test(iosKey), { type: ios.type, key: iosKey.slice(0, 5) });

  c.begin("Refund Control: customers with recent renewals, new purchases, iPhones, a VIP attribute and the rest");
  const tp = async (user: string, product: string, scenario: string, offset_days?: number) => {
    const r = await dev.v2r("POST", "/test_purchases", { app_user_id: user, product_id: product, scenario, ...(offset_days !== undefined ? { offset_days } : {}) });
    c.check(`${user.replace(`_${S}`, "")}: ${scenario} of ${product} accepted`, r.status === 201, r.body);
    return r.body;
  };
  // Weekly renewal 2 hours ago (iPhone) and a trial converted to paid about 2.4 hours ago (Android).
  await tp(u("rr_renewed"), "pro_weekly", "renewal", 7 + 2 / 24);
  await sdk.customerInfo(u("rr_renewed"));
  await tp(u("rr_converted"), "pro_weekly", "trial_conversion", 7.1);
  await sdk.call("GET", `/v1/subscribers/${u("rr_converted")}`, undefined, android);
  await tp(u("rr_new"), "pro_monthly", "purchase", 2);
  await sdk.call("GET", `/v1/subscribers/${u("rr_new")}`, undefined, android);
  await tp(u("rr_iphone"), "pro_annual", "purchase", 30);
  await sdk.customerInfo(u("rr_iphone"));
  await sdk.attributes(u("rr_iphone"), { $email: `Iphone-${S}@Example.org`, $displayName: "Robin" });
  await tp(u("rr_vip"), "pro_annual", "purchase", 30);
  await sdk.call("GET", `/v1/subscribers/${u("rr_vip")}`, undefined, android);
  await sdk.call("POST", `/v1/subscribers/${u("rr_vip")}/attributes`, { attributes: { vip: { value: "true", updated_at_ms: Date.now() } } }, android);
  await tp(u("rr_other"), "pro_annual", "purchase", 30);
  await sdk.call("GET", `/v1/subscribers/${u("rr_other")}`, undefined, android);
  const renewedTx = await sql`SELECT t.kind, t.purchased_at FROM transactions t JOIN customers cu ON cu.id = t.customer_id WHERE cu.project_id = ${dev.projectId} AND cu.original_app_user_id IN (${u("rr_renewed")}, ${u("rr_converted")}) AND t.kind = 'renewal'`;
  c.check("the ledger has a renewal within the last 24 hours for the renewed and the converted customer", renewedTx.length === 2 && renewedTx.every((r) => Date.now() - new Date(r.purchased_at).getTime() < 24 * HOUR), renewedTx);

  // An iPhone customer buys in the app run from Xcode (StoreKit testing): the SDK posts the Xcode-signed transactions.
  const xcUser = u("xc_buyer");
  const iosSdk = sdkClient(ctx, iosKey);
  await iosSdk.customerInfo(xcUser);
  const now0 = Date.now();
  const txA = transaction({ transactionId: `${now0}01`, originalTransactionId: `${now0}01`, productId: "pro_monthly", purchaseDate: now0 - 20 * DAY, originalPurchaseDate: now0 - 20 * DAY, expiresDate: now0 + 10 * DAY, environment: "Xcode", signedDate: now0, price: 9990, currency: "USD", appAccountToken: crypto.randomUUID() });
  const txB = transaction({ transactionId: `${now0}02`, originalTransactionId: `${now0}02`, productId: "lifetime", type: "Non-Consumable", purchaseDate: now0 - 20 * DAY, originalPurchaseDate: now0 - 20 * DAY, expiresDate: undefined, environment: "Xcode", signedDate: now0, price: 29990, currency: "USD" });
  for (const [t, label] of [[txA, "subscription"], [txB, "lifetime"]] as const) {
    const r = await iosSdk.purchase(xcUser, t.productId, { fetch_token: await signJws(t, xcode), price: (t.price ?? 0) / 1000, currency: "USD" });
    c.check(`the Xcode-signed ${label} purchase is accepted with the app's StoreKit certificate (200, pro active)`, r.status === 200 && r.body.subscriber?.entitlements?.pro, r.body);
  }
  const [xcSub] = await sql`SELECT is_sandbox, store FROM subscriptions WHERE project_id = ${dev.projectId} AND store_key = ${txA.originalTransactionId}`;
  c.check("the Xcode purchase is an App Store sandbox subscription", xcSub?.store === "app_store" && xcSub.is_sandbox === true, xcSub);

  c.begin("Refund Control: settings, templates and the default policy");
  const empty = await dev.v2("GET", "/refund_control");
  c.eq("a new project: do not respond, consent not confirmed", empty.settings, { default_preference: "do_not_respond", customer_consented: false });
  c.eq("no policies yet; the default policy covers all 7 customers", [empty.policies.length, empty.default_policy.customer_count], [0, 7]);
  c.eq("the four templates", Object.keys(empty.templates).sort(), ["custom", "first_purchase_date", "platform", "recent_renewal"]);
  c.eq("recent renewal template: renewed or converted in the last 24 hours", empty.templates.recent_renewal, { groups: [{ conditions: [{ field: "lastRenewalAt", operator: "within", value: "24h" }] }] });
  const T = empty.templates;
  const policyNew = { name: "New customers", template: "first_purchase_date", rules: T.first_purchase_date, preference: "prefer_no_refund" };
  const policyIos = { name: "iPhone customers", template: "platform", rules: T.platform, preference: "consumption_only" };
  const policyRecent = { name: "Recent renewals", template: "recent_renewal", rules: T.recent_renewal, preference: "prefer_refund" };
  const policyVip = { name: "VIPs", template: "custom", rules: { groups: [{ conditions: [{ field: "customAttribute:vip", operator: "is", value: "true" }] }] }, preference: "prefer_no_refund" };
  const bad = await dev.v2r("POST", "/refund_control", { policies: [{ ...policyVip, rules: { groups: [{ conditions: [{ field: "favouriteColour", operator: "is", value: "red" }] }] } }] });
  c.check("a policy on a field the server cannot evaluate is refused (400)", bad.status === 400 && /favouriteColour/.test(JSON.stringify(bad.body)), bad.body);

  const saved = await dev.v2("POST", "/refund_control", { policies: [policyNew, policyIos, policyRecent, policyVip] });
  const counts = (v: any) => Object.fromEntries([...v.policies.map((p: any) => [p.name, p.customer_count]), ["default", v.default_policy.customer_count]]);
  c.eq("policies saved in order with positions 0..3", saved.policies.map((p: any) => [p.name, p.position, p.template, p.preference]), [["New customers", 0, "first_purchase_date", "prefer_no_refund"], ["iPhone customers", 1, "platform", "consumption_only"], ["Recent renewals", 2, "recent_renewal", "prefer_refund"], ["VIPs", 3, "custom", "prefer_no_refund"]]);
  // First match wins: rr_new is new; rr_renewed, rr_iphone and xc_buyer are on iOS; rr_converted renewed; rr_vip; rr_other.
  c.eq("customer counts per policy (first match wins)", counts(saved), { "New customers": 1, "iPhone customers": 3, "Recent renewals": 1, VIPs: 1, default: 1 });
  const rows = await sql`SELECT name, position, preference FROM refund_policies WHERE project_id = ${dev.projectId} ORDER BY position`;
  c.eq("refund_policies rows in SQL", rows.map((r) => [r.name, r.position, r.preference]), saved.policies.map((p: any) => [p.name, p.position, p.preference]));

  const byName = (n: string) => saved.policies.find((p: any) => p.name === n);
  const reordered = await dev.v2("POST", "/refund_control", { policies: [policyRecent, policyNew, policyIos, policyVip].map((p) => ({ ...p, id: byName(p.name).id })) });
  c.eq("reordered (same ids): Recent renewals first", reordered.policies.map((p: any) => [p.name, p.id]), [["Recent renewals", byName("Recent renewals").id], ["New customers", byName("New customers").id], ["iPhone customers", byName("iPhone customers").id], ["VIPs", byName("VIPs").id]]);
  c.eq("counts follow the new order: the renewed iPhone customer moves to Recent renewals", counts(reordered), { "Recent renewals": 2, "New customers": 1, "iPhone customers": 2, VIPs: 1, default: 1 });
  const stale = await dev.v2r("POST", "/refund_control", { settings: { default_preference: "prefer_refund" }, policies: [{ ...policyNew, id: "rfp_gone" }] });
  const afterStale = await dev.v2("GET", "/refund_control");
  c.check("a save from a stale tab (unknown policy id) is refused and changes nothing", stale.status === 400 && afterStale.policies.length === 4 && afterStale.settings.default_preference === "do_not_respond", { status: stale.status, n: afterStale.policies.length, settings: afterStale.settings });

  c.begin("Refund Control: Apple's CONSUMPTION_REQUEST");
  const notify = (payload: unknown, pki: Pki) => signJws(payload, pki).then((jws) => fetch(`${ctx.base}/v1/notifications/apple/${ios.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signedPayload: jws }) }));
  const note = async (type: string, tx: ReturnType<typeof transaction>, pki: Pki, extra: Record<string, unknown> = {}) => notify({
    notificationType: type, notificationUUID: crypto.randomUUID(), version: "2.0", signedDate: Date.now(),
    data: { bundleId: BUNDLE, environment: tx.environment, ...(tx.environment === "Production" ? { appAppleId: Number(APPLE_ID) } : {}), signedTransactionInfo: await signJws(tx, pki), ...extra },
  }, pki);
  const requests = () => sql`SELECT * FROM refund_requests WHERE project_id = ${dev.projectId} ORDER BY requested_at`;

  // A notification that claims to be from the App Store's production environment, signed by a chain that looks like
  // Apple's (Apple's marker OIDs) but is not rooted in Apple's certificate.
  const forgedPki = await makePki();
  const prodTx = { ...txA, environment: "Production", signedDate: Date.now() };
  const forged = await note("CONSUMPTION_REQUEST", prodTx, forgedPki, { consumptionRequestReason: "UNSATISFIED_WITH_PURCHASE" });
  const forgedText = await forged.text();
  c.check("a forged production CONSUMPTION_REQUEST (not rooted in Apple's certificate) is refused with 400", forged.status === 400 && /not valid/i.test(forgedText), { status: forged.status, body: forgedText });
  const unsigned = await fetch(`${ctx.base}/v1/notifications/apple/${ios.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signedPayload: `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({ notificationType: "CONSUMPTION_REQUEST" })).toString("base64url")}.` }) });
  c.check("an unsigned notification is refused with 400", unsigned.status === 400, unsigned.status);
  c.eq("nothing was recorded for the refused notifications", (await requests()).length, 0);

  // The developer's Xcode StoreKit certificate: accepted. Consent is not confirmed yet.
  const r1 = await note("CONSUMPTION_REQUEST", { ...txB, signedDate: Date.now() }, xcode, { consumptionRequestReason: "UNINTENDED_PURCHASE" });
  c.eq("an Xcode-signed CONSUMPTION_REQUEST is accepted (200)", r1.status, 200);
  let rq = await requests();
  c.has("before consent: recorded as skipped (consent), with the policy that applies (iPhone customers, consumption data only)", rq.find((r) => r.transaction_id === txB.transactionId), {
    app_user_id: xcUser, store: "app_store", is_sandbox: true, product_id: "lifetime", amount_usd: 29.99, reason: "UNINTENDED_PURCHASE", policy_name: "iPhone customers", preference: "consumption_only", consumption_status: "skipped", outcome: "pending", attempts: 0,
  });
  c.check("the skip reason names the consent setting", /consent/i.test(String(rq[0]?.last_error)), rq[0]?.last_error);
  const dl = rq[0] ? new Date(rq[0].deadline_at).getTime() - new Date(rq[0].requested_at).getTime() : 0;
  c.eq("Apple's 12-hour deadline is stored", dl, 12 * HOUR);

  const consent = await dev.v2("POST", "/refund_control", { settings: { customer_consented: true, default_preference: "consumption_only" } });
  c.eq("the developer confirms customer consent; the default answers with consumption data only", consent.settings, { default_preference: "consumption_only", customer_consented: true });
  c.eq("saving settings alone keeps the policies", consent.policies.map((p: any) => p.name), ["Recent renewals", "New customers", "iPhone customers", "VIPs"]);
  const [proj] = await sql`SELECT refund_settings FROM projects WHERE id = ${dev.projectId}`;
  c.eq("projects.refund_settings in SQL", proj?.refund_settings, { default_preference: "consumption_only", customer_consented: true });

  const r2 = await note("CONSUMPTION_REQUEST", { ...txA, signedDate: Date.now() }, xcode, { consumptionRequestReason: "UNSATISFIED_WITH_PURCHASE" });
  c.eq("a second Xcode-signed CONSUMPTION_REQUEST (subscription) is accepted", r2.status, 200);
  const again = await note("CONSUMPTION_REQUEST", { ...txA, signedDate: Date.now() }, xcode, { consumptionRequestReason: "UNSATISFIED_WITH_PURCHASE" });
  rq = await requests();
  c.check("Apple repeating the notification records one request per transaction", again.status === 200 && rq.filter((r) => r.transaction_id === txA.transactionId).length === 1, rq.map((r) => r.transaction_id));
  c.has("with consent: policy applied and recorded; Xcode has no App Store Server API, so nothing is sent", rq.find((r) => r.transaction_id === txA.transactionId), {
    policy_name: "iPhone customers", preference: "consumption_only", consumption_status: "skipped", amount_usd: 9.99, attempts: 0, sent_at: null, outcome: "pending",
  });
  c.check("the skip reason says Xcode has no App Store Server API", /Xcode environment has no App Store Server API/.test(String(rq.find((r) => r.transaction_id === txA.transactionId)?.last_error)), rq.map((r) => r.last_error));

  c.begin("Refund Control: outcomes (REFUND approves, REFUND_DECLINED declines)");
  const refunded = await note("REFUND", { ...txA, revocationDate: Date.now() - 60_000, revocationReason: 0, signedDate: Date.now() }, xcode);
  c.eq("REFUND (Xcode-signed) accepted", refunded.status, 200);
  const declined = await note("REFUND_DECLINED", { ...txB, signedDate: Date.now() }, xcode);
  c.eq("REFUND_DECLINED (Xcode-signed) accepted", declined.status, 200);
  rq = await requests();
  c.eq("the subscription's request is approved, the lifetime purchase's declined", Object.fromEntries(rq.map((r) => [r.transaction_id, r.outcome])), { [txA.transactionId]: "approved", [txB.transactionId]: "declined" });
  const info = await iosSdk.customerInfo(xcUser);
  c.check("the refunded subscription shows refunded_at in the SDK's customer info", typeof info.body.subscriber?.subscriptions?.pro_monthly?.refunded_at === "string", info.body.subscriber?.subscriptions?.pro_monthly);

  c.begin("Refund Control: Test Store refunds feed the cards");
  await tp(u("rf_sub"), "pro_monthly", "refund", 2);
  await tp(u("rf_life"), "lifetime", "refund", 3);
  rq = await requests();
  const ts = rq.filter((r) => r.store === "test_store");
  c.check("each Test Store refund is a request: approved, nothing to answer, policy that applies (New customers)", ts.length === 2 && ts.every((r) => r.outcome === "approved" && r.consumption_status === "not_applicable" && r.policy_name === "New customers" && r.is_sandbox === true && r.reason === "Refunded in the store"), ts.map((r) => ({ u: r.app_user_id, o: r.outcome, cs: r.consumption_status, p: r.policy_name, reason: r.reason })));
  c.eq("refund amounts in USD: 9.99 and 149.99", ts.map((r) => r.amount_usd).sort((a, b) => a - b), [9.99, 149.99]);
  const afterRefunds = await dev.v2("GET", "/refund_control");
  c.eq("the two refunded new customers count under New customers", counts(afterRefunds)["New customers"], 3);

  const stats = await dev.v2("GET", "/refund_control/stats?days=28&environment=sandbox");
  c.has("cards (sandbox, 28 days): 3 approved, 1 declined, refund rate 0.75", stats, { object: "refund_control_stats", days: 28, environment: "sandbox", refund_rate: 0.75, requests: { approved: 3, declined: 1, pending: 0, total: 4 } });
  c.eq("refund request amounts: approved 9.99 + 149.99 + 9.99, declined 29.99", stats.amount_in_usd, { approved: 169.97, declined: 29.99, pending: 0 });
  c.eq("consumption status split", stats.consumption, { not_applicable: 2, skipped: 2 });
  const [agg] = await sql`SELECT count(*) FILTER (WHERE outcome = 'approved')::int AS a, count(*) FILTER (WHERE outcome = 'declined')::int AS d, coalesce(sum(amount_usd) FILTER (WHERE outcome = 'approved'), 0)::float8 AS ausd FROM refund_requests WHERE project_id = ${dev.projectId} AND is_sandbox AND requested_at > now() - interval '28 days'`;
  c.eq("the cards match refund_requests in SQL", [stats.requests.approved, stats.requests.declined, stats.amount_in_usd.approved], [agg!.a, agg!.d, round2(agg!.ausd)]);
  const prod = await dev.v2("GET", "/refund_control/stats");
  c.check("production cards (the default) leave sandbox out: no requests, no rate", prod.environment === "production" && prod.requests.total === 0 && prod.refund_rate === null, prod);
  const week = await dev.v2("GET", "/refund_control/stats?days=1&environment=sandbox");
  c.eq("a 1-day window still holds all four (all requested today)", week.requests.total, 4);
  const list = await dev.v2("GET", "/refund_requests?limit=2");
  const list2 = list.next_page ? await dev.call("GET", list.next_page) : null;
  const listed = [...list.items, ...(list2?.body.items ?? [])];
  c.check("GET /refund_requests: newest first, paged, every request with its policy and outcome", list.items.length === 2 && listed.length === 4 && listed.every((x: any, i: number) => i === 0 || listed[i - 1].requested_at >= x.requested_at) && listed.find((x: any) => x.transaction_id === txB.transactionId)?.outcome === "declined", listed.map((x: any) => [x.app_user_id, x.store, x.outcome, x.policy_name, x.requested_at]));
  return { dev, appleAppId: ios.id, testKey: cat.testKey, iosKey, S, ids: { xcUser, iphone: u("rr_iphone"), other: u("rr_other"), txA: txA.transactionId } };
}

// ---------------------------------------------------------------------------------------------------------------------
// 2. Retention
// ---------------------------------------------------------------------------------------------------------------------

async function retention(ctx: Ctx, R: RefundProject, xcode: Pki) {
  const { c, sql } = ctx;
  const { dev } = R;
  const sdk = sdkClient(ctx, R.iosKey);
  const ccOf = async (id: string) => (await sdk.call("GET", `/v1/customercenter/${encodeURIComponent(id)}`)).body?.customer_center;
  const pathOf = (cc: any, type: string) => cc?.screens?.MANAGEMENT?.paths?.find((p: any) => p.type === type);

  c.begin("Retention: Customer Center offers reach the SDK as promotional_offer");
  const before = await ccOf(R.ids.iphone);
  c.check("before: the CANCEL path has no promotional offer", pathOf(before, "CANCEL") && pathOf(before, "CANCEL").promotional_offer === undefined, pathOf(before, "CANCEL"));
  const post = (json: unknown) => dev.v2r("POST", "/retention_offers", json);
  const cancel = await post({ trigger: "cancel", name: "Cancellation discount", title: "Stay for 50% off", subtitle: "Three months at half price", store: "app_store", product_mapping: { pro_monthly: "stay_50", pro_annual: "stay_annual" } });
  const cancelAndroid = await post({ trigger: "cancel", name: "Android cancellation", title: "Stay", store: "play_store", product_mapping: { "pro:monthly": "stay-offer" } });
  const refund = await post({ trigger: "refund", name: "Refund discount", title: "Before you go", subtitle: "A free month instead", store: "app_store", product_mapping: { pro_monthly: "free_month" } });
  c.check("three offers created (201)", [cancel, cancelAndroid, refund].every((r) => r.status === 201 && r.body.object === "retention_offer"), [cancel.status, cancelAndroid.status, refund.status]);
  c.eq("an offer linked to no product is refused (400)", (await post({ trigger: "cancel", name: "x", title: "x", store: "app_store", product_mapping: {} })).status, 400);
  const cc = await ccOf(R.ids.iphone);
  c.eq("CANCEL path: promotional_offer with the iOS and Android offer ids, title, subtitle and product mapping", pathOf(cc, "CANCEL")?.promotional_offer, {
    ios_offer_id: "stay_annual", android_offer_id: "stay-offer", eligible: true, title: "Stay for 50% off", subtitle: "Three months at half price",
    product_mapping: { pro_monthly: "stay_50", pro_annual: "stay_annual", "pro:monthly": "stay-offer" },
  });
  c.eq("REFUND_REQUEST path: the refund offer", pathOf(cc, "REFUND_REQUEST")?.promotional_offer, { ios_offer_id: "free_month", android_offer_id: "", eligible: true, title: "Before you go", subtitle: "A free month instead", product_mapping: { pro_monthly: "free_month" } });
  c.check("MISSING_PURCHASE keeps no offer", pathOf(cc, "MISSING_PURCHASE") && pathOf(cc, "MISSING_PURCHASE").promotional_offer === undefined, pathOf(cc, "MISSING_PURCHASE"));
  const v2cc = await dev.v2("GET", `/customers/${R.ids.iphone}/customer_center`);
  c.eq("v2 customer_center for the customer shows the same offer", pathOf(v2cc.customer_center, "CANCEL")?.promotional_offer, pathOf(cc, "CANCEL")?.promotional_offer);
  await dev.v2("POST", `/retention_offers/${cancel.body.id}`, { active: false });
  const off = await ccOf(R.ids.iphone);
  c.check("turning the App Store cancel offer off removes its ids from the SDK config", pathOf(off, "CANCEL")?.promotional_offer?.ios_offer_id === "" && !("pro_annual" in (pathOf(off, "CANCEL")?.promotional_offer?.product_mapping ?? {})), pathOf(off, "CANCEL")?.promotional_offer);
  await dev.v2("POST", `/retention_offers/${cancel.body.id}`, { active: true });
  const offers = await sql`SELECT trigger, store, active, product_mapping FROM retention_offers WHERE project_id = ${dev.projectId} ORDER BY created_at`;
  c.eq("retention_offers rows in SQL", offers.map((o) => [o.trigger, o.store, o.active]), [["cancel", "app_store", true], ["cancel", "play_store", true], ["refund", "app_store", true]]);
  const extra = await post({ trigger: "cancel", name: "Temporary offer", title: "Temp", store: "app_store", product_mapping: { pro_monthly: "temp_offer" } });
  const del = await dev.v2r("DELETE", `/retention_offers/${extra.body.id}`);
  const left = await sql`SELECT count(*)::int AS n FROM retention_offers WHERE id = ${extra.body.id}`;
  c.check("DELETE removes a retention offer (row gone)", del.status === 200 && left[0]!.n === 0, { status: del.status, rows: left[0]!.n });

  c.begin("Retention: Apple Retention Messaging saved for the App Store app");
  const A = `/apps/${R.appleAppId}/retention_messaging`;
  const TEXT = crypto.randomUUID(), SWITCH = crypto.randomUUID(), PROMO = crypto.randomUUID();
  const messages = [
    { id: TEXT, kind: "text", header: "Your scans stay unlimited", body: "Keep unlimited scans, OCR and cloud backup." },
    { id: SWITCH, kind: "switch_plan", header: "Pay less per month", body: "Switch to annual and save 40%.", alternate_product_id: "pro_annual" },
    { id: PROMO, kind: "promotional_offer", header: "Half price for 3 months", body: "Stay and pay 50% less.", promotional_offer_id: "stay_50" },
  ];
  const initial = await dev.v2("GET", A);
  c.has("a new app: off, the real-time URL on this server, the Apple ID and the In-App Purchase key known", initial, { object: "retention_messaging", enabled: false, realtime_url: `${ctx.base}/v1/retention/apple/${R.appleAppId}`, app_apple_id: APPLE_ID, has_in_app_purchase_key: true });
  c.eq("a header over Apple's 66 characters is refused (400)", (await dev.v2r("POST", A, { messages: [{ ...messages[0], header: "x".repeat(67) }] })).status, 400);
  c.eq("a default message that is not a text message is refused (400)", (await dev.v2r("POST", A, { messages, defaults: [{ product_id: "pro_monthly", locale: "en-US", message_id: PROMO }] })).status, 400);
  const save = await dev.v2("POST", A, { enabled: true, messages, defaults: [{ product_id: "pro_monthly", locale: "en-US", message_id: TEXT }], rules: [{ product_id: "pro_annual", message_id: SWITCH }, { product_id: "pro_monthly", message_id: PROMO }, { product_id: null, message_id: TEXT }] });
  c.check("messages, the default per product and locale, and the real-time rules are saved", save.enabled === true && save.messages.length === 3 && save.defaults.length === 1 && save.rules.length === 3, save);
  const got = await dev.v2("GET", A);
  c.eq("reloaded: the messages as saved", got.messages.map((m: any) => [m.id, m.kind, m.header]), messages.map((m) => [m.id, m.kind, m.header]));
  c.eq("reloaded: the default message", got.defaults.map((d: any) => [d.product_id, d.locale, d.message_id]), [["pro_monthly", "en-US", TEXT]]);
  const [appRow] = await sql`SELECT retention_messaging FROM apps WHERE id = ${R.appleAppId}`;
  c.check("apps.retention_messaging in SQL holds the three messages and the rules", appRow?.retention_messaging?.enabled === true && appRow.retention_messaging.messages.length === 3 && appRow.retention_messaging.rules[2].message_id === TEXT, appRow?.retention_messaging);

  const outFrom = ctx.server.outbound().length;
  const sync = await dev.v2r("POST", `${A}/actions/sync`, { environment: "sandbox" });
  const syncOut = ctx.server.outbound().slice(outFrom).filter((o) => o.host.endsWith("apple.com") && o.path.includes("/messaging/"));
  c.check("Sync to Apple calls Apple's sandbox Retention Messaging API (blocked in journeys) and reports each step's failure", sync.status === 200 && sync.body.sync?.errors?.length === 5 && sync.body.messages.every((m: any) => (m.uploaded ?? []).length === 0),
    { status: sync.status, errors: sync.body.sync?.errors });
  c.check("the attempted calls were the three message uploads, the default and the real-time URL on api.storekit-sandbox.apple.com, all blocked", syncOut.length === 5 && syncOut.every((o) => o.host === "api.storekit-sandbox.apple.com" && o.routed === "blocked" && o.method === "PUT") && syncOut.some((o) => o.path === "/inApps/v1/messaging/realtime/url"), syncOut);

  c.begin("Retention: Apple's real-time endpoint answers only Apple");
  const RT = `${ctx.base}/v1/retention/apple/${R.appleAppId}`;
  const call = async (body: unknown) => { const r = await fetch(RT, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
  const payload = { originalTransactionId: R.ids.txA, appAppleId: Number(APPLE_ID), productId: "pro_monthly", userLocale: "en-US", requestIdentifier: crypto.randomUUID(), environment: "Sandbox", signedDate: Date.now() };
  c.eq("no signedPayload: 400", (await call({})).status, 400);
  const none = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.`;
  c.eq("an unsigned payload (alg none): 400", (await call({ signedPayload: none })).status, 400);
  const forged = await call({ signedPayload: await signJws(payload, await makePki()) });
  c.check("a payload signed by a look-alike chain not rooted in Apple's certificate: 400", forged.status === 400 && /not valid/.test(forged.body?.error ?? ""), forged);
  const xc = await call({ signedPayload: await signJws({ ...payload, environment: "Xcode" }, xcode) });
  c.check("an Xcode-signed request is refused even though the app trusts that certificate for purchases: 400", xc.status === 400, xc);
  c.eq("an unknown app: 404", (await fetch(`${ctx.base}/v1/retention/apple/app_nope`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signedPayload: none }) })).status, 404);
  const [after] = await sql`SELECT retention_messaging->'stats' AS stats FROM apps WHERE id = ${R.appleAppId}`;
  c.check("refused requests are not counted as answered", !after?.stats || (Number(after.stats.requests ?? 0) === 0 && Number(after.stats.answered ?? 0) === 0), after?.stats);
}

// ---------------------------------------------------------------------------------------------------------------------
// 4. Support (runs on the Refund Control project: the summary shows refund requests too)
// ---------------------------------------------------------------------------------------------------------------------

async function support(ctx: Ctx, R: RefundProject) {
  const { c, sql } = ctx;
  const { dev, S } = R;
  const SUPPORT = `help-${S}@scanner-support.test`;
  const sdk = sdkClient(ctx, R.testKey);
  const ticket = (json: unknown) => sdk.call("POST", "/v1/customercenter/support/create-ticket", json);
  const testApp = (await dev.v2("GET", "/apps?limit=100")).items.find((a: any) => a.type === "test_store");

  c.begin("Support: the Customer Center's support settings");
  const cfg = await dev.v2("POST", "/customer_center_config", { customer_center: { support: { email: SUPPORT, support_tickets: { allow_creation: true, customer_type: "all", customer_details: { appUserId: true, activeEntitlements: true, totalSpent: true, userSince: true, lastSeenAppVersion: true } } } } });
  c.has("the support email and ticket settings are saved", cfg.customer_center.support, { email: SUPPORT, support_tickets: { allow_creation: true, customer_type: "all" } });
  const sdkCfg = (await sdk.call("GET", `/v1/customercenter/${R.ids.iphone}`)).body.customer_center;
  c.has("the SDK reads the ticket settings from its Customer Center config", sdkCfg.support, { email: SUPPORT, support_tickets: { allow_creation: true, customer_type: "all" } });

  c.begin("Support: a customer opens a ticket from the iOS Customer Center");
  const user = R.ids.iphone;
  const email = `iphone-${S}@example.org`;
  const desc = "My scans stopped syncing to iCloud after the last update.";
  const mailFrom = ctx.mails.length;
  const r = await ticket({ app_user_id: user, customer_email: email, issue_description: desc });
  c.check("create-ticket answers { sent: true }", r.status === 200 && r.body?.sent === true, r);
  const [row] = await sql`SELECT * FROM support_tickets WHERE project_id = ${dev.projectId} AND app_user_id = ${user}`;
  c.has("the ticket row: customer, email, description, open, emailed to the support address", row, { customer_email: email, description: desc, status: "open", emailed_to: SUPPORT, emailed: true, app_id: testApp.id });
  c.check("the ticket is linked to the customer", typeof row?.customer_id === "string" && row.customer_id.startsWith("cus_"), row?.customer_id);
  const mail = await until(async () => ctx.mails.slice(mailFrom).find((m) => m.to.includes(SUPPORT)));
  c.must("the support address got the ticket by email (SMTP)", mail, ctx.mails.slice(mailFrom).map((m) => m.to));
  c.eq("subject: who wrote, from which app", mail!.subject, `Support request from ${email} (${testApp.name})`);
  c.check("Reply-To is the customer, so support answers them directly", (rawHeader(mail!, "Reply-To") ?? "").includes(email), rawHeader(mail!, "Reply-To"));
  c.check("the email carries the description and the allowed customer details", mail!.text.includes(desc) && mail!.text.includes(`App user ID: ${user}`) && mail!.text.includes("Active entitlements: pro") && mail!.text.includes("Total spent: $0.00"), mail!.text.slice(0, 1500));
  c.check("the email links to the ticket in the dashboard", linksOf(mail!).includes(`${ctx.base}/projects/${dev.projectId}/lifecycle/support?ticket=${row?.id}`), linksOf(mail!));

  c.begin("Support: refusals and the per-customer limit");
  c.eq("an email that is not one plain address: sent false", (await ticket({ app_user_id: user, customer_email: "victim@x.example?bcc=me@evil.example", issue_description: "Help" })).body, { sent: false });
  c.eq("an empty description: sent false", (await ticket({ app_user_id: user, customer_email: email, issue_description: "   " })).body, { sent: false });
  const results: boolean[] = [];
  for (let i = 2; i <= 6; i++) results.push((await ticket({ app_user_id: user, customer_email: email, issue_description: `Follow-up ${i}` })).body?.sent);
  c.eq("tickets 2 to 5 in the hour are taken, the 6th is refused (5 per customer per hour)", results, [true, true, true, true, false]);
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM support_tickets WHERE project_id = ${dev.projectId} AND app_user_id = ${user}` as unknown as [{ n: number }];
  c.eq("5 tickets stored for the customer", n, 5);
  await dev.v2("POST", "/customer_center_config", { customer_center: { support: { email: SUPPORT, support_tickets: { allow_creation: false, customer_type: "all" } } } });
  c.eq("ticket creation turned off: sent false", (await ticket({ app_user_id: R.ids.other, customer_email: `other-${S}@example.org`, issue_description: "Hello" })).body, { sent: false });
  await dev.v2("POST", "/customer_center_config", { customer_center: { support: { email: SUPPORT, support_tickets: { allow_creation: true, customer_type: "all" } } } });
  const other = await ticket({ app_user_id: R.ids.xcUser, customer_email: `xc-${S}@example.org`, issue_description: "Why was my refund declined?" });
  c.eq("another customer's ticket is taken", other.body, { sent: true });
  const supportMails = await until(async () => { const m = ctx.mails.slice(mailFrom).filter((x) => x.to.includes(SUPPORT)); return m.length >= 6 ? m : null; });
  c.eq("the support inbox got exactly the 6 accepted tickets", (supportMails ?? ctx.mails.slice(mailFrom).filter((x) => x.to.includes(SUPPORT))).length, 6);
  // This server has no proxy in front: the per-caller limit must count the caller's own address (the socket's), not
  // one "unknown" bucket that every customer of a self-hosted server would share (20 tickets an hour for everyone).
  const ipKeys = await sql`SELECT key, count FROM rate_limits WHERE key LIKE ${`ticket:ip:${dev.projectId}:%`}`;
  c.check("the per-caller limit counts this caller's own address (127.0.0.1), not a bucket shared by every caller", ipKeys.length === 1 && /:(127\.0\.0\.1|::1)$/.test(ipKeys[0]!.key) && ipKeys[0]!.count === 7, ipKeys.map((k) => [k.key.replace(dev.projectId, "<project>"), k.count]));

  c.begin("Support: tickets in API v2");
  const tl = await dev.v2("GET", "/support_tickets?limit=50");
  c.check("newest first", tl.items[0]?.description === "Why was my refund declined?" && tl.items.length === 6, tl.items.map((t: any) => t.description));
  const firstId = tl.items.find((t: any) => t.description === desc).id;
  c.has("GET one ticket", await dev.v2("GET", `/support_tickets/${firstId}`), { object: "support_ticket", id: firstId, app_user_id: user, customer_email: email, status: "open", emailed: true });
  const closed = await dev.v2("POST", `/support_tickets/${firstId}`, { status: "closed" });
  c.check("closing a ticket sets closed_at", closed.status === "closed" && typeof closed.closed_at === "number", closed);
  c.eq("status=open lists the other 5", (await dev.v2("GET", "/support_tickets?status=open&limit=50")).items.length, 5);
  c.eq("status=closed lists the closed one", (await dev.v2("GET", "/support_tickets?status=closed")).items.map((t: any) => t.id), [firstId]);
  c.eq("an unknown ticket: 404", (await dev.v2r("GET", "/support_tickets/tkt_missing")).status, 404);

  c.begin("Support: the help desk summary (Intercom, Zendesk sidebars)");
  const s = await dev.v2("GET", `/customers/${encodeURIComponent(user)}/support_summary`);
  c.has("by app user id: who, status, entitlements, platform, link", s, { object: "support_summary", app_user_id: user, email: `Iphone-${S}@Example.org`, display_name: "Robin", status: "active", active_entitlements: ["pro"], platform: "iOS", dashboard_url: `${ctx.base}/projects/${dev.projectId}/customers/${encodeURIComponent(user)}` });
  c.has("its subscription: Test Store, sandbox, active, auto-renew on", s.subscriptions[0], { product_id: "pro_annual", store: "test_store", environment: "sandbox", active: true, auto_renew: true, billing_issue: false });
  c.eq("open tickets: the 4 still open", s.open_tickets.length, 4);
  c.eq("sandbox spend: the $59.99 annual purchase", s.sandbox_spent_in_usd, 59.99);
  const byEmail = await dev.v2("GET", `/support_summaries?email=${encodeURIComponent(`iphone-${S}@example.org`.toUpperCase())}`);
  c.eq("by email (any case): the same customer", byEmail.items.map((x: any) => x.app_user_id), [user]);
  const xs = await dev.v2("GET", `/customers/${encodeURIComponent(R.ids.xcUser)}/support_summary`);
  c.eq("a customer with refund requests: their outcomes appear (approved subscription, declined lifetime)", xs.refund_requests.map((x: any) => [x.product_id, x.outcome]).sort(), [["lifetime", "declined"], ["pro_monthly", "approved"]]);
  const xsSub = xs.subscriptions.find((x: any) => x.product_id === "pro_monthly");
  c.check("the refunded subscription: App Store, not active, auto-renew off, refunded_at set", xsSub?.store === "app_store" && xsSub.active === false && xsSub.auto_renew === false && typeof xsSub.refunded_at === "number", xsSub);
  c.eq("an unknown email: no items", (await dev.v2("GET", "/support_summaries?email=nobody%40example.org")).items, []);
  c.eq("no email: 400", (await dev.v2r("GET", "/support_summaries")).status, 400);
  c.eq("an unknown customer: 404", (await dev.v2r("GET", "/customers/nobody_here/support_summary")).status, 404);
}

// ---------------------------------------------------------------------------------------------------------------------
// 3. Win-back
// ---------------------------------------------------------------------------------------------------------------------

interface WinbackProject { dev: Dev; S: string; users: Record<string, string>; emails: Record<string, string>; amazonKey: string; testKey: string; prices: Record<string, number> }

async function winback(ctx: Ctx): Promise<WinbackProject> {
  const { c, sql } = ctx;
  const S = ctx.stamp;
  const dev = await signUp(ctx, "winback", "Scanner");
  const cat = await standardCatalog(dev);
  const SUPPORT = `care-${S}@scanner-support.test`;
  await dev.v2("POST", "/customer_center_config", { customer_center: { support: { email: SUPPORT } } });

  // Amazon's Receipt Verification Service, answered locally for the receipts this journey issues (production path only).
  const receipts = new Map<string, Record<string, unknown>>();
  const handler = async (r: Captured, res: ServerResponse) => {
    if (r.host !== "appstore-sdk.amazon.com") return false;
    const m = /\/receiptId\/([^/]+)$/.exec(r.path);
    const receipt = m ? receipts.get(decodeURIComponent(m[1]!)) : undefined;
    res.setHeader("content-type", "application/json");
    if (r.path.startsWith("/sandbox/") || !receipt) { res.statusCode = 400; res.end(JSON.stringify({ message: "Unknown receipt" })); return true; }
    res.statusCode = 200; res.end(JSON.stringify(receipt)); return true;
  };
  ctx.capture.handlers.unshift(handler);
  try {
    c.begin("Win-back: an Amazon Appstore app (production purchases) and customers who churned");
    const amazon = await dev.v2("POST", "/apps", { name: "Scanner Amazon", type: "amazon", amazon: { package_name: "com.example.scanner.amazon", shared_secret: `2:${rnd(40)}` } });
    const amazonKey = (await dev.v2("GET", `/apps/${amazon.id}/public_api_keys`)).items[0].key as string;
    const monthly = await dev.v2("POST", "/products", { store_identifier: "scan.pro.monthly", app_id: amazon.id, type: "subscription", display_name: "Pro monthly (Amazon)", subscription: { duration: "P1M" } });
    const lifetime = await dev.v2("POST", "/products", { store_identifier: "scan.lifetime", app_id: amazon.id, type: "non_consumable", display_name: "Lifetime (Amazon)" });
    await dev.v2("POST", `/entitlements/${cat.pro.id}/actions/attach_products`, { product_ids: [monthly.id, lifetime.id] });
    const amz = sdkClient(ctx, amazonKey, "android");
    const h = { "x-is-sandbox": "false", "x-client-version": "2.3.0" };
    const users: Record<string, string> = {};
    const emails: Record<string, string> = {};
    const buyAmazon = async (key: string, o: { purchasedDaysAgo: number; cancelledDaysAgo?: number; renewsInDays?: number; trialEndsInDays?: number; email?: boolean; oneTime?: boolean }) => {
      const id = users[key] ??= `wb_${key}_${S}`;
      await amz.call("GET", `/v1/subscribers/${id}`, undefined, h);
      if (o.email) {
        emails[key] = `${key.replace(/_/g, "-")}-${S}@example.org`;
        await amz.call("POST", `/v1/subscribers/${id}/attributes`, { attributes: { $email: { value: emails[key], updated_at_ms: Date.now() } } }, h);
      }
      const receiptId = `amzn-${key}-${rnd(16)}`;
      const now = Date.now();
      receipts.set(receiptId, o.oneTime
        ? { receiptId, productId: "scan.lifetime", productType: "ENTITLED", purchaseDate: now - o.purchasedDaysAgo * DAY, cancelDate: null, testTransaction: false, betaProduct: false, countryCode: "US", quantity: 1 }
        : { receiptId, productId: "scan.pro", productType: "SUBSCRIPTION", termSku: "scan.pro.monthly", term: "1 Month", purchaseDate: now - o.purchasedDaysAgo * DAY,
          renewalDate: o.renewsInDays !== undefined ? now + o.renewsInDays * DAY : null, cancelDate: o.cancelledDaysAgo !== undefined ? now - o.cancelledDaysAgo * DAY : null,
          ...(o.trialEndsInDays !== undefined ? { freeTrialEndDate: now + o.trialEndsInDays * DAY } : {}),
          autoRenewing: o.cancelledDaysAgo === undefined, testTransaction: false, betaProduct: false, countryCode: "US", quantity: 1 });
      const product = o.oneTime ? "scan.lifetime" : "scan.pro.monthly";
      const price = o.oneTime ? 19.99 : 4.99;
      const r = await amz.call("POST", "/v1/receipts", { app_user_id: id, fetch_token: receiptId, product_id: product, store_user_id: `amzn1.account.${rnd(20).toUpperCase()}`, price, currency: "USD", is_restore: false }, h);
      c.check(`${key}: Amazon receipt accepted (200)`, r.status === 200, r.body);
      return { id, receiptId, body: r.body };
    };
    const lapsedA = await buyAmazon("lapsed_a", { purchasedDaysAgo: 40, cancelledDaysAgo: 10, email: true });
    await buyAmazon("lapsed_b", { purchasedDaysAgo: 50, cancelledDaysAgo: 20, email: true });
    await buyAmazon("lapsed_noemail", { purchasedDaysAgo: 40, cancelledDaysAgo: 10 });
    await buyAmazon("long_gone", { purchasedDaysAgo: 130, cancelledDaysAgo: 100, email: true });
    const paying = await buyAmazon("paying", { purchasedDaysAgo: 5, renewsInDays: 25, email: true });
    await buyAmazon("lifetime", { purchasedDaysAgo: 3, oneTime: true });
    const trialing = await buyAmazon("trialing", { purchasedDaysAgo: 2, renewsInDays: 5, trialEndsInDays: 5 });
    c.check("the trial customer has pro during the 7-day trial", Date.parse(trialing.body.subscriber?.entitlements?.pro?.expires_date) > Date.now() && trialing.body.subscriber?.subscriptions?.["scan.pro.monthly"]?.period_type === "trial", trialing.body.subscriber?.subscriptions);
    c.check("lapsed customers have no pro access; the paying one has", !lapsedA.body.subscriber?.entitlements?.pro || Date.parse(lapsedA.body.subscriber.entitlements.pro.expires_date) < Date.now(), lapsedA.body.subscriber?.entitlements);
    c.check("the paying customer has pro until the renewal", Date.parse(paying.body.subscriber?.entitlements?.pro?.expires_date) > Date.now(), paying.body.subscriber?.entitlements);
    const amazonSubs = await sql`SELECT cu.original_app_user_id AS u, s.is_sandbox, s.expires_date FROM subscriptions s JOIN customers cu ON cu.id = s.customer_id WHERE s.project_id = ${dev.projectId} AND s.store = 'amazon'`;
    c.check("the Amazon subscriptions are production; the lapsed one ended about 10 days ago", amazonSubs.length === 6 && amazonSubs.every((x) => x.is_sandbox === false) && Math.abs(Date.now() - new Date(amazonSubs.find((x) => x.u === users.lapsed_a)!.expires_date).getTime() - 10 * DAY) < DAY, amazonSubs);
    const rvs = ctx.capture.of("appstore-sdk.amazon.com");
    c.check("RevenueDot verified each receipt on Amazon's production RVS path", rvs.length >= 7 && rvs.every((x) => x.path.startsWith("/version/1.0/verifyReceiptId/developer/")), rvs.map((x) => x.path.replace(/developer\/[^/]+/, "developer/…")));

    // Test Store customers who churned are sandbox: win-back leaves them out.
    const sdk = sdkClient(ctx, cat.testKey);
    for (const [key, scenario] of [["ts_expired", "expire"], ["ts_billing", "billing_issue"]] as const) {
      users[key] = `wb_${key}_${S}`;
      emails[key] = `${key.replace(/_/g, "-")}-${S}@example.org`;
      await sdk.customerInfo(users[key]);
      await sdk.attributes(users[key], { $email: emails[key] });
      const r = await dev.v2r("POST", "/test_purchases", { app_user_id: users[key], product_id: "pro_monthly", scenario, offset_days: 40 });
      c.check(`${key}: Test Store ${scenario} 40 days ago accepted, access ended`, r.status === 201 && r.body.subscription?.gives_access === false, r.body.subscription);
    }
    users.browser = `wb_browser_${S}`;
    await sdk.customerInfo(users.browser);

    c.begin("Win-back: a campaign for subscribers who churned 3 to 60 days ago");
    // The tick sends at the campaign's UTC hour: start well inside the hour so the slot does not move to tomorrow.
    if (new Date().getUTCMinutes() >= 58) await sleep((61 - new Date().getUTCMinutes()) * 60_000);
    const hour = new Date().getUTCHours();
    const OFFER = "https://scanner.example/comeback?src=winback";
    const email = { subject: "We saved your scans", heading: "Your scans are waiting", body: "Come back to Scanner Pro.\n\nYour first month is on us.", button_label: "Resubscribe" };
    const draft = await dev.v2("POST", "/winback_campaigns", {
      name: "Come back", status: "draft", audience: { churned_min_days: 3, churned_max_days: 60, product_ids: ["scan.pro.monthly"], stores: [], audience_id: null },
      email, offer: { type: "url", url: OFFER }, send_hour_utc: hour, track_opens: true,
    });
    c.has("campaign created as a draft", draft, { object: "winback_campaign", status: "draft", send_hour_utc: hour, track_opens: true, offer: { type: "url", url: OFFER } });
    c.check("the API never shows the internal link base", !("link_base" in draft.email), draft.email);
    c.eq("an http offer link is refused (https only)", (await dev.v2r("POST", "/winback_campaigns", { name: "x", email, offer: { type: "url", url: "http://scanner.example/x" } })).status, 400);
    const preview = await dev.v2("POST", `/winback_campaigns/${draft.id}/actions/preview`);
    c.eq("preview: exactly the two lapsed Amazon subscribers with an email (not active, not too long ago, not sandbox, not without email)", preview.sample.map((x: any) => x.app_user_id).sort(), [users.lapsed_a, users.lapsed_b].sort());
    c.has("preview sample carries the email, store and product", preview.sample.find((x: any) => x.app_user_id === users.lapsed_a), { email: emails.lapsed_a, store: "amazon", product_id: "scan.pro.monthly" });
    c.eq("a draft cannot be sent (422)", (await dev.v2r("POST", `/winback_campaigns/${draft.id}/actions/run`)).status, 422);
    const testMail = await dev.v2("POST", `/winback_campaigns/${draft.id}/actions/send_test`, { email: `me-${S}@scanner-support.test` });
    const tm = await until(async () => ctx.mails.find((m) => m.to.includes(`me-${S}@scanner-support.test`)));
    c.check("Send test: a [Test] email reaches the developer's address", testMail.sent_to === `me-${S}@scanner-support.test` && tm?.subject === `[Test] ${email.subject}`, tm?.subject);

    const mailFrom = ctx.mails.length;
    const started = await dev.v2("POST", `/winback_campaigns/${draft.id}`, { status: "active" });
    c.eq("campaign started", started.status, "active");
    const sent = await until(async () => {
      const m = ctx.mails.slice(mailFrom).filter((x) => x.subject === email.subject);
      return m.length >= 2 ? m : null;
    }, { timeoutMs: 100_000, everyMs: 1000 });
    c.must("the tick sent the campaign at its hour: two emails over SMTP", sent?.length === 2, ctx.mails.slice(mailFrom).map((m) => [m.to, m.subject]));
    c.eq("to the two lapsed subscribers", sent!.flatMap((m) => m.to).sort(), [emails.lapsed_a, emails.lapsed_b].sort());
    const camp = await dev.v2("GET", `/winback_campaigns/${draft.id}`);
    c.check("the campaign recorded its run (last_run_at)", typeof camp.last_run_at === "number", camp.last_run_at);
    const mA = sent!.find((m) => m.to.includes(emails.lapsed_a))!;
    const mB = sent!.find((m) => m.to.includes(emails.lapsed_b))!;
    c.check("From: the app's name (the project's name) on the server's sending address", /^"?Scanner"? <no-reply@journeys\.test>$/.test(rawHeader(mA, "From") ?? ""), rawHeader(mA, "From"));
    c.check("Reply-To: the project's support email", (rawHeader(mA, "Reply-To") ?? "").includes(SUPPORT), rawHeader(mA, "Reply-To"));
    c.check("the email shows the heading, the body and the button", mA.html.includes(email.heading) && mA.html.includes("Your first month is on us.") && mA.html.includes(email.button_label), mA.html.slice(0, 800));
    const sends = await sql`SELECT email, token, offer_url, opened_at, clicked_at, unsubscribed_at, error FROM winback_sends WHERE campaign_id = ${draft.id}`;
    const sA = sends.find((x) => x.email === emails.lapsed_a)!, sB = sends.find((x) => x.email === emails.lapsed_b)!;
    c.check("winback_sends: one row per customer, the offer link stored, no error", sends.length === 2 && sends.every((x) => x.offer_url === OFFER && x.error === null && !x.opened_at && !x.clicked_at), sends.map((x) => ({ e: x.email, o: x.offer_url, err: x.error })));
    const links = linksOf(mA);
    c.check("the email links: tracked click, unsubscribe and the open pixel, all with the customer's token", links.includes(`${ctx.base}/v1/winback/c/${sA.token}`) && links.includes(`${ctx.base}/v1/winback/u/${sA.token}`) && mA.html.includes(`${ctx.base}/v1/winback/o/${sA.token}`), links);
    c.check("the offer URL itself is not in the email (every click is tracked)", !links.includes(OFFER), links);
    c.eq("no List-Unsubscribe header for an http link (mail providers take https only)", rawHeader(mA, "List-Unsubscribe"), null);

    c.begin("Win-back: the customer opens, clicks and the other one unsubscribes");
    const pixel = await fetch(`${ctx.base}/v1/winback/o/${sA.token}`);
    c.check("the open pixel is a no-store GIF", pixel.status === 200 && pixel.headers.get("content-type") === "image/gif" && /no-store/.test(pixel.headers.get("cache-control") ?? ""), [pixel.status, pixel.headers.get("content-type")]);
    const [opened] = await sql`SELECT opened_at, clicked_at FROM winback_sends WHERE token = ${sA.token}`;
    c.check("the open is recorded", opened?.opened_at && !opened.clicked_at, opened);
    const click = await fetch(`${ctx.base}/v1/winback/c/${sA.token}`, { redirect: "manual" });
    c.check("the tracked link redirects (302) to the offer", click.status === 302 && click.headers.get("location") === OFFER, [click.status, click.headers.get("location")]);
    const [clicked] = await sql`SELECT clicked_at FROM winback_sends WHERE token = ${sA.token}`;
    c.check("the click is recorded", !!clicked?.clicked_at, clicked);
    c.eq("an unknown click token: 404 page", (await fetch(`${ctx.base}/v1/winback/c/${"A".repeat(24)}`, { redirect: "manual" })).status, 404);
    const ask = await fetch(`${ctx.base}/v1/winback/u/${sB.token}`);
    const askText = await ask.text();
    c.check("opening the unsubscribe link asks first (a GET never unsubscribes: mail scanners follow links)", ask.status === 200 && askText.includes('<form method="post">'), askText.slice(0, 300));
    c.eq("no suppression yet", (await sql`SELECT email FROM email_suppressions WHERE project_id = ${dev.projectId}`).length, 0);
    const unsub = await fetch(`${ctx.base}/v1/winback/u/${sB.token}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
    c.check("one-click unsubscribe (POST): done", unsub.status === 200 && (await unsub.text()).includes("You are unsubscribed"), unsub.status);
    const supp = await sql`SELECT email, reason FROM email_suppressions WHERE project_id = ${dev.projectId}`;
    c.eq("the suppression is stored (lower-cased address)", supp.map((x) => [x.email, x.reason]), [[emails.lapsed_b.toLowerCase(), "unsubscribed"]]);
    const again = await fetch(`${ctx.base}/v1/winback/u/${sB.token}`);
    c.check("the link now says they are unsubscribed", (await again.text()).includes("You are unsubscribed"));

    c.begin("Win-back: once per customer");
    const rerun = await dev.v2("POST", `/winback_campaigns/${draft.id}/actions/run`);
    c.eq("Send now on the same campaign emails nobody again", rerun.sent, 0);
    c.eq("preview: nobody is left to email", (await dev.v2("POST", `/winback_campaigns/${draft.id}/actions/preview`)).eligible, 0);

    c.begin("Win-back: a second campaign skips the unsubscribed address");
    const nowHour = new Date().getUTCHours();
    const second = await dev.v2("POST", "/winback_campaigns", { name: "Second chance", status: "active", audience: { churned_min_days: 3, churned_max_days: 60, product_ids: [], stores: [], audience_id: null }, email: { ...email, subject: "Still thinking about it?" }, offer: { type: "url", url: OFFER }, send_hour_utc: nowHour < 23 ? nowHour + 1 : nowHour });
    const p2 = await dev.v2("POST", `/winback_campaigns/${second.id}/actions/preview`);
    c.eq("eligible: only the customer who did not unsubscribe", p2.sample.map((x: any) => x.app_user_id), [users.lapsed_a]);
    const mail2From = ctx.mails.length;
    const run2 = await dev.v2("POST", `/winback_campaigns/${second.id}/actions/run`);
    const sent2 = await until(async () => { const m = ctx.mails.slice(mail2From).filter((x) => x.subject === "Still thinking about it?"); return m.length ? m : null; });
    if (nowHour < 23) c.eq("Send now: one email", run2.sent, 1);
    c.eq("the second campaign emailed the clicked customer only, never the unsubscribed one", (sent2 ?? []).flatMap((m) => m.to), [emails.lapsed_a]);

    c.begin("Win-back: the clicked customer comes back (reactivation)");
    const back = await buyAmazon("lapsed_a", { purchasedDaysAgo: 0, renewsInDays: 30 });
    c.check("the returning customer has pro again", Date.parse(back.body.subscriber?.entitlements?.pro?.expires_date) > Date.now(), back.body.subscriber?.entitlements);
    // A Test Store purchase is sandbox: it never counts as won back.
    const tsBack = await dev.v2r("POST", "/test_purchases", { app_user_id: users.lapsed_b, product_id: "pro_monthly", scenario: "purchase" });
    c.eq("the unsubscribed customer makes a Test Store (sandbox) purchase", tsBack.status, 201);
    const st = await dev.v2("GET", `/winback_campaigns/${draft.id}`);
    c.eq("campaign stats: 2 sent, 1 opened, 1 clicked, 1 unsubscribed, 1 reactivated with $4.99 (sandbox purchases do not count)", st.stats, { sent: 2, failed: 0, opened: 1, clicked: 1, unsubscribed: 1, reactivated: 1, reactivated_revenue_in_usd: 4.99 });
    c.eq("the campaign page's recent sends", st.recent_sends.map((x: any) => [x.email, !!x.opened_at, !!x.clicked_at, !!x.unsubscribed_at]).sort(), [[emails.lapsed_a, true, true, false], [emails.lapsed_b, false, false, true]].sort());
    const st2 = await dev.v2("GET", `/winback_campaigns/${second.id}`);
    c.has("the second campaign also counts the comeback", st2.stats, { sent: 1, reactivated: 1, reactivated_revenue_in_usd: 4.99 });
    const listed = await dev.v2("GET", "/winback_campaigns");
    c.eq("the campaign list carries both with their stats", listed.items.map((x: any) => [x.name, x.stats.sent, x.stats.reactivated]), [["Come back", 2, 1], ["Second chance", 1, 1]]);
    const [ledger] = await sql`SELECT count(*)::int AS n, coalesce(sum(revenue_usd), 0)::float8 AS usd FROM transactions t JOIN winback_sends s ON s.customer_id = t.customer_id AND s.campaign_id = ${draft.id} WHERE t.purchased_at >= s.sent_at AND NOT t.is_sandbox AND t.kind IN ('purchase','renewal','trial','one_time')`;
    c.eq("the stats match the transaction ledger in SQL", [ledger!.n, round2(ledger!.usd)], [1, 4.99]);

    const winbackMails = ctx.mails.filter((m) => [email.subject, "Still thinking about it?"].includes(m.subject));
    c.eq("in all, the clicked customer got 2 win-back emails (one per campaign), the unsubscribed one 1", [winbackMails.filter((m) => m.to.includes(emails.lapsed_a)).length, winbackMails.filter((m) => m.to.includes(emails.lapsed_b)).length], [2, 1]);
    c.check("nobody else got a win-back email (sandbox, active, trialing, too long ago or without an email)", winbackMails.every((m) => m.to.every((t) => [emails.lapsed_a, emails.lapsed_b].includes(t))), winbackMails.map((m) => m.to));
    return { dev, S, users, emails, amazonKey, testKey: cat.testKey, prices: { sub: 4.99, lifetime: 19.99 } };
  } finally {
    const i = ctx.capture.handlers.indexOf(handler);
    if (i >= 0) ctx.capture.handlers.splice(i, 1);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// 5. Customer lists (the win-back project: production Amazon customers, sandbox Test Store customers, a browser)
// ---------------------------------------------------------------------------------------------------------------------

async function customerLists(ctx: Ctx, W: WinbackProject) {
  const { c, sql } = ctx;
  const { dev, users, emails } = W;
  const get = (q: string) => dev.v2("GET", `/customer_lists?${q}`);
  const ids = (body: any) => body.items.map((r: any) => r.id).sort();
  const U = (...keys: string[]) => keys.map((k) => users[k]!).sort();

  c.begin("Customer lists: built-in lists and the summary cards");
  const all = await get("list=all&limit=100");
  const EVERYONE = U("lapsed_a", "lapsed_b", "lapsed_noemail", "long_gone", "paying", "trialing", "lifetime", "ts_expired", "ts_billing", "browser");
  c.eq("All customers: the 10 this project made", ids(all), EVERYONE);
  const spent = await sql`SELECT cu.original_app_user_id AS u, coalesce(sum(t.revenue_usd), 0)::float8 AS usd FROM customers cu LEFT JOIN transactions t ON t.customer_id = cu.id AND NOT t.is_sandbox WHERE cu.project_id = ${dev.projectId} GROUP BY cu.original_app_user_id`;
  const ledgerTotal = round2(spent.reduce((s, r) => s + Number(r.usd), 0));
  // Amazon: lapsed_a 4.99 + 4.99 (came back), lapsed_b, lapsed_noemail, long_gone, paying 4.99 each, lifetime 19.99.
  c.eq("summary cards: 10 customers, 1 trialing, 2 paid subscribers, $49.93 revenue (production only)", all.summary, { object: "customer_list_summary", customers: 10, trialing_subscribers: 1, paid_subscribers: 2, total_revenue_in_usd: 49.93, is_approximate: false });
  c.eq("total revenue = the production transaction ledger in SQL", ledgerTotal, all.summary.total_revenue_in_usd);
  const row = (id: string) => all.items.find((r: any) => r.id === id);
  c.has("came-back customer row: active, renewing, $9.98, latest purchase on Amazon in production", row(users.lapsed_a!), { subscription_status: "active", auto_renewal_status: "on", email: emails.lapsed_a, spent_in_usd: 9.98, latest_purchase: { product_id: "scan.pro.monthly", store: "amazon", environment: "production" }, platform: "android" });
  c.has("lapsed customer row: expired, no auto-renewal state", row(users.lapsed_noemail!), { subscription_status: "expired", auto_renewal_status: null, email: null, spent_in_usd: 4.99 });
  c.has("Test Store churned customer: expired, $0 spent (sandbox), latest purchase sandbox", row(users.ts_expired!), { subscription_status: "expired", spent_in_usd: 0, latest_purchase: { store: "test_store", environment: "sandbox" } });
  c.has("one-time buyer: no subscription, $19.99", row(users.lifetime!), { subscription_status: "none", spent_in_usd: 19.99, latest_purchase: { product_id: "scan.lifetime", store: "amazon" } });
  c.has("trial customer: trialing, renewing, $0 spent so far", row(users.trialing!), { subscription_status: "trialing", auto_renewal_status: "on", spent_in_usd: 0, latest_purchase: { store: "amazon", environment: "production" } });
  c.has("browser: nothing bought", row(users.browser!), { subscription_status: "none", latest_purchase: null, spent_in_usd: 0 });
  c.eq("Active subscribers (production, trials included)", ids(await get("list=active")), U("lapsed_a", "paying", "trialing"));
  c.eq("Sandbox (anyone with a sandbox purchase)", ids(await get("list=sandbox")), U("ts_expired", "ts_billing", "lapsed_b"));
  c.eq("Non-subscription (production one-time buyers)", ids(await get("list=non_subscription")), U("lifetime"));
  c.eq("Expired (every production subscription ended)", ids(await get("list=expired")), U("lapsed_b", "lapsed_noemail", "long_gone"));
  const act = await get("list=active");
  c.has("Active list cards", act.summary, { customers: 3, paid_subscribers: 2, trialing_subscribers: 1, total_revenue_in_usd: 14.97 });

  c.begin("Customer lists: filters, search, a saved audience and paging");
  const rules = (r: unknown) => encodeURIComponent(JSON.stringify(r));
  c.eq("Expired + filter 'latest store is amazon' (the unsubscribed one bought on the Test Store since)", ids(await get(`list=expired&rules=${rules({ groups: [{ conditions: [{ field: "latestStore", operator: "is", value: "amazon" }] }] })}`)), U("lapsed_noemail", "long_gone"));
  c.eq("All + filter 'spent more than $5' OR 'currently has the Test Store'", ids(await get(`list=all&rules=${rules({ groups: [{ conditions: [{ field: "totalSpent", operator: "greaterThan", value: "5" }] }, { conditions: [{ field: "anyActiveStore", operator: "is", value: "test_store" }] }] })}`)), U("lapsed_a", "lifetime", "lapsed_b"));
  c.eq("a filter on an unknown field is refused (400)", (await dev.v2r("GET", `/customer_lists?list=all&rules=${rules({ groups: [{ conditions: [{ field: "shoeSize", operator: "is", value: "9" }] }] })}`)).status, 400);
  c.eq("search by app user id", ids(await get(`search=${encodeURIComponent(`wb_long_gone_${W.S}`.toUpperCase())}`)), U("long_gone"));
  c.eq("search by email", ids(await get(`search=${encodeURIComponent(emails.paying!)}`)), U("paying"));
  const aud = await dev.v2("POST", "/audiences", { name: "Reachable by email", rules: { groups: [{ conditions: [{ field: "email", operator: "isNotEmpty" }] }] } });
  const audList = await get(`list=${aud.id}`);
  c.eq("a saved audience as a list: everyone with an email", ids(audList), U("lapsed_a", "lapsed_b", "long_gone", "paying", "ts_expired", "ts_billing"));
  c.has("its cards", audList.summary, { customers: 6, paid_subscribers: 2, total_revenue_in_usd: 24.95 });
  c.eq("an unknown audience: 404", (await dev.v2r("GET", "/customer_lists?list=aud_missing")).status, 404);
  const p1 = await get("list=all&limit=4");
  const p2 = p1.next_page ? (await dev.call("GET", p1.next_page)).body : null;
  const p3 = p2?.next_page ? (await dev.call("GET", p2.next_page)).body : null;
  const paged = [...p1.items, ...(p2?.items ?? []), ...(p3?.items ?? [])].map((r: any) => r.id);
  c.check("paging (4 per page) walks all 10 once, newest seen first", p1.items.length === 4 && paged.length === 10 && new Set(paged).size === 10 && !p3?.next_page && paged.every((_, i) => i === 0 || all.items.findIndex((r: any) => r.id === paged[i - 1]) < all.items.findIndex((r: any) => r.id === paged[i])), paged);

  c.begin("Customer lists: CSV export");
  const res = await fetch(`${ctx.base}/v2/projects/${dev.projectId}/customer_lists/export?list=all`, { headers: { cookie: dev.cookie } });
  const csv = await res.text();
  const day = new Date().toISOString().slice(0, 10);
  c.check("a CSV download named customers-all-<date>.csv", res.status === 200 && /^text\/csv/.test(res.headers.get("content-type") ?? "") && res.headers.get("content-disposition") === `attachment; filename="customers-all-${day}.csv"`, [res.status, res.headers.get("content-type"), res.headers.get("content-disposition")]);
  const lines = csv.trim().split("\r\n");
  const head = lines[0]!.split(",");
  c.eq("the columns", head, ["app_user_id", "email", "subscription_status", "auto_renewal_status", "first_seen_at", "last_seen_at", "spent_in_usd", "latest_product_id", "latest_store", "latest_purchase_at", "country", "platform"]);
  const recs = lines.slice(1).map((l) => Object.fromEntries(l.split(",").map((v, i) => [head[i]!, v])));
  c.eq("one row per customer, the same 10", recs.map((r) => r.app_user_id).sort(), EVERYONE);
  const problems: string[] = [];
  for (const r of recs) {
    const api = row(r.app_user_id!);
    const want = { email: api.email ?? "", subscription_status: api.subscription_status, auto_renewal_status: api.auto_renewal_status ?? "", spent_in_usd: api.spent_in_usd.toFixed(2), latest_product_id: api.latest_purchase?.product_id ?? "", latest_store: api.latest_purchase?.store ?? "", latest_purchase_at: api.latest_purchase ? new Date(api.latest_purchase.purchased_at).toISOString() : "", first_seen_at: new Date(api.first_seen_at).toISOString(), platform: api.platform ?? "" };
    for (const [k, v] of Object.entries(want)) if (r[k] !== v) problems.push(`${r.app_user_id}.${k}: csv ${r[k]} api ${v}`);
  }
  c.check("every CSV row matches the list API, column by column", problems.length === 0, problems);
  const csvSpent = round2(recs.reduce((s, r) => s + Number(r.spent_in_usd), 0));
  c.eq("the CSV's spent column adds up to the revenue card", csvSpent, all.summary.total_revenue_in_usd);
  c.has("came-back customer in the CSV", recs.find((r) => r.app_user_id === users.lapsed_a), { email: emails.lapsed_a, subscription_status: "active", auto_renewal_status: "on", spent_in_usd: "9.98", latest_store: "amazon" });
  const activeCsv = await (await fetch(`${ctx.base}/v2/projects/${dev.projectId}/customer_lists/export?list=active`, { headers: { cookie: dev.cookie } })).text();
  c.eq("the Active list's CSV: its 3 customers", activeCsv.trim().split("\r\n").slice(1).map((l) => l.split(",")[0]).sort(), U("lapsed_a", "paying", "trialing"));
}
