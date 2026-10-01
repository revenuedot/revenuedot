import { Hono, type Context } from "hono";
import { and, eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { DEFAULT_THEME, purchaseLinkFunnel, renderFunnelPage, renderMessagePage, type FunnelDoc, type PagePackage, type PaywallStep } from "@revenuedot/core/funnels";
import type { AppRecord, Deps } from "../context.js";
import { publicOrigin } from "./oauth.js";
import { clientIp, hit } from "../services/rate-limit.js";
import { stripeKeyHintOf } from "../services/store-secrets.js";
import { lookOf, stripeAppsOf, webConfigOf, type WebConfig } from "../services/web/config.js";
import { offeringByKey, webPackages } from "../services/web/catalog.js";
import { CheckoutError, completeWebCheckout, deepLinkFor, redeemUrlFor, startCheckout, tokenFor } from "../services/web/checkout.js";
import { DiscountRefused, discountForCheckout } from "../services/web/discounts.js";
import { payBaseOf } from "../services/web/domains.js";
import { FUNNEL_EVENT_TYPES, recordFunnelEvent } from "../services/web/funnels.js";
import { sha256Hex } from "../services/auth.js";

/**
 * Hosted web pages (prd/web-billing/PRD.md §2–§5), no sign-in: purchase links and funnels at `/pay/<project>/<slug>`, their
 * success pages, redemption link pages at `/pay/r/<token>`, and the three calls the pages make (`/pay/api/…`). The same
 * routes answer on the pay host (REVENUEDOT_PAY_URL without a path) and on verified custom domains: app.ts rewrites those
 * requests here and records how links must be built (PAY_CTX).
 */

/** How a rewritten request's links are built: the base of `/api` and `/r`, and the project's page base. Set by app.ts only. */
export interface PayCtx { base: string; projectBase?: string; projectSlug?: string }
export const PAY_CTX = new WeakMap<Request, PayCtx>();

type Page =
  | { kind: "link"; projectId: string; projectSlug: string; slug: string; link: typeof schema.purchaseLinks.$inferSelect; app: AppRecord }
  | { kind: "funnel"; projectId: string; projectSlug: string; slug: string; funnel: typeof schema.funnels.$inferSelect; app: AppRecord };

const nonce = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
const csp = (n: string) => `default-src 'none'; img-src https: data:; style-src 'nonce-${n}'; script-src 'nonce-${n}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;
const headersFor = (n: string) => ({ "content-security-policy": csp(n), "cache-control": "no-store", "referrer-policy": "strict-origin-when-cross-origin", "x-content-type-options": "nosniff" });

const queryOf = (c: Context) => {
  const q: Record<string, string> = {};
  for (const [k, v] of new URL(c.req.url).searchParams) if (/^utm_[a-z_]{1,20}$/.test(k)) q[k] = v.slice(0, 200);
  return q;
};

export function payRoutes(deps: Deps) {
  const r = new Hono();
  const { db } = deps;

  const ctxOf = (c: Context): PayCtx => PAY_CTX.get(c.req.raw) ?? { base: payBaseOf(deps.payUrl, publicOrigin(c)) };
  const projectBase = (c: Context, projectSlug: string) => ctxOf(c).projectBase ?? `${ctxOf(c).base}/${projectSlug}`;
  const html = (c: Context, body: string, n: string, status = 200) => c.body(body, status as 200, { ...headersFor(n), "content-type": "text/html; charset=utf-8" });
  const message = (c: Context, status: number, title: string, text: string, config?: WebConfig) => {
    const n = nonce();
    return html(c, renderMessagePage({ title, body: text, look: config ? lookOf(config) : undefined, theme: config?.theme, nonce: n }), n, status);
  };

  async function appFor(projectId: string, appId: string | null | undefined): Promise<AppRecord | null> {
    if (appId) {
      const [a] = await db.select().from(schema.apps).where(and(eq(schema.apps.id, appId), eq(schema.apps.projectId, projectId))).limit(1);
      if (a) return a;
    }
    return (await stripeAppsOf(db, projectId))[0] ?? null;
  }

  async function pageOf(projectSlug: string, slug: string): Promise<Page | null> {
    const [d] = await db.select().from(schema.webDomains).where(eq(schema.webDomains.slug, projectSlug)).limit(1);
    if (!d) return null;
    const [link] = await db.select().from(schema.purchaseLinks).where(and(eq(schema.purchaseLinks.projectId, d.projectId), eq(schema.purchaseLinks.slug, slug))).limit(1);
    if (link) {
      const app = await appFor(d.projectId, link.appId);
      return app ? { kind: "link", projectId: d.projectId, projectSlug, slug, link, app } : null;
    }
    const [funnel] = await db.select().from(schema.funnels).where(and(eq(schema.funnels.projectId, d.projectId), eq(schema.funnels.slug, slug))).limit(1);
    if (funnel?.published) {
      const app = await appFor(d.projectId, funnel.appId);
      return app ? { kind: "funnel", projectId: d.projectId, projectSlug, slug, funnel, app } : null;
    }
    return null;
  }

  /** The funnel shown for a page: a link's two steps, or a funnel's published copy; with the web config's look. */
  async function docOf(p: Page, config: WebConfig): Promise<FunnelDoc> {
    if (p.kind === "funnel") return p.funnel.published as unknown as FunnelDoc;
    const [o] = await db.select().from(schema.offerings).where(eq(schema.offerings.id, p.link.offeringId)).limit(1);
    const doc = purchaseLinkFunnel({ title: o?.displayName ?? "Choose your plan", offering: o?.lookupKey ?? "", allowCodes: true });
    doc.theme = { ...DEFAULT_THEME, ...config.theme };
    const pay = doc.steps[0] as PaywallStep;
    if (p.link.discountId) pay.discount_id = p.link.discountId;
    const succ = doc.steps[1]!;
    if (config.success_title) succ.title = config.success_title;
    if (config.success_body && succ.type === "success") succ.body = config.success_body;
    return doc;
  }

  async function packagesOf(p: Page, doc: FunnelDoc): Promise<Record<string, PagePackage[]>> {
    const out: Record<string, PagePackage[]> = {};
    for (const s of doc.steps) {
      if (s.type !== "paywall") continue;
      const key = s.offering ?? "";
      if (out[key]) continue;
      const o = await offeringByKey(db, p.projectId, key || null);
      out[key] = o ? (await webPackages(db, p.projectId, p.app.id, o.id)).map((x) => x.page) : [];
    }
    return out;
  }

  const linkClosed = (p: Page, now: Date) => p.kind === "link" && (!!p.link.disabledAt || (!!p.link.expiresAt && p.link.expiresAt <= now));
  const sandboxOf = (app: AppRecord) => stripeKeyHintOf(app.secretHints?.stripe_secret_key).mode === "test";

  // Redemption link page: opens the app with the deep link; store buttons when the app is not installed.
  r.get("/r/:token", async (c) => {
    const token = c.req.param("token");
    const [row] = /^rdrt_[A-Za-z0-9_-]{20,100}$/.test(token) ? await db.select().from(schema.webCheckouts).where(eq(schema.webCheckouts.redemptionTokenHash, await sha256Hex(token))).limit(1) : [];
    const app = row ? await appFor(row.projectId, row.appId) : null;
    if (!row || !app) return message(c, 404, "This link is not valid", "Check that you opened the whole link from your email. If it still does not work, contact the app's support.");
    const { config } = await webConfigOf(db, app);
    if (row.redeemedAt) return message(c, 200, "Already unlocked", `This purchase is already linked to an account in ${config.app_name}. Open the app and sign in with that account.`, config);
    const n = nonce();
    const doc: FunnelDoc = { theme: config.theme, steps: [{ id: "open", type: "success", title: `Open ${config.app_name}`, body: "Tap the button on the phone where the app is installed. Your purchase unlocks as soon as the app opens.", show_redemption: true }] };
    return html(c, renderFunnelPage({
      funnel: doc, look: lookOf(config), packages: {}, mode: "live", nonce: n, title: `Open ${config.app_name}`,
      success: { status: "paid", redeem_url: deepLinkFor(config.app_scheme, token), deep_link: deepLinkFor(config.app_scheme, token), app_store_url: config.app_store_url, play_store_url: config.play_store_url },
    }), n);
  });

  // Starts a checkout: answers { url } (Stripe Checkout) or { message }.
  r.post("/api/checkout", async (c) => {
    const now = deps.now();
    if (!(await hit(db, `pay-checkout:${clientIp((h) => c.req.header(h))}`, 30, 60_000, now))) return c.json({ message: "Too many attempts. Wait a minute and try again." }, 429);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, any>;
    const p = typeof b.project === "string" && typeof b.slug === "string" ? await pageOf(b.project, b.slug) : null;
    if (!p) return c.json({ message: "This page no longer exists." }, 404);
    if (linkClosed(p, now)) return c.json({ message: "This link has expired." }, 410);
    const { config } = await webConfigOf(db, p.app);
    const doc = await docOf(p, config);
    const pay = doc.steps.find((s) => s.type === "paywall") as PaywallStep | undefined;
    const offering = await offeringByKey(db, p.projectId, p.kind === "link" ? p.link.offeringId : pay?.offering ?? null);
    if (!offering || typeof b.package !== "string") return c.json({ message: "Pick a plan." }, 400);
    // Funnel answers with an attribute name become customer attributes when the purchase completes.
    const attributes: Record<string, string> = {};
    if (p.kind === "funnel" && b.answers && typeof b.answers === "object") {
      for (const s of doc.steps) {
        if (s.type !== "question" || !s.attribute) continue;
        const a = b.answers[s.id];
        const v = Array.isArray(a) ? a.filter((x) => typeof x === "string").join(", ") : typeof a === "string" ? a : null;
        if (v) attributes[s.attribute] = v.slice(0, 500);
      }
    }
    const pageUrl = `${projectBase(c, p.projectSlug)}/${p.slug}`;
    try {
      const out = await startCheckout(deps, {
        app: p.app, offering, packageKey: b.package, appUserId: typeof b.app_user_id === "string" ? b.app_user_id : null, email: typeof b.email === "string" ? b.email : null,
        code: typeof b.code === "string" ? b.code.slice(0, 64) : null, source: { type: p.kind === "link" ? "purchase_link" : "funnel", id: p.kind === "link" ? p.link.id : p.funnel.id, discountId: p.kind === "link" ? p.link.discountId : pay?.discount_id ?? null },
        funnelSessionId: p.kind === "funnel" && typeof b.session === "string" ? b.session.slice(0, 80) : null, attributes, pageUrl,
      });
      return c.json({ url: out.url, checkout_id: out.checkout.id });
    } catch (e) {
      if (e instanceof CheckoutError) return c.json({ message: e.message }, e.status);
      throw e;
    }
  });

  // Checks a discount code for the selected plan: { valid, message }.
  r.post("/api/discount", async (c) => {
    const now = deps.now();
    if (!(await hit(db, `pay-discount:${clientIp((h) => c.req.header(h))}`, 30, 60_000, now))) return c.json({ valid: false, message: "Too many attempts. Wait a minute and try again." }, 429);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, any>;
    const p = typeof b.project === "string" && typeof b.slug === "string" ? await pageOf(b.project, b.slug) : null;
    if (!p || typeof b.code !== "string" || !b.code.trim()) return c.json({ valid: false, message: "Enter a code." }, 400);
    const { config } = await webConfigOf(db, p.app);
    const doc = await docOf(p, config);
    const pay = doc.steps.find((s) => s.type === "paywall") as PaywallStep | undefined;
    const offering = await offeringByKey(db, p.projectId, p.kind === "link" ? p.link.offeringId : pay?.offering ?? null);
    const pkgs = offering ? await webPackages(db, p.projectId, p.app.id, offering.id) : [];
    const pkg = pkgs.find((x) => x.key === b.package) ?? pkgs[0];
    if (!pkg) return c.json({ valid: false, message: "Pick a plan first." }, 400);
    try {
      const d = await discountForCheckout(db, { projectId: p.projectId, appId: p.app.id, code: b.code.slice(0, 64), product: pkg.product, currency: pkg.web.currency, appUserId: typeof b.app_user_id === "string" ? b.app_user_id : null, now, deps });
      return c.json({ valid: !!d, message: d ? `${d.label} applied at checkout.` : "This code is not valid." });
    } catch (e) {
      if (e instanceof DiscountRefused) return c.json({ valid: false, message: e.message });
      throw e;
    }
  });

  // Funnel events from the page: funnel_viewed, step_viewed, step_completed.
  r.post("/api/events", async (c) => {
    const now = deps.now();
    if (!(await hit(db, `pay-events:${clientIp((h) => c.req.header(h))}`, 300, 60_000, now))) return c.body(null, 429);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, any>;
    const type = b.type as (typeof FUNNEL_EVENT_TYPES)[number];
    if (!["funnel_viewed", "step_viewed", "step_completed"].includes(type) || typeof b.funnel_id !== "string" || typeof b.session_id !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(b.session_id)) return c.body(null, 204);
    const [f] = await db.select().from(schema.funnels).where(eq(schema.funnels.id, b.funnel_id)).limit(1);
    if (!f?.published) return c.body(null, 204);
    const doc = f.published as unknown as FunnelDoc;
    const step = typeof b.step_id === "string" ? doc.steps.find((s) => s.id === b.step_id) : undefined;
    if (type !== "funnel_viewed" && !step) return c.body(null, 204);
    const answer = typeof b.answer === "string" ? b.answer.slice(0, 200) : Array.isArray(b.answer) ? b.answer.filter((x: unknown) => typeof x === "string").slice(0, 8).map((x: string) => x.slice(0, 200)) : null;
    const app = await appFor(f.projectId, f.appId);
    await recordFunnelEvent(db, {
      projectId: f.projectId, funnel: f, sessionId: b.session_id, type, stepId: step?.id ?? null, stepIndex: step ? doc.steps.indexOf(step) : null, stepType: step?.type ?? null,
      appUserId: typeof b.app_user_id === "string" ? b.app_user_id.slice(0, 100) : null, answer: step?.type === "email" ? (answer ? "provided" : null) : answer,
      query: b.query && typeof b.query === "object" ? b.query : {}, sandbox: app ? sandboxOf(app) : false, now,
    });
    deps.kick?.();
    return c.body(null, 204);
  });

  // The iOS SDK's hosted checkout returns here (routes/sdk.ts): the purchase is on the app user id; the SDK closes the page.
  r.get("/:project/_/success", async (c) => {
    const co = c.req.query("co"), sessionId = c.req.query("session_id");
    const [d] = await db.select().from(schema.webDomains).where(eq(schema.webDomains.slug, c.req.param("project"))).limit(1);
    if (!d || !co || !sessionId) return message(c, 404, "Page not found", "This page does not exist.");
    const [row] = await db.select().from(schema.webCheckouts).where(and(eq(schema.webCheckouts.id, co), eq(schema.webCheckouts.projectId, d.projectId))).limit(1);
    const app = row ? await appFor(d.projectId, row.appId) : null;
    const config = app ? (await webConfigOf(db, app)).config : undefined;
    const done = row ? await completeWebCheckout(deps, { checkoutId: co, sessionId }, ctxOf(c).base).catch((e) => { console.error("web checkout completion", e); return null; }) : null;
    if (!done) return message(c, 404, "Checkout not found", "We could not find this checkout.", config);
    if (done.status === "processing") return message(c, 202, "Payment processing", "Your payment is processing. You can return to the app; your purchase unlocks as soon as it is confirmed.", config);
    return message(c, 200, "Purchase complete", "Return to the app to start using your purchase.", config);
  });
  r.get("/:project/_/cancel", async (c) => message(c, 200, "Checkout cancelled", "Nothing was charged. Return to the app."));

  // The success page Stripe sends the buyer to.
  r.get("/:project/:slug/success", async (c) => {
    const p = await pageOf(c.req.param("project"), c.req.param("slug"));
    const co = c.req.query("co"), sessionId = c.req.query("session_id");
    if (!p || !co || !sessionId) return message(c, 404, "Page not found", "This page does not exist.");
    const { config } = await webConfigOf(db, p.app);
    const base = ctxOf(c).base;
    let done;
    try {
      done = await completeWebCheckout(deps, { checkoutId: co, sessionId }, base);
    } catch (e) {
      console.error("web checkout completion", e);
      done = null;
      const n = nonce();
      const doc = await docOf(p, config);
      return html(c, renderFunnelPage({ funnel: doc, look: lookOf(config), packages: {}, mode: "live", nonce: n, startStepId: doc.steps[doc.steps.length - 1]!.id, success: { status: "processing" } }), n);
    }
    if (!done) return message(c, 404, "Checkout not found", "We could not find this checkout. If you paid, check your email for the receipt and contact support.", config);
    if (done.status === "expired") return message(c, 410, "This checkout expired", "Nothing was charged. Go back and start again.", config);
    const redeem = done.token ? redeemUrlFor(base, done.token) : null;
    if (done.status === "completed" && config.success_mode === "redirect" && config.success_redirect_url) {
      const u = new URL(config.success_redirect_url);
      if (redeem) u.searchParams.set("redemption_url", redeem);
      return c.redirect(u.toString(), 303);
    }
    const doc = await docOf(p, config);
    const n = nonce();
    return html(c, renderFunnelPage({
      funnel: doc, look: lookOf(config), packages: {}, mode: "live", nonce: n, startStepId: doc.steps[doc.steps.length - 1]!.id,
      success: done.status === "processing" ? { status: "processing" }
        : done.row.anonymous ? { status: "paid", redeem_url: redeem, deep_link: done.token ? deepLinkFor(config.app_scheme, done.token) : null, app_store_url: config.app_store_url, play_store_url: config.play_store_url }
        : { status: "identified", app_store_url: config.app_store_url, play_store_url: config.play_store_url },
    }), n);
  });

  // A purchase link or a published funnel.
  r.get("/:project/:slug", async (c) => {
    const now = deps.now();
    const p = await pageOf(c.req.param("project"), c.req.param("slug"));
    if (!p) return message(c, 404, "Page not found", "This page does not exist or is no longer published.");
    const { config } = await webConfigOf(db, p.app);
    if (linkClosed(p, now)) return message(c, 410, "This link has expired", "Ask for a new link, or open the app to buy there.", config);
    const doc = await docOf(p, config);
    const base = ctxOf(c).base;
    const n = nonce();
    const q = c.req.query();
    return html(c, renderFunnelPage({
      funnel: doc, look: lookOf(config), packages: await packagesOf(p, doc), mode: "live", nonce: n, title: p.kind === "funnel" ? config.app_name : `${config.app_name}: ${doc.steps[0]!.title}`,
      urls: { checkout: `${base}/api/checkout`, events: `${base}/api/events`, discount: `${base}/api/discount` },
      context: {
        project: p.projectSlug, slug: p.slug, funnel_id: p.kind === "funnel" ? p.funnel.id : null, link_id: p.kind === "link" ? p.link.id : null,
        session_id: crypto.randomUUID().replace(/-/g, ""), app_user_id: q.app_user_id?.slice(0, 100) || null, email: q.email?.slice(0, 254) || null,
        code: q.code?.slice(0, 64) || null, canceled: q.canceled === "1", query: queryOf(c),
      },
    }), n);
  });

  r.all("*", (c) => message(c, 404, "Page not found", "This page does not exist."));
  return r;
}

export { tokenFor };
