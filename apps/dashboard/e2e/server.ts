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
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { openDb, schema } from "@revenuedot/db";
import { createApp, defaultStores } from "@revenuedot/server";
import { memoryMailer } from "@revenuedot/server/mail/index.js";
import { getOrCreateCustomer, touch } from "@revenuedot/server/repo/customers.js";
import { applyPurchases } from "@revenuedot/server/services/purchases.js";
import { tick } from "@revenuedot/server/services/tick.js";
import type { VerifiedPurchase } from "@revenuedot/server/stores/types.js";
import { eq } from "drizzle-orm";
import { client, seedProject, session } from "./seed.ts";
import { fakeStores } from "./store-fakes.ts";
import { fakeModel } from "@revenuedot/server/services/paywall-ai.js";

const PORT = Number(process.env.PORT ?? 5199);
const DIST = new URL("../dist", import.meta.url).pathname;
const DAY = 86400_000;

const { db } = await openDb("pglite://memory");
let clock: Date | null = null;
const now = () => clock ?? new Date();
// Webhook deliveries and expirations run like the Node entry point, once seeding is done (setup.spec.ts checks deliveries).
let ticking = false;
const runTick = async () => {
  if (!ready || ticking) return;
  ticking = true;
  try { await tick(db, now(), fetch, { mailer: mail }); } catch (e) { console.error("tick failed", e); } finally { ticking = false; }
};
setInterval(runTick, 5_000);
// Emails (password resets, invites, alerts) are kept in memory; specs read them from GET /__mail?to=<address>.
const mail = memoryMailer();
// Amazon and Stripe answer from in-process fakes (store-fakes.ts): the e2e run never calls them.
// "Generate with AI" answers from a fake model (no network): a paywall whose headline echoes the request, written the
// sloppy way a real model sometimes does, so the server's repair runs. E2E_AI=off turns the generator off.
const fakeAi = process.env.E2E_AI === "off" ? undefined : fakeModel((_system, user) => {
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
const api = createApp({ db, now, stores: { ...defaultStores(), ...fakeStores() }, mailer: mail, kick: () => { setTimeout(runTick, 100); }, ai: fakeAi });

let ready = false;
const web = new Hono();
// Playwright waits for this: 503 while seeding, 200 once the data is in.
web.get("/__ready", (c) => (ready ? c.text("ready") : c.text("seeding", 503)));
web.get("/__mail", (c) => { const to = c.req.query("to"); return c.json(mail.sent.filter((m) => !to || m.to === to)); });
web.all("/*", async (c) => {
  const path = c.req.path;
  if (/^\/(v1|v2|auth|rcbilling|blobs)(\/|$)/.test(path)) return api.fetch(c.req.raw);
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
for (const [user, country, o] of people) {
  const c = await chain(user, o.sid, ago(o.at), { ...o, country });
  if (user === "wjqx8kd2rn1") {
    await call("POST", `${P}/customers/${user}/attributes`, { attributes: [{ name: "$email", value: "wren@example.com" }, { name: "$displayName", value: "Wren" }, { name: "$mediaSource", value: "Apple Search Ads" }, { name: "$campaign", value: "fall_launch" }, { name: "$idfv", value: "7B4E1C2A-19F2-4E0B-9C0F-2D4A7B1E9A11" }, { name: "plan_source", value: "paywall_v3" }] });
    await touch(db, c.id, new Date(Date.now() - 90_000), { platform: "iOS", appVersion: "3.4.1", country: "US" });
  }
}
ready = true;
console.log(`E2E server ready on ${base} (project ${projectId})`);
