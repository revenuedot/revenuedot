// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: journey (c), the subscription lifecycle. Every Test Store scenario of POST /v2/projects/{id}/test_purchases
// (purchase, trial, trial conversion, renewals, cancellation, billing issue in grace and after it, refunds of a
// subscription and a one-time purchase, expiration) runs on its own customer, each state applied at the time it happened.
// Checks: the events of each scenario, every delivered webhook key by key against RevenueCat's sample payloads
// (packages/contract/fixtures/webhooks), the customer info the SDK sees, the v2 subscription status, and the charts
// against the transaction ledger in SQL. REFUND_REVERSED needs a signed App Store notification: the real server trusts
// only Apple's root certificate, so it is covered by apps/server/test/apple-notifications.test.ts (generated PKI).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Journey } from "./run.ts";
import { until } from "./lib/check.ts";
import { type Ctx, eventsOf, sdkClient, signUp, standardCatalog } from "./lib/context.ts";
import { ROOT } from "./lib/stack.ts";

const fixture = (name: string) => JSON.parse(readFileSync(join(ROOT, `packages/contract/fixtures/webhooks/${name}.json`), "utf8")).event as Record<string, unknown>;
/** As packages/contract/test/webhook-payloads.test.ts: keys RevenueCat sends that RevenueDot cannot have (Billing metadata) or only for experiments. */
const UNSUPPORTED = new Set(["experiments", "metadata"]);
const FIXTURE_FOR = (e: Record<string, any>): string | null => {
  switch (e.type) {
    case "INITIAL_PURCHASE": return e.period_type === "TRIAL" ? "trial_started" : "initial_purchase";
    case "RENEWAL": return "renewal";
    case "CANCELLATION": return e.cancel_reason === "CUSTOMER_SUPPORT" ? "refund" : "cancellation";
    case "NON_RENEWING_PURCHASE": return "non_renewing_purchase";
    case "EXPIRATION": return "expiration";
    case "BILLING_ISSUE": return "billing_issue";
    default: return null;
  }
};
const DAY = 86400_000;

const SCENARIOS: Array<{ user: string; product: string; scenario: string; offset_days?: number; events: string[]; status: Record<string, unknown>; access: boolean }> = [
  { user: "buyer", product: "pro_monthly", scenario: "purchase", events: ["INITIAL_PURCHASE"], status: { status: "active", auto_renewal_status: "will_renew", gives_access: true }, access: true },
  { user: "trialer", product: "pro_monthly", scenario: "trial", events: ["INITIAL_PURCHASE"], status: { status: "trialing", gives_access: true }, access: true },
  { user: "converter", product: "pro_monthly", scenario: "trial_conversion", events: ["INITIAL_PURCHASE", "RENEWAL"], status: { status: "active", gives_access: true }, access: true },
  { user: "renewer", product: "pro_monthly", scenario: "renewal", offset_days: 65, events: ["INITIAL_PURCHASE", "RENEWAL", "RENEWAL"], status: { status: "active", gives_access: true }, access: true },
  { user: "canceller", product: "pro_annual", scenario: "cancel", offset_days: 10, events: ["INITIAL_PURCHASE", "CANCELLATION"], status: { auto_renewal_status: "will_not_renew", gives_access: true }, access: true },
  { user: "grace", product: "pro_monthly", scenario: "billing_issue", events: ["INITIAL_PURCHASE", "BILLING_ISSUE", "CANCELLATION"], status: { status: "in_grace_period", gives_access: true }, access: true },
  { user: "lapsed", product: "pro_monthly", scenario: "billing_issue", offset_days: 40, events: ["INITIAL_PURCHASE", "BILLING_ISSUE", "CANCELLATION", "EXPIRATION"], status: { gives_access: false }, access: false },
  { user: "refunded", product: "pro_monthly", scenario: "refund", offset_days: 2, events: ["INITIAL_PURCHASE", "CANCELLATION"], status: { gives_access: false }, access: false },
  { user: "lifetime_refunded", product: "lifetime", scenario: "refund", offset_days: 3, events: ["NON_RENEWING_PURCHASE", "CANCELLATION"], status: {}, access: false },
  { user: "expired", product: "pro_monthly", scenario: "expire", events: ["INITIAL_PURCHASE", "CANCELLATION", "EXPIRATION"], status: { gives_access: false, status: "expired" }, access: false },
];

const journey: Journey = {
  name: "lifecycle",
  title: "Lifecycle: renewal, cancellation, billing issue, expiration, refunds; webhooks key-checked; charts",
  async run(ctx: Ctx) {
    const { c } = ctx;
    const dev = await signUp(ctx, "lifecycle", "Lifecycle app");
    const cat = await standardCatalog(dev);
    const hook = await dev.v2("POST", "/integrations/webhooks", { name: "Capture", url: `${ctx.capture.base}/hooks/lifecycle-${ctx.stamp}`, authorization_header: "Bearer lifecycle-secret" });
    const sdk = sdkClient(ctx, cat.testKey);
    const tokens: Record<string, string> = {};

    for (const s of SCENARIOS) {
      c.begin(`${s.scenario}${s.offset_days ? ` (${s.offset_days} days)` : ""}: ${s.user}`);
      const user = `${s.user}_${ctx.stamp}`;
      const r = await dev.v2r("POST", "/test_purchases", { app_user_id: user, product_id: s.product, scenario: s.scenario, ...(s.offset_days !== undefined ? { offset_days: s.offset_days } : {}) });
      if (!c.check("scenario accepted (201)", r.status === 201, r.body)) continue;
      tokens[s.user] = r.body.store_transaction_id;
      c.eq("events in order", r.body.event_types, s.events);
      if (Object.keys(s.status).length) c.has("v2 subscription status", r.body.subscription, s.status);
      const info = await sdk.customerInfo(user);
      const pro = info.body.subscriber?.entitlements?.pro;
      const active = Boolean(pro && (pro.expires_date === null || Date.parse(pro.expires_date) > Date.now()));
      c.eq("SDK customer info: pro active?", active, s.access);
      const sub = info.body.subscriber?.subscriptions?.[s.product];
      if (s.scenario === "cancel") c.check("SDK subscription has unsubscribe_detected_at", typeof sub?.unsubscribe_detected_at === "string", sub);
      if (s.scenario === "billing_issue" && !s.offset_days) c.check("SDK subscription has billing_issues_detected_at and a grace period end", typeof sub?.billing_issues_detected_at === "string" && typeof sub?.grace_period_expires_date === "string", sub);
      if (s.scenario === "refund" && s.product !== "lifetime") c.check("SDK subscription has refunded_at", typeof sub?.refunded_at === "string", sub);
    }

    c.begin("every webhook delivered and key-checked against RevenueCat's samples");
    const expected = SCENARIOS.reduce((n, s) => n + s.events.length, 0);
    const delivered = await until(async () => {
      const got = ctx.capture.requests.filter((r) => r.host === "local" && r.path === `/hooks/lifecycle-${ctx.stamp}`);
      return got.length >= expected ? got : null;
    }, { timeoutMs: 90_000, everyMs: 1000 }) ?? ctx.capture.requests.filter((r) => r.path === `/hooks/lifecycle-${ctx.stamp}`);
    c.eq(`${expected} deliveries reached the endpoint`, delivered.length, expected);
    c.check("every delivery carries the Authorization header and an HMAC signature", delivered.every((d) => d.headers.authorization === "Bearer lifecycle-secret" && /t=\d+,v1=[0-9a-f]{64}/.test(d.headers["x-revenuecat-webhook-signature"] ?? "")), delivered.map((d) => d.headers["x-revenuecat-webhook-signature"]?.slice(0, 20)));
    const bodies = delivered.map((d) => JSON.parse(d.body).event as Record<string, any>);
    const problems: string[] = [];
    for (const e of bodies) {
      const name = FIXTURE_FOR(e);
      if (!name) { problems.push(`${e.type}: no sample`); continue; }
      const want = new Set(Object.keys(fixture(name)).filter((k) => !UNSUPPORTED.has(k)));
      const got = new Set(Object.keys(e));
      const missing = [...want].filter((k) => !got.has(k));
      const extra = [...got].filter((k) => !want.has(k));
      if (missing.length || extra.length) problems.push(`${e.type}/${name}: missing ${missing.join(",") || "-"} extra ${extra.join(",") || "-"}`);
      for (const [k, v] of Object.entries(e)) if (k.endsWith("_ms") && v !== null && !Number.isInteger(v)) problems.push(`${e.type}.${k} is not an integer`);
    }
    c.check("every delivered event has exactly the keys of RevenueCat's sample for its type", problems.length === 0, problems);
    const byUser = (u: string) => bodies.filter((e) => e.app_user_id === `${u}_${ctx.stamp}`);
    c.has("trial start: TRIAL period, price 0", byUser("trialer")[0], { period_type: "TRIAL", price: 0 });
    c.has("trial conversion: RENEWAL with is_trial_conversion and the paid price", byUser("converter").find((e) => e.type === "RENEWAL"), { is_trial_conversion: true, period_type: "NORMAL", price: 9.99 });
    c.has("cancellation: UNSUBSCRIBE, price 0", byUser("canceller").find((e) => e.type === "CANCELLATION"), { cancel_reason: "UNSUBSCRIBE", price: 0 });
    c.has("billing issue: grace period end a week out", byUser("grace").find((e) => e.type === "BILLING_ISSUE"), {});
    const bi = byUser("grace").find((e) => e.type === "BILLING_ISSUE");
    c.check("billing issue: grace_period_expiration_at_ms about 7 days after the event", bi && Math.abs(bi.grace_period_expiration_at_ms - bi.event_timestamp_ms - 7 * DAY) < 60_000, bi);
    c.has("lapsed: EXPIRATION with BILLING_ERROR", byUser("lapsed").find((e) => e.type === "EXPIRATION"), { expiration_reason: "BILLING_ERROR" });
    c.has("refund: CANCELLATION CUSTOMER_SUPPORT with a negative price", byUser("refunded").find((e) => e.type === "CANCELLATION"), { cancel_reason: "CUSTOMER_SUPPORT", price: -9.99 });
    c.has("one-time refund: CANCELLATION CUSTOMER_SUPPORT with a negative price", byUser("lifetime_refunded").find((e) => e.type === "CANCELLATION"), { cancel_reason: "CUSTOMER_SUPPORT", price: -149.99 });
    const dels = await dev.v2("GET", `/webhooks/${hook.id}/deliveries?limit=100`);
    c.check("the delivery log marks every one delivered with HTTP 200", dels.items.length === expected && dels.items.every((d: any) => d.status === "delivered" && d.response_status === 200), dels.items.map((d: any) => [d.event_type, d.status]));
    const stored = await eventsOf(ctx, dev.projectId);
    c.eq("the events table holds exactly the delivered events", stored.map((e) => e.id).sort(), bodies.map((e) => e.id).sort());

    c.begin("store actions on Test Store subscriptions");
    const subs = await dev.v2("GET", `/customers/buyer_${ctx.stamp}/subscriptions`);
    const cancel = await dev.v2r("POST", `/subscriptions/${subs.items[0].id}/actions/cancel`);
    c.check("v2 cancel of a Test Store subscription answers a clear 4xx (stores only: App Store, Google Play)", cancel.status >= 400 && cancel.status < 500 && /Test Store/.test(cancel.body.message), cancel.body);

    c.begin("charts reflect the lifecycle (sandbox)");
    const start = new Date(Date.now() - 80 * DAY).toISOString().slice(0, 10);
    const end = new Date().toISOString().slice(0, 10);
    const q = `environment=sandbox&resolution=month&start_date=${start}&end_date=${end}`;
    const total = (chart: any, measure = 0) => (chart.values ?? []).filter((v: any) => v.measure === measure).reduce((s: number, v: any) => s + Number(v.value), 0);
    const ledger = await ctx.sql`SELECT kind, count(*)::int AS n, coalesce(sum(revenue_usd), 0)::float8 AS usd FROM transactions WHERE project_id = ${dev.projectId} AND is_sandbox GROUP BY kind ORDER BY kind`;
    const L = Object.fromEntries(ledger.map((r) => [r.kind, r]));
    const revenue = await dev.v2("GET", `/charts/revenue?${q}`);
    const ledgerUsd = Math.round(ledger.reduce((s, r) => s + Number(r.usd), 0) * 100) / 100;
    c.eq("revenue chart total = the ledger's revenue (refunds subtracted)", Math.round(total(revenue) * 100) / 100, ledgerUsd);
    const refunds = await dev.v2("GET", `/charts/refunds?${q}`);
    c.eq("refunds chart: refunded revenue 9.99 + 149.99", Math.round(total(refunds, 0) * 100) / 100, 159.98);
    c.eq("refunds chart: two refunded transactions", total(refunds, 1), 2);
    c.check("ledger has the two refunds", (L.refund?.n ?? 0) === 2, ledger);
    const trials = await dev.v2("GET", `/charts/trials_new?${q}`);
    c.eq("new trials chart counts the two trials (trial, trial conversion)", total(trials), 2);
    const overview = await dev.v2("GET", "/metrics/overview?environment=sandbox");
    const m = (id: string) => overview.metrics.find((x: any) => x.id === id)?.value;
    c.eq("overview (sandbox): active trials = 1 (trialer)", m("active_trials"), 1);
    c.eq("overview (sandbox): active subscriptions = buyer, converter, renewer, canceller, grace", m("active_subscriptions"), 5);
  },
};
export default journey;
