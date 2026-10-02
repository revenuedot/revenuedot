/**
 * The end-to-end test server: the real API on an in-memory Postgres (PGlite) plus the built dashboard, on one port.
 *   tsx e2e/server.ts            (after `vite build`; PORT defaults to 5199)
 * It seeds one demo account (e2e@revenuedot.test / e2e-password-1) with:
 * - API-made data (e2e/seed.ts): Test Store catalog, ~40 sandbox customers, attributes, a grant and an offering override.
 * - App Store production history that the API cannot make (the Test Store has no trials, renewals or refunds):
 *   verified purchases go through the server's own purchase pipeline with the clock set back, exactly as if Apple's
 *   notifications had arrived on those days, so events, transactions and webhooks are the real ones.
 * A second account (fresh@revenuedot.test / e2e-password-1) has an empty project for the first-run checklist.
 * Every email the server sends is kept in memory and listed at GET /__mail?to=<address> (account-email.spec.ts).
 * Web billing (web.spec.ts): Stripe calls with FAKE_STRIPE_KEY go to an in-memory Stripe account whose Checkout Sessions
 * open GET /__stripe/checkout/<id>, a fake "Stripe Checkout" page whose Pay button completes the session and redirects
 * (303) to its success_url. Custom domain checks read DNS from POST /__dns instead of Cloudflare's resolver.
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { openDb, schema } from "@revenuedot/db";
import { createApp, defaultStores } from "@revenuedot/server";
import { loadExtensions } from "@revenuedot/server/extensions.js";
import { memoryMailer } from "@revenuedot/server/mail/index.js";
import { getOrCreateCustomer, touch } from "@revenuedot/server/repo/customers.js";
import { applyPurchases } from "@revenuedot/server/services/purchases.js";
import { tick } from "@revenuedot/server/services/tick.js";
import type { VerifiedPurchase } from "@revenuedot/server/stores/types.js";
import { eq } from "drizzle-orm";
import { client, seedProject, session } from "./seed.ts";
import { startCloud } from "./cloud-server.ts";
import { fakeStores, storeCatalogFetch, webStripe } from "./store-fakes.ts";
import { fakeModel } from "@revenuedot/server/services/paywall-ai.js";
import { fakeAssistantModel } from "@revenuedot/server/services/assistant/fake-model.js";

const PORT = Number(process.env.PORT ?? 5199);
const DIST = new URL("../dist", import.meta.url).pathname;
const DAY = 86400_000;

// E2E_DATABASE_URL runs the same server on a real Postgres (a Railway development database) for manual browser checks.
const { db } = await openDb(process.env.E2E_DATABASE_URL ?? "pglite://memory");
// Enterprise features (src/extensions.ts) only when the run asks for them: REVENUEDOT_EE_DEV=true (ee/e2e specs).
const extensions = await loadExtensions(process.env);
// The run never reaches Apple, Google or any other outside host: only this machine (fake partners, buckets) answers.
// A credential a spec saves (a made-up Google service account) then fails like an outage instead of calling Google.
// Custom domain verification asks Cloudflare's DNS-over-HTTPS resolver; here it answers from records set with POST /__dns.
const dns: Record<string, { CNAME?: string[]; TXT?: string[] }> = {};
const localFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return fetch(input, init);
  // Store import (store-import.spec.ts): App Store Connect and Google Play answer from fakes for the e2e credentials only.
  const store = await storeCatalogFetch(url.href, init ?? {});
  if (store) return store;
  // E2E_REAL_STORES=1, for a manual check with real sandbox keys: App Store Connect and Google Play are called for real,
  // read-only. Anything but a GET (and Google's OAuth token request) is refused, so nothing in a store can change.
  if (process.env.E2E_REAL_STORES === "1" && ["api.appstoreconnect.apple.com", "androidpublisher.googleapis.com", "oauth2.googleapis.com"].includes(url.hostname)) {
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (method === "GET" || url.href === "https://oauth2.googleapis.com/token") return fetch(input, init);
    return new Response(JSON.stringify({ error: `The e2e server is read-only against real stores (${method} ${url.host} refused).` }), { status: 403, headers: { "content-type": "application/json" } });
  }
  if (url.href.startsWith("https://cloudflare-dns.com/dns-query")) {
    const name = url.searchParams.get("name")!, type = url.searchParams.get("type") as "CNAME" | "TXT";
    const data = dns[name]?.[type] ?? [];
    return new Response(JSON.stringify({ Status: 0, Answer: data.map((d) => ({ name, type: type === "CNAME" ? 5 : 16, TTL: 60, data: type === "TXT" ? `"${d}"` : `${d}.` })) }), { headers: { "content-type": "application/dns-json" } });
  }
  return new Response(JSON.stringify({ error: `The e2e server does not call ${url.host}.` }), { status: 503, headers: { "content-type": "application/json" } });
};
let clock: Date | null = null;
const now = () => clock ?? new Date();
// Webhook deliveries and expirations run like the Node entry point, once seeding is done (setup.spec.ts checks deliveries).
let ticking = false;
// A fixed sealing key, for the API and the background tick alike: integration secrets are encrypted with it (deliveries
// unseal them in the tick), and Auth (prd/auth) derives its token key from it.
const SEALING_KEY = "ZTJlLWlkZW50aXR5LWtleS1mb3ItdGVzdHMtb25seSE=";
const runTick = async () => {
  if (!ready || ticking) return;
  ticking = true;
  try { await tick(db, now(), localFetch, { mailer: mail, encryptionKey: SEALING_KEY, extensions }); } catch (e) { console.error("tick failed", e); } finally { ticking = false; }
};
setInterval(runTick, 5_000);
// Emails (password resets, invites, alerts) are kept in memory; specs read them from GET /__mail?to=<address>.
const mail = memoryMailer();
// Amazon and Stripe answer from in-process fakes (store-fakes.ts): the e2e run never calls them.
// "Generate with AI" answers from a fake model (no network): a paywall whose headline echoes the request, written the
// sloppy way a real model sometimes does, so the server's repair runs. E2E_AI=off turns the generator off.
const fakeAi = process.env.E2E_AI === "off" ? undefined : fakeModel((_system, user) => {
  // "Build with AI" for funnels: a short quiz whose question echoes the request.
  const funnelAsk = /Funnel request: (.*)/.exec(user)?.[1]?.slice(0, 60);
  if (funnelAsk) return "```json\n" + JSON.stringify({
    theme: { background: "#FFFFFF", text: "#0A0A0A", accent: "#0A0A0A", button_text: "#FFFFFF", corner_radius: 0 },
    steps: [
      { id: "goal", type: "question", title: `AI: ${funnelAsk}`, options: [{ id: "a", label: "Sleep longer" }, { id: "b", label: "Fall asleep faster" }], attribute: "goal" },
      { id: "email", type: "email", title: "Where should we send your plan?", placeholder: "you@example.com", required: true },
      { id: "paywall", type: "paywall", title: "Start your free week", features: ["Daily plan", "Sleep sounds"], allow_codes: true, button_label: "Continue" },
      { id: "success", type: "success", title: "You are in", body: "Open the app to start.", show_redemption: true },
    ],
  }) + "\n```";
  const ask = /Paywall request: (.*)/.exec(user)?.[1]?.slice(0, 60) ?? "Go Pro";
  return "Here is your paywall:\n```json\n" + JSON.stringify({
    name: "AI paywall", background: "#0f172a",
    components: [
      { type: "title", text: `AI: ${ask}`, color: "#ffffff" },
      { type: "text", text: "Everything you need, nothing you don't.", color: "#cbd5e1", font_size: "body" },
      { type: "features", items: [{ icon: "sparkles", text: "Smart suggestions" }, { icon: "cloud", text: "Backup and sync" }, "No ads"] },
      { type: "timeline", items: [{ icon: "unlock", title: "Today", description: "Full access" }, { icon: "bell", title: "Day 5", description: "A reminder" }] },
      { type: "packages" },
    ],
    footer: [{ type: "cta", text: "Start free trial" }, { type: "button", action: "restore" }],
  }) + "\n```";
});
// RevenueDot AI answers from a scripted fake model (services/assistant/fake-model.ts): "how is revenue doing" calls
// get-metrics, "grant pro to <user>" asks for approval, then grants. Conversations stream over SSE from the database.
const fakeAssistant = process.env.E2E_AI === "off" ? undefined : fakeAssistantModel(undefined, { delayMs: 15 });
const api = createApp({ db, now, fetch: localFetch, stores: { ...defaultStores(), ...fakeStores() }, mailer: mail, kick: () => { setTimeout(runTick, 100); }, ai: fakeAi, assistant: fakeAssistant, assistantRuntime: "sse", encryptionKey: SEALING_KEY, moveDrainSeconds: 1, extensions });

let ready = false;
const web = new Hono();
// Playwright waits for this: 503 while seeding, 200 once the data is in.
web.get("/__ready", (c) => (ready ? c.text("ready") : c.text("seeding", 503)));
web.get("/__mail", (c) => { const to = c.req.query("to"); return c.json(mail.sent.filter((m) => !to || m.to === to)); });
// Store import (store-import.spec.ts): products and prices in the in-memory Stripe account, as if made in Stripe's dashboard.
web.post("/__stripe/seed", async (c) => {
  const b = await c.req.json() as { products?: Record<string, unknown>[]; prices?: Record<string, unknown>[] };
  for (const p of b.products ?? []) webStripe.products.set(String(p.id), { object: "product", active: true, livemode: false, default_price: null, metadata: {}, ...p });
  for (const p of b.prices ?? []) webStripe.prices.set(String(p.id), { object: "price", active: true, livemode: false, billing_scheme: "per_unit", metadata: {}, ...p });
  return c.json({ ok: true });
});
web.post("/__dns", async (c) => { const b = await c.req.json() as { name: string; CNAME?: string[]; TXT?: string[] }; dns[b.name] = { CNAME: b.CNAME, TXT: b.TXT }; return c.json({ ok: true }); });
// A minimal stand-in for Stripe's hosted Checkout page (never Stripe itself).
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
web.get("/__stripe/checkout/:id", (c) => {
  const s = webStripe.sessions.get(c.req.param("id"));
  if (!s) return c.text("No such checkout session", 404);
  const item = s.line_items.data[0];
  const amount = `${(item.price.unit_amount / 100).toFixed(2)} ${String(item.price.currency).toUpperCase()}`;
  const discount = s.discounts?.[0] ? `<p data-discount>Discount applied (${esc(s.discounts[0].promotion_code ?? s.discounts[0].coupon)})</p>` : "";
  return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fake Stripe Checkout</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:420px;margin:40px auto;padding:0 20px}input,button{font:inherit;width:100%;padding:12px;margin:6px 0;box-sizing:border-box}button{background:#635bff;color:#fff;border:0;cursor:pointer}</style></head>
<body><h1>Fake Stripe Checkout</h1><p>Test only. No card is charged and Stripe is never called.</p>
<p>${esc(s.mode === "subscription" ? "Subscription" : "One-time payment")}: <b data-amount>${esc(amount)}</b>${s.subscription_data?.trial_period_days ? ` after a ${esc(s.subscription_data.trial_period_days)}-day trial` : ""}</p>${discount}
<form method="post"><label>Email <input name="email" type="email" value="${esc(s.customer_email ?? "")}" placeholder="buyer@example.com"></label><button type="submit">Pay</button></form>
${s.cancel_url ? `<p><a href="${esc(s.cancel_url)}">Back</a></p>` : ""}</body></html>`);
});
web.post("/__stripe/checkout/:id", async (c) => {
  const s = webStripe.sessions.get(c.req.param("id"));
  if (!s) return c.text("No such checkout session", 404);
  const form = await c.req.parseBody();
  const email = typeof form.email === "string" && form.email.trim() ? form.email.trim() : undefined;
  webStripe.complete(s.id, { email });
  return c.redirect(s.success_url, 303);
});
web.all("/*", async (c) => {
  const path = c.req.path;
  if (/^\/(v1|v2|auth|rcbilling|blobs|pay|share|verified|sso|scim|\.well-known)(\/|$)/.test(path)) return api.fetch(c.req.raw);
  const file = join(DIST, path);
  // Paywall assets and icons (/assets/{project}/{object}, /assets/icons/{name}) share /assets with the dashboard build.
  if (path.startsWith("/assets/") && !existsSync(file)) return api.fetch(c.req.raw);
  if (path !== "/" && file.startsWith(DIST) && existsSync(file) && !file.endsWith("/")) {
    const types: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2" };
    return new Response(readFileSync(file), { headers: { "content-type": types[extname(file)] ?? "application/octet-stream" } });
  }
  return c.html(readFileSync(join(DIST, "index.html"), "utf8"));
});
if (!existsSync(join(DIST, "index.html"))) { console.error(`No dashboard build at ${DIST}. Run vite build first.`); process.exit(1); }
serve({ fetch: web.fetch, port: PORT });
const base = `http://localhost:${PORT}`;
// RevenueDot Cloud for the Move and Billing specs (e2e/cloud-server.ts): E2E_PORT + 1.
await startCloud(PORT + 1, DIST, mail);
webStripe.checkoutUrl = `${base}/__stripe/checkout/{id}`;

// E2E_SEED=off (manual checks on a Railway database, which keeps its data across restarts): no demo data. The module
// then waits forever here while the server and the tick keep running.
if (process.env.E2E_SEED === "off") {
  ready = true;
  console.log(`E2E server ready on ${base} (no demo data)`);
  await new Promise(() => {});
}

// 1. API-made demo data.
const cookie = await session(base, "e2e@revenuedot.test", "e2e-password-1", "Scanner");
const me = await (await fetch(`${base}/auth/me`, { headers: { cookie } })).json() as { projects: { id: string }[] };
const projectId = me.projects[0]!.id;
const seeded = await seedProject(base, cookie, projectId, { customers: 40 });
await session(base, "fresh@revenuedot.test", "e2e-password-1", "Empty project");

// 2. App Store production history through the purchase pipeline.
const call = client(base, cookie);
const P = `/v2/projects/${projectId}`;
const ios = await call("POST", `${P}/apps`, { name: "Scanner iOS", type: "app_store", app_store: { bundle_id: "com.example.scanner" } });
const iosProducts: Record<string, { id: string; duration: string; price: number }> = {};
for (const [sid, name, duration, price] of [["scanner.pro.weekly", "Pro weekly", "P1W", 4.99], ["scanner.pro.monthly", "Pro monthly", "P1M", 9.99], ["scanner.pro.yearly", "Pro yearly", "P1Y", 39.99]] as const) {
  const p = await call("POST", `${P}/products`, { store_identifier: sid, app_id: ios.id, type: "subscription", display_name: name, subscription: { duration } });
  iosProducts[sid] = { id: p.id, duration, price };
}
await call("POST", `${P}/entitlements/${seeded.entitlementId}/actions/attach_products`, { product_ids: Object.values(iosProducts).map((p) => p.id) });
await db.update(schema.apps).set({ lastNotificationAt: new Date(Date.now() - 4000) }).where(eq(schema.apps.id, ios.id));

const add = (d: Date, iso: string) => { const x = new Date(d); const n = Number(iso.slice(1, -1)); const u = iso.slice(-1); if (u === "W") x.setUTCDate(x.getUTCDate() + 7 * n); else if (u === "D") x.setUTCDate(x.getUTCDate() + n); else if (u === "M") x.setUTCMonth(x.getUTCMonth() + n); else x.setUTCFullYear(x.getUTCFullYear() + n); return x; };
type Step = { at: Date; sub: Partial<VerifiedPurchase> & Record<string, unknown> };

/** One App Store subscription chain: optional 7-day trial, then paid periods until `until`, with an optional ending. */
async function chain(user: string, sid: string, start: Date, opts: { trial?: boolean; periods: number; country: string; refundAfter?: number; cancelAt?: Date; billingIssue?: boolean }) {
  const prod = iosProducts[sid]!;
  const key = `2000000${Math.floor(Math.random() * 1e9)}`;
  clock = start;
  const { customer } = await getOrCreateCustomer(db, projectId, user, start);
  await touch(db, customer.id, start, { platform: "iOS", appVersion: "3.4.1", country: opts.country });
  const steps: Step[] = [];
  let periodStart = start;
  let n = 0;
  const base = { kind: "subscription", store: "app_store", storeKey: key, productIdentifier: sid, isSandbox: false, originalPurchaseDate: start, originalTransactionId: key, countryCode: opts.country } as const;
  if (opts.trial) {
    const end = add(start, "P7D");
    steps.push({ at: start, sub: { ...base, purchaseDate: start, expiresDate: end, periodType: "trial", storeTransactionId: `${key}0`, price: { amount: 0, currency: "USD" } } });
    periodStart = end;
  }
  for (let i = 0; i < opts.periods; i++) {
    const end = add(periodStart, prod.duration);
    if (periodStart.getTime() > Date.now()) break;
    n++;
    steps.push({ at: periodStart, sub: { ...base, purchaseDate: periodStart, expiresDate: end, periodType: "normal", storeTransactionId: `${key}${n}`, price: { amount: prod.price, currency: "USD" } } });
    periodStart = end;
  }
  let last = steps[steps.length - 1]!;
  for (const s of steps) { clock = s.at; await applyPurchases(db, customer, [s.sub as VerifiedPurchase], { projectId, appId: ios.id, appUserId: user, now: s.at, fromDevice: false }); }
  if (opts.cancelAt) { clock = opts.cancelAt; await applyPurchases(db, customer, [{ ...last.sub, unsubscribeDetectedAt: opts.cancelAt } as VerifiedPurchase], { projectId, appId: ios.id, appUserId: user, now: opts.cancelAt, fromDevice: false }); last = { ...last, sub: { ...last.sub, unsubscribeDetectedAt: opts.cancelAt } }; }
  if (opts.refundAfter !== undefined) { const at = new Date(last.at.getTime() + opts.refundAfter * DAY); clock = at; await applyPurchases(db, customer, [{ ...last.sub, refundedAt: at } as VerifiedPurchase], { projectId, appId: ios.id, appUserId: user, now: at, fromDevice: false }); }
  if (opts.billingIssue) { const at = new Date((last.sub.expiresDate as Date).getTime() + 3600_000); if (at.getTime() < Date.now()) { clock = at; await applyPurchases(db, customer, [{ ...last.sub, billingIssuesDetectedAt: at, gracePeriodExpiresDate: new Date(at.getTime() + 16 * DAY) } as VerifiedPurchase], { projectId, appId: ios.id, appUserId: user, now: at, fromDevice: false }); } }
  clock = null;
  return customer;
}

const ago = (d: number) => new Date(Date.now() - d * DAY);
const people: [string, string, Parameters<typeof chain>[3] & { at: number; sid: string }][] = [
  ["wjqx8kd2rn1", "US", { at: 80, sid: "scanner.pro.weekly", trial: true, periods: 20 }],
  ["m8f6gmi3", "DE", { at: 5, sid: "scanner.pro.weekly", trial: true, periods: 0 }],
  ["ne45gd13", "MX", { at: 62, sid: "scanner.pro.monthly", trial: false, periods: 5 }],
  ["k2aa91qe", "FR", { at: 34, sid: "scanner.pro.monthly", trial: false, periods: 3, billingIssue: true }],
  ["pbg6xs2d", "BR", { at: 20, sid: "scanner.pro.yearly", trial: true, periods: 1, refundAfter: 2 }],
  ["zr7m0plw", "GB", { at: 45, sid: "scanner.pro.weekly", trial: false, periods: 10, cancelAt: ago(3) }],
  ["c1tdha8u", "CA", { at: 2, sid: "scanner.pro.yearly", trial: false, periods: 1 }],
  ["hana_ios", "JP", { at: 3, sid: "scanner.pro.monthly", trial: true, periods: 1 }],
  ["oliver_ios", "US", { at: 88, sid: "scanner.pro.monthly", trial: true, periods: 4 }],
  ["sofia_ios", "ES", { at: 12, sid: "scanner.pro.weekly", trial: true, periods: 1 }],
];
const customerIds: Record<string, string> = {};
for (const [user, country, o] of people) {
  const c = await chain(user, o.sid, ago(o.at), { ...o, country });
  customerIds[user] = c.id;
  if (user === "wjqx8kd2rn1") {
    await call("POST", `${P}/customers/${user}/attributes`, { attributes: [{ name: "$email", value: "wren@example.com" }, { name: "$displayName", value: "Wren" }, { name: "$mediaSource", value: "Apple Search Ads" }, { name: "$campaign", value: "fall_launch" }, { name: "$idfv", value: "7B4E1C2A-19F2-4E0B-9C0F-2D4A7B1E9A11" }, { name: "plan_source", value: "paywall_v3" }] });
    await touch(db, c.id, new Date(Date.now() - 90_000), { platform: "iOS", appVersion: "3.4.1", country: "US" });
  }
}
await seedLifecycle();
await seedAds();
ready = true;
console.log(`E2E server ready on ${base} (project ${projectId})`);

/**
 * 3. Lifecycle demo data (prd/lifecycle/PRD.md), written straight to the tables because Apple's CONSUMPTION_REQUEST,
 * Customer Center tickets and churn need real store traffic: two lapsed App Store subscribers, emails on churned
 * customers (win-back previews find them), refund policies and requests over the last 28 days, a Customer Center
 * retention offer and two support tickets.
 */
async function seedLifecycle() {
  for (const [user, country, o] of [
    ["lena_ios", "DE", { at: 50, sid: "scanner.pro.weekly", trial: false, periods: 4 }],
    ["ravi_ios", "IN", { at: 75, sid: "scanner.pro.monthly", trial: true, periods: 1, cancelAt: ago(60) }],
  ] as const) customerIds[user] = (await chain(user, o.sid, ago(o.at), { ...o, country })).id;
  const at = Date.now();
  for (const [user, email] of [["pbg6xs2d", "bruna@example.com"], ["zr7m0plw", "zoe.r@example.com"], ["lena_ios", "lena@example.com"], ["ravi_ios", "ravi@example.com"]] as const) {
    await db.insert(schema.customerAttributes).values({ customerId: customerIds[user]!, key: "$email", value: email, updatedAtMs: at }).onConflictDoNothing();
  }
  const policies = [
    { id: "rfp_e2erenewal1", name: "Renewed in the last day", template: "recent_renewal", rules: { groups: [{ conditions: [{ field: "lastRenewalAt", operator: "within", value: "24h" }] }] }, preference: "prefer_refund", position: 0 },
    { id: "rfp_e2eloyal001", name: "Spent over $40", template: "custom", rules: { groups: [{ conditions: [{ field: "totalSpent", operator: "greaterThan", value: "40" }] }] }, preference: "prefer_no_refund", position: 1 },
  ];
  for (const p of policies) await db.insert(schema.refundPolicies).values({ ...p, projectId, createdAt: ago(30) });
  const prefs: Record<string, string> = { rfp_e2erenewal1: "prefer_refund", rfp_e2eloyal001: "prefer_no_refund" };
  const requests: [string, string, number, number, "approved" | "declined" | "pending", "sent" | "skipped" | "pending", string | null, string][] = [
    // pbg6xs2d's refund is already a request row: the purchase pipeline records every refund it sees.
    ["lena_ios", "scanner.pro.weekly", 4.99, 23, "approved", "sent", "rfp_e2erenewal1", "UNINTENDED_PURCHASE"],
    ["wjqx8kd2rn1", "scanner.pro.weekly", 4.99, 24, "declined", "sent", "rfp_e2eloyal001", "UNSATISFIED_WITH_PURCHASE"],
    ["ne45gd13", "scanner.pro.monthly", 9.99, 19, "declined", "sent", "rfp_e2eloyal001", "OTHER"],
    ["oliver_ios", "scanner.pro.monthly", 9.99, 15, "declined", "sent", "rfp_e2eloyal001", "UNSATISFIED_WITH_PURCHASE"],
    ["sofia_ios", "scanner.pro.weekly", 4.99, 8, "approved", "sent", null, "FULFILLMENT_ISSUE"],
    ["c1tdha8u", "scanner.pro.yearly", 39.99, 6, "declined", "skipped", null, "UNSATISFIED_WITH_PURCHASE"],
    ["k2aa91qe", "scanner.pro.monthly", 9.99, 2, "pending", "sent", "rfp_e2eloyal001", "UNINTENDED_PURCHASE"],
    ["zr7m0plw", "scanner.pro.weekly", 4.99, 0.2, "pending", "pending", null, "OTHER"],
  ];
  for (const [i, [user, product, amount, daysAgo, outcome, status, policyId, reason]] of requests.entries()) {
    const requestedAt = ago(daysAgo);
    const policy = policies.find((p) => p.id === policyId);
    const preference = policyId ? prefs[policyId]! : "consumption_only";
    await db.insert(schema.refundRequests).values({
      id: `rfr_e2e${String(i).padStart(9, "0")}`, projectId, appId: ios.id, customerId: customerIds[user] ?? null, appUserId: user, store: "app_store", isSandbox: false,
      transactionId: `3000000${i}${Math.floor(daysAgo * 1000)}`, originalTransactionId: `3000000${i}`, productId: product, amountUsd: amount, reason,
      requestedAt, deadlineAt: new Date(requestedAt.getTime() + 12 * 3600_000), policyId, policyName: policy?.name ?? "Default policy", preference,
      consumptionStatus: status, consumption: status === "sent" ? { consumptionStatus: 2, customerConsented: true, deliveryStatus: 0, platform: 1, refundPreference: preference === "prefer_refund" ? 1 : preference === "prefer_no_refund" ? 2 : 0 } : null,
      attempts: status === "sent" ? 1 : 0, sentAt: status === "sent" ? new Date(requestedAt.getTime() + 60_000) : null,
      lastError: status === "skipped" ? "Customers have not consented to sharing consumption data." : null,
      nextAttemptAt: status === "pending" ? new Date(Date.now() + 86400_000) : null,
      outcome, outcomeAt: outcome === "pending" ? null : new Date(requestedAt.getTime() + 2 * 86400_000 > Date.now() ? Date.now() : requestedAt.getTime() + 2 * 86400_000),
      createdAt: requestedAt,
    });
  }
  await db.insert(schema.retentionOffers).values({
    id: "rto_e2ecancel01", projectId, trigger: "cancel", name: "Half off for 3 months", title: "Wait! Stay for 50% off", subtitle: "Keep Pro for half the price for three months.",
    store: "app_store", productMapping: { "scanner.pro.monthly": "pro_monthly_50off", "scanner.pro.yearly": "pro_yearly_50off" }, active: true, createdAt: ago(10),
  });
  await db.insert(schema.supportTickets).values([
    { id: "tkt_e2eopen000000001", projectId, appId: ios.id, customerId: customerIds.wjqx8kd2rn1!, appUserId: "wjqx8kd2rn1", customerEmail: "wren@example.com",
      description: "I was charged twice for the weekly plan this morning. Can you refund one of the charges? My receipts both say Pro weekly.", emailedTo: null, createdAt: new Date(Date.now() - 3 * 3600_000) },
    { id: "tkt_e2eclosed0000001", projectId, appId: ios.id, customerId: customerIds.hana_ios!, appUserId: "hana_ios", customerEmail: "hana@example.com",
      description: "How do I restore my purchase on a new iPad?", status: "closed", emailedTo: null, createdAt: ago(4), closedAt: ago(3) },
  ]);
}

/**
 * 4. Ads demo data (prd/ads/PRD.md): 40 days of SDK ad events from the App Store app (AdMob mediation with AdMob,
 * AppLovin and Unity Ads; banner, interstitial and rewarded; USD and EUR revenue), AdMob ad unit names, an in-app
 * currency with a reward rule, and verified rewards in the ledger. Events are written straight to `sdk_events`, the
 * rows POST /v1/events stores, because the SDK would send thousands of them.
 */
async function seedAds() {
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const units = [
    { id: "ca-app-pub-3940256099942544/2934735716", name: "Home banner", format: "banner", placement: "home", ecpm: 0.6 },
    { id: "ca-app-pub-3940256099942544/4411468910", name: "Scan finished interstitial", format: "interstitial", placement: "scan_finished", ecpm: 7.5 },
    { id: "ca-app-pub-3940256099942544/1712485313", name: "Extra scans reward", format: "rewarded", placement: "out_of_scans", ecpm: 14 },
  ];
  const networks = [["Google AdMob", 0.55, "USD"], ["AppLovin", 0.3, "USD"], ["Unity Ads", 0.15, "EUR"]] as const;
  const users = ["wjqx8kd2rn1", "m8f6gmi3", "ne45gd13", "sofia_ios", "hana_ios", ...Array.from({ length: 25 }, (_, i) => `$RCAnonymousID:ads${String(i).padStart(4, "0")}`)];
  const rows: (typeof schema.sdkEvents.$inferInsert)[] = [];
  let n = 0;
  const event = (type: string, at: number, u: (typeof units)[number], net: (typeof networks)[number], extra: Record<string, unknown> = {}) => {
    const id = `ad-e2e-${String(n++).padStart(7, "0")}`;
    const user = users[Math.floor(rnd() * users.length)]!;
    rows.push({ projectId, id, appId: ios.id, customerId: customerIds[user] ?? null, appUserId: user, type, isSandbox: false, occurredAt: new Date(at), receivedAt: new Date(at),
      payload: { id, version: 1, type, app_user_id: user, app_session_id: "s", timestamp_ms: at, capture_method: "adapter", network_name: net[0], mediator_name: "AdMob", ad_format: u.format, placement: u.placement, ad_unit_id: u.id, impression_id: id, ...extra } });
  };
  for (let d = 39; d >= 0; d--) {
    const day = Date.now() - d * DAY;
    const volume = Math.round(18 + 10 * Math.sin(d / 4) + (39 - d) * 0.6);
    for (let k = 0; k < volume; k++) {
      const u = units[rnd() < 0.5 ? 0 : rnd() < 0.6 ? 1 : 2]!;
      const r = rnd();
      const net = r < networks[0][1] ? networks[0] : r < networks[0][1] + networks[1][1] ? networks[1] : networks[2];
      const at = day - Math.floor(rnd() * 20 * 3600_000);
      if (at > Date.now()) continue;
      event("rc_ads_ad_loaded", at - 2000, u, net);
      event("rc_ads_ad_displayed", at, u, net);
      const micros = Math.round(((u.ecpm * (0.6 + rnd() * 0.8)) / 1000) * 1e6 * (net[2] === "EUR" ? 0.92 : 1));
      event("rc_ads_ad_revenue", at + 50, u, net, { revenue_micros: micros, currency: net[2], precision: net[0] === "Google AdMob" ? "exact" : "estimated" });
      if (rnd() < 0.03) event("rc_ads_ad_opened", at + 4000, u, net);
      if (rnd() < 0.08) event("rc_ads_ad_failed_to_load", at - 5000, u, net, { mediator_error_code: 3 });
    }
  }
  for (let i = 0; i < rows.length; i += 500) await db.insert(schema.sdkEvents).values(rows.slice(i, i + 500)).onConflictDoNothing();
  for (const u of units) await db.insert(schema.adUnits).values({ projectId, network: "admob", adUnitId: u.id, accountId: "pub-3940256099942544", networkAppId: "ca-app-pub-3940256099942544~1458002511", displayName: u.name, format: u.format }).onConflictDoNothing();
  await call("POST", `${P}/virtual_currencies`, { code: "SCANS", name: "Extra scans", description: "Scans beyond the free limit" });
  await call("POST", `${P}/ads/reward_rules`, { name: "Extra scans for a rewarded ad", kind: "virtual_currency", currency_code: "SCANS", amount: 5, ad_unit_id: units[2]!.id });
  await call("POST", `${P}/ads/reward_rules`, { name: "A day of Pro for the weekend ad", kind: "entitlement", entitlement_id: "pro", duration_minutes: 1440, reward_item: "pro_day", enabled: false });
  for (const user of ["sofia_ios", "hana_ios", "m8f6gmi3"]) await call("POST", `${P}/ads/reward_verifications/test`, { app_user_id: user, ad_unit_id: units[2]!.id, reward_item: "scans", reward_amount: 5 });
}
