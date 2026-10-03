/**
 * A second server for the Move and Billing specs (moves.spec.ts, billing.spec.ts): the real API as RevenueDot Cloud
 * (edition "cloud") on its own in-memory Postgres, with the built dashboard, on E2E_PORT + 1. Projects move from the main
 * e2e server (self-hosted) to it, and its Billing page runs against an in-process fake of RevenueDot's own Stripe account
 * (packages/contract/src/fake-billing-stripe.ts): Checkout and the Customer Portal are small local pages, and every
 * Stripe event reaches the webhook signed with the fake's secret. Stripe is never called.
 *   POST /__billing/meter     runs metering now (the Cloud tick does it hourly)
 *   POST /__billing/invoice   { email, outcome: "failed" | "paid" }: an invoice payment fails or succeeds
 *   POST /__billing/revenue   { email, usd }: a production App Store purchase of that amount in the account's first project
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { eq } from "drizzle-orm";
import { openDb, schema } from "@revenuedot/db";
import { createApp, defaultStores } from "@revenuedot/server";
import type { Mailer } from "@revenuedot/server/mail/index.js";
import { runBilling } from "@revenuedot/server/services/billing/meter.js";
import { tick } from "@revenuedot/server/services/tick.js";
import { FAKE_BILLING_KEY, FAKE_BILLING_PRICE, FAKE_BILLING_WEBHOOK_SECRET, FakeBillingStripe } from "../../../packages/contract/src/fake-billing-stripe.ts";

const CLOUD_KEY = "Y2xvdWQtZTJlLWtleS1mb3ItdGVzdHMtb25seS0xMjM=";

export async function startCloud(port: number, dist: string, mail: Mailer & { sent: { to: string }[] }) {
  // E2E_CLOUD_DATABASE_URL: a Railway development database instead of PGlite, for manual browser checks.
  const { db } = await openDb(process.env.E2E_CLOUD_DATABASE_URL ?? "pglite://memory");
  const base = `http://localhost:${port}`;
  const stripe = new FakeBillingStripe();
  stripe.checkoutUrl = `${base}/__billing/checkout/{id}`;
  stripe.portalUrl = `${base}/__billing/portal/{id}`;
  const billing = { secretKey: FAKE_BILLING_KEY, webhookSecret: FAKE_BILLING_WEBHOOK_SECRET, priceStandard: FAKE_BILLING_PRICE, meterEvent: "revenuedot_cloud_bill_cents", live: false };
  const f: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.host === "api.stripe.com") return stripe.fetch(input, init);
    if (["localhost", "127.0.0.1"].includes(url.hostname)) return fetch(input, init);
    return new Response(JSON.stringify({ error: `The e2e Cloud server does not call ${url.host}.` }), { status: 503 });
  };
  const api = createApp({ db, now: () => new Date(), fetch: f, stores: defaultStores(), mailer: mail, edition: "cloud", billing, encryptionKey: CLOUD_KEY, apiUrl: base, publicUrl: base, moveDrainSeconds: 1 });
  const send = async (type: string, object: Record<string, unknown>) => {
    const e = await stripe.event(type, object);
    await api.fetch(new Request(`${base}/v2/billing/stripe/webhook`, { method: "POST", headers: { "stripe-signature": e.signature, "content-type": "application/json" }, body: e.body }));
  };
  const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>body{font:15px/1.5 system-ui,sans-serif;max-width:440px;margin:40px auto;padding:0 20px}button{font:inherit;width:100%;padding:12px;margin:6px 0;background:#635bff;color:#fff;border:0;cursor:pointer}</style></head><body><h1>${title}</h1><p>Test only. Stripe is never called.</p>${body}</body></html>`;

  const web = new Hono();
  // The same in-memory mailer as the main e2e server: GET /__mail?to=<address>.
  web.get("/__mail", (c) => { const to = c.req.query("to"); return c.json(mail.sent.filter((m) => !to || m.to === to)); });
  web.get("/__billing/checkout/:id", (c) => {
    const s = stripe.sessions.get(c.req.param("id"));
    if (!s) return c.text("No such checkout session", 404);
    return c.html(page("Fake Stripe Checkout", `<p>RevenueDot Cloud Standard, billed monthly by usage.</p><pre data-session-metadata>${JSON.stringify({ metadata: s.metadata ?? {}, subscription: s.subscription_data?.metadata ?? {} })}</pre><form method="post"><button type="submit">Subscribe</button></form><p><a href="${s.cancel_url}">Back</a></p>`));
  });
  web.post("/__billing/checkout/:id", async (c) => {
    const id = c.req.param("id");
    const { subscription } = stripe.complete(id);
    await send("checkout.session.completed", stripe.sessions.get(id)!);
    await send("customer.subscription.created", subscription);
    return c.redirect(stripe.sessions.get(id)!.success_url, 303);
  });
  web.get("/__billing/portal/:id", (c) => {
    const s = stripe.portalSessions.find((x) => x.id === c.req.param("id"));
    if (!s) return c.text("No such portal session", 404);
    return c.html(page("Fake Stripe Customer Portal", `<form method="post"><button type="submit">Cancel plan</button></form><p><a href="${s.return_url}">Return to RevenueDot</a></p>`));
  });
  web.post("/__billing/portal/:id", async (c) => {
    const s = stripe.portalSessions.find((x) => x.id === c.req.param("id"))!;
    const sub = [...stripe.subscriptions.values()].find((x) => x.customer === s.customer)!;
    await send("customer.subscription.updated", stripe.updateSubscription(sub.id, { cancel_at_period_end: true }));
    return c.redirect(s.return_url, 303);
  });
  web.post("/__billing/meter", async (c) => c.json({ work: await runBilling({ db, now: new Date(), fetch: f, mailer: mail, publicUrl: base, config: billing, force: true }), meter: stripe.meterEvents }));
  web.post("/__billing/invoice", async (c) => {
    const b = await c.req.json() as { email: string; outcome: "failed" | "paid" };
    const [u] = await db.select().from(schema.users).where(eq(schema.users.email, b.email));
    const [acct] = await db.select().from(schema.billingAccounts).where(eq(schema.billingAccounts.userId, u!.id));
    const inv = stripe.invoice(acct!.stripeCustomerId!, { amount_due: 1250, status: b.outcome === "paid" ? "paid" : "open" });
    await send(b.outcome === "paid" ? "invoice.paid" : "invoice.payment_failed", inv);
    return c.json(inv);
  });
  web.post("/__billing/revenue", async (c) => {
    const b = await c.req.json() as { email: string; usd: number };
    const [u] = await db.select().from(schema.users).where(eq(schema.users.email, b.email));
    const [p] = await db.select().from(schema.projects).where(eq(schema.projects.ownerUserId, u!.id));
    const id = `e2e_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await db.insert(schema.customers).values({ id: `cus_${id}`, projectId: p!.id, originalAppUserId: `buyer_${id}` });
    await db.insert(schema.transactions).values({ id: `txn_${id}`, projectId: p!.id, customerId: `cus_${id}`, store: "app_store", storeTransactionId: id, productIdentifier: "pro_yearly", kind: "purchase", isSandbox: false, purchasedAt: new Date(), revenueUsd: b.usd, priceAmount: b.usd, priceCurrency: "USD" });
    return c.json({ ok: true, project: p!.id });
  });
  web.all("/*", async (c) => {
    const path = c.req.path;
    if (/^\/(v1|v2|auth|rcbilling|blobs|pay|share|verified|\.well-known)(\/|$)/.test(path)) return api.fetch(c.req.raw);
    const file = join(dist, path);
    if (path !== "/" && file.startsWith(dist) && existsSync(file) && !file.endsWith("/")) {
      const types: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2" };
      return new Response(readFileSync(file), { headers: { "content-type": types[extname(file)] ?? "application/octet-stream" } });
    }
    return c.html(readFileSync(join(dist, "index.html"), "utf8"));
  });
  serve({ fetch: web.fetch, port }).on("error", (e: NodeJS.ErrnoException) => {
    console.error(e.code === "EADDRINUSE" ? `Port ${port} (the e2e Cloud server, E2E_PORT + 1) is already in use. Set E2E_PORT to a free pair of ports.` : e);
    process.exit(1);
  });
  // Webhook deliveries and exports, like the Node entry point.
  setInterval(() => { tick(db, new Date(), f, { mailer: mail, encryptionKey: CLOUD_KEY, edition: "cloud", billing }).catch((e) => console.error("cloud tick failed", e)); }, 5_000);
  console.log(`E2E Cloud server on ${base}`);
  return { db, stripe, base };
}
