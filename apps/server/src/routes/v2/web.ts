import { and, count, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { newId } from "@revenuedot/core";
import {
  funnelAiMessages, funnelFromModel, FUNNEL_AI_MAX_PROMPT, normalizeFunnel, starterFunnel, THEME_PRESETS, validateFunnel,
  type FunnelDoc, type PagePackage,
} from "@revenuedot/core/funnels";
import { schema } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { publicOrigin } from "../oauth.js";
import { hit } from "../../services/rate-limit.js";
import { storeSecretHintOf, storeSecretSet, stripeConnected, stripeKeyHintOf, stripeModeOf, stripeReachable, withStoreSecrets } from "../../services/store-secrets.js";
import { lookOf, saveWebConfig, stripeAppsOf, WebConfigIn, webConfigOf } from "../../services/web/config.js";
import { webPackages, webProductsOf } from "../../services/web/catalog.js";
import { cnameTarget, DOMAIN, domainOf, forgetHost, payBaseOf, projectBase, RESERVED_SLUGS, SLUG, slugTaken, txtName, txtValue, verifyDomain, type DomainRow } from "../../services/web/domains.js";
import { funnelAnalytics } from "../../services/web/funnels.js";
import { stripeClientFor } from "../../stores/stripe/index.js";
import { StripeApiError, stripeKeyOf } from "../../stores/stripe/api.js";
import { fromMinor } from "../../stores/stripe/map.js";
import { majorToMinor } from "@revenuedot/core/funnels";
import { productShape } from "./shapes.js";
import { body, conflict, notFound, paginate, paramError, scope, V2Error, type V2Context, type V2Router } from "./common.js";

/**
 * Web billing, purchase links, funnels and domains (prd/web-billing/PRD.md). All RevenueDot extensions: RevenueCat's v2 has
 * no operations for them. Hosted pages themselves are in routes/pay.ts; discounts in discounts.ts.
 */

const appsRead = scope("project_configuration:apps:read");
const appsWrite = scope("project_configuration:apps:read_write");
const offRead = scope("project_configuration:offerings:read");
const offWrite = scope("project_configuration:offerings:read_write");
const prodWrite = scope("project_configuration:products:read_write");

const DURATIONS: Record<string, { interval: string; count: number }> = { P1W: { interval: "week", count: 1 }, P1M: { interval: "month", count: 1 }, P3M: { interval: "month", count: 3 }, P6M: { interval: "month", count: 6 }, P1Y: { interval: "year", count: 1 } };
const durationOf = (interval: string | null, n: number | null) => {
  if (!interval) return null;
  const hit0 = Object.entries(DURATIONS).find(([, v]) => v.interval === interval && v.count === (n ?? 1));
  if (hit0) return hit0[0];
  return interval === "day" ? `P${n ?? 1}D` : interval === "week" ? `P${n ?? 1}W` : interval === "month" ? `P${n ?? 1}M` : `P${n ?? 1}Y`;
};

const WebProductIn = z.object({
  display_name: z.string().trim().min(1).max(120),
  type: z.enum(["subscription", "consumable", "non_consumable"]).default("subscription"),
  price: z.object({ amount: z.number().positive().max(1_000_000), currency: z.string().regex(/^[A-Za-z]{3}$/) }).optional(),
  duration: z.enum(["P1W", "P1M", "P3M", "P6M", "P1Y"]).optional(),
  trial_days: z.number().int().min(1).max(730).nullable().optional(),
  entitlement_ids: z.array(z.string().min(1)).max(20).optional(),
  /** Link an existing Stripe price instead of creating a product and a price. */
  stripe_price_id: z.string().regex(/^price_[A-Za-z0-9_]+$/).optional(),
}).strict();

const slugIn = z.string().trim().toLowerCase().regex(SLUG, "must be 3-40 lower-case letters, digits or -, starting and ending with a letter or digit").refine((s) => !RESERVED_SLUGS.has(s), "is reserved");
const LinkIn = z.object({
  name: z.string().trim().min(1).max(120),
  offering_id: z.string().min(1),
  slug: slugIn.optional(),
  app_id: z.string().min(1).nullable().optional(),
  discount_id: z.string().min(1).nullable().optional(),
  expires_at: z.number().int().positive().nullable().optional(),
  enabled: z.boolean().optional(),
}).strict();
const FunnelIn = z.object({
  name: z.string().trim().min(1).max(120),
  slug: slugIn.optional(),
  app_id: z.string().min(1).nullable().optional(),
  template: z.enum(["starter", "blank"]).optional(),
  draft: z.record(z.unknown()).optional(),
}).strict();
const FunnelPatch = z.object({ name: z.string().trim().min(1).max(120).optional(), slug: slugIn.optional(), app_id: z.string().min(1).nullable().optional(), draft: z.record(z.unknown()).optional() }).strict();
const GenerateIn = z.object({ prompt: z.string().trim().min(3).max(FUNNEL_AI_MAX_PROMPT), app_name: z.string().trim().max(80).optional() }).strict();
const DomainIn = z.object({ slug: slugIn.optional(), custom_domain: z.string().trim().toLowerCase().regex(DOMAIN, "must be a domain such as pay.yourapp.com").nullable().optional() }).strict();

const ms = (d: Date | null | undefined) => (d ? d.getTime() : null);

export function webRoutes(r: V2Router, deps: Deps) {
  const { db } = deps;
  const P = "/v2/projects/:project_id";
  const payBase = (c: V2Context) => payBaseOf(deps.payUrl, publicOrigin(c));

  async function stripeApp(c: V2Context, appId: string) {
    const [a] = await db.select().from(schema.apps).where(and(eq(schema.apps.projectId, c.get("projectId")), eq(schema.apps.id, appId))).limit(1);
    if (!a) throw notFound("App");
    if (a.type !== "stripe") throw paramError("Web billing needs a Stripe app. Add one under Apps → Stripe.", "app_id");
    return a;
  }
  async function defaultStripeApp(projectId: string, appId?: string | null) {
    const apps = await stripeAppsOf(db, projectId);
    if (appId) { const a = apps.find((x) => x.id === appId); if (!a) throw paramError("app_id must be a Stripe app of this project.", "app_id"); return a; }
    // The first app that can reach Stripe (a restricted key or Connect), else the first.
    return apps.find((a) => stripeReachable(a)) ?? apps[0] ?? null;
  }
  async function slugFree(projectId: string, slug: string, except: { link?: string; funnel?: string } = {}) {
    const [l] = await db.select({ id: schema.purchaseLinks.id }).from(schema.purchaseLinks).where(and(eq(schema.purchaseLinks.projectId, projectId), eq(schema.purchaseLinks.slug, slug))).limit(1);
    const [f] = await db.select({ id: schema.funnels.id }).from(schema.funnels).where(and(eq(schema.funnels.projectId, projectId), eq(schema.funnels.slug, slug))).limit(1);
    return (!l || l.id === except.link) && (!f || f.id === except.funnel);
  }
  async function uniqueSlug(projectId: string, base: string) {
    const b = (base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "page").padEnd(3, "x");
    for (let i = 0; i < 20; i++) {
      const s = i === 0 && !RESERVED_SLUGS.has(b) ? b : `${b.slice(0, 30)}-${newId("", 4)}`;
      if (SLUG.test(s) && (await slugFree(projectId, s))) return s;
    }
    return `page-${newId("", 8)}`;
  }
  const pageUrl = (c: V2Context, d: DomainRow, slug: string) => `${projectBase(payBase(c), d)}/${slug}`;

  /* ---------- overview and checklist ---------- */

  r.get(`${P}/web`, appsRead, async (c) => {
    const projectId = c.get("projectId");
    const apps = await stripeAppsOf(db, projectId);
    const configs = apps.length ? await db.select({ appId: schema.webConfigs.appId }).from(schema.webConfigs).where(inArray(schema.webConfigs.appId, apps.map((a) => a.id))) : [];
    const products = await webProductsOf(db, projectId);
    const productIds = products.map((p) => p.product.id);
    const offeringsWithWeb = productIds.length ? await db.selectDistinct({ id: schema.packages.offeringId }).from(schema.packageProducts).innerJoin(schema.packages, eq(schema.packages.id, schema.packageProducts.packageId)).where(inArray(schema.packageProducts.productId, productIds)) : [];
    const d = await domainOf(db, projectId, deps.now());
    const providers = apps.map((a) => ({
      object: "web_provider", id: a.id, name: a.name, type: "stripe", public_key: a.publicKey, key: stripeKeyHintOf(storeSecretHintOf(a, "stripe_secret_key")),
      // How the app reaches Stripe: "Connect with Stripe" (prd/web-billing/PRD.md §8), a restricted key, or not yet.
      connection: stripeConnected(a) ? "stripe_connect" : storeSecretSet(a, "stripe_secret_key") ? "restricted_key" : null,
      connected_account: stripeConnected(a) ? storeSecretHintOf(a, "stripe_connect_account_id") : null, mode: stripeModeOf(a),
      web_config: configs.some((x) => x.appId === a.id), created_at: a.createdAt.getTime(),
    }));
    return c.json({
      object: "web_overview", pay_base: payBase(c), project_base: projectBase(payBase(c), d), domain: domainShape(c, d),
      providers,
      checklist: {
        connect_stripe: providers.some((p) => p.connection !== null), web_config: providers.some((p) => p.web_config),
        web_products: products.length > 0, offering: offeringsWithWeb.length > 0,
      },
      web_products: products.length, offerings_with_web_products: offeringsWithWeb.map((o) => o.id),
    });
  });

  /* ---------- web config ---------- */

  r.get(`${P}/apps/:app_id/web_config`, appsRead, async (c) => {
    const a = await stripeApp(c, c.req.param("app_id")!);
    const w = await webConfigOf(db, a);
    return c.json({ object: "web_config", app_id: a.id, saved: w.saved, updated_at: ms(w.updatedAt), ...w.config, presets: THEME_PRESETS });
  });
  r.put(`${P}/apps/:app_id/web_config`, appsWrite, async (c) => {
    const a = await stripeApp(c, c.req.param("app_id")!);
    const b = await body(c, WebConfigIn);
    let saved;
    try { saved = await saveWebConfig(db, a, b, deps.now()); } catch (e) {
      if (e instanceof Error && (e as { param?: string }).param) throw paramError(e.message, (e as { param?: string }).param);
      throw e;
    }
    return c.json({ object: "web_config", app_id: a.id, saved: true, updated_at: deps.now().getTime(), ...saved, presets: THEME_PRESETS });
  });

  /* ---------- web products (created in the developer's Stripe account) ---------- */

  const webProductShape = (p: typeof schema.products.$inferSelect, w: typeof schema.webProducts.$inferSelect) => ({
    object: "web_product" as const, product: productShape(p), stripe_product_id: w.stripeProductId, stripe_price_id: w.stripePriceId,
    price: { amount: fromMinor(w.amountMinor, w.currency), amount_minor: w.amountMinor, currency: w.currency.toUpperCase() },
    interval: w.interval, interval_count: w.intervalCount, trial_days: w.trialDays, created_at: w.createdAt.getTime(),
  });

  r.get(`${P}/apps/:app_id/web_products`, scope("project_configuration:products:read"), async (c) => {
    const a = await stripeApp(c, c.req.param("app_id")!);
    const rows = await webProductsOf(db, c.get("projectId"), a.id);
    return c.json(paginate(c, rows, (x) => x.product.id, (x) => x.web.createdAt.getTime(), (x) => webProductShape(x.product, x.web)));
  });

  r.post(`${P}/apps/:app_id/web_products`, prodWrite, async (c) => {
    const projectId = c.get("projectId");
    const a = await stripeApp(c, c.req.param("app_id")!);
    const b = await body(c, WebProductIn);
    const app = await withStoreSecrets(deps, a);
    if (!stripeKeyOf(app)) {
      throw new V2Error(422, "unprocessable_entity_error", stripeConnected(a)
        ? "This app is connected with Stripe Connect, but this server has no Stripe Connect platform key for the connection's mode."
        : "This Stripe app has no API key yet. Connect with Stripe, or add a restricted key with write access to Products and Prices.", "app_id");
    }
    const { client } = stripeClientFor(deps.stores, deps.fetch);
    const now = deps.now();
    const reqId = newId("", 12);
    let price: { id: string; product: string | { id: string }; unit_amount: number | null; currency: string; recurring?: { interval: string; interval_count: number; trial_period_days?: number | null } | null };
    try {
      if (b.stripe_price_id) {
        price = await client.get(app, `/v1/prices/${encodeURIComponent(b.stripe_price_id)}`);
      } else {
        if (!b.price) throw paramError("price is required (or stripe_price_id to link an existing price).", "price");
        if (b.type === "subscription" && !b.duration) throw paramError("duration is required for a subscription.", "duration");
        const product = await client.post<{ id: string }>(app, "/v1/products", { name: b.display_name, metadata: { revenuedot_project: projectId } }, `rd-product-${reqId}`);
        const d = b.type === "subscription" ? DURATIONS[b.duration!]! : null;
        price = await client.post(app, "/v1/prices", {
          product: product.id, currency: b.price.currency.toLowerCase(), unit_amount: majorToMinor(b.price.amount, b.price.currency),
          ...(d ? { recurring: { interval: d.interval, interval_count: d.count } } : {}), metadata: { revenuedot_project: projectId },
        }, `rd-price-${reqId}`);
      }
    } catch (e) {
      if (e instanceof V2Error) throw e;
      if (e instanceof StripeApiError) {
        if (e.kind === "credentials") throw new V2Error(422, "store_error", stripeConnected(a) ? `Stripe refused the request on the connected account. Stripe said: ${e.message}` : `Stripe refused the request. The restricted key needs write access to Products and Prices. Stripe said: ${e.message}`, "app_id");
        if (e.kind === "transient") throw new V2Error(422, "store_error", `Stripe is unavailable: ${e.message}`, undefined, true);
        throw new V2Error(422, "store_error", `Stripe: ${e.message}`, b.stripe_price_id ? "stripe_price_id" : "price");
      }
      throw e;
    }
    const stripeProduct = typeof price.product === "string" ? price.product : price.product.id;
    const recurring = price.recurring ?? null;
    if (b.type === "subscription" && !recurring) throw paramError("That Stripe price is a one-time price; use type consumable or non_consumable.", "stripe_price_id");
    if (b.type !== "subscription" && recurring) throw paramError("That Stripe price is recurring; use type subscription.", "stripe_price_id");
    if (typeof price.unit_amount !== "number") throw paramError("Only prices with a fixed unit amount can be sold on the web.", "stripe_price_id");
    const [exists] = await db.select({ id: schema.products.id }).from(schema.products).where(and(eq(schema.products.appId, a.id), eq(schema.products.storeIdentifier, price.id))).limit(1);
    if (exists) throw conflict("A product for this Stripe price already exists in this app.", "stripe_price_id");
    const id = newId("prod", 14);
    const [prod] = await db.insert(schema.products).values({
      id, projectId, appId: a.id, storeIdentifier: price.id, type: b.type, displayName: b.display_name, duration: recurring ? durationOf(recurring.interval, recurring.interval_count) : null, createdAt: now,
    }).returning();
    const [web] = await db.insert(schema.webProducts).values({
      productId: id, projectId, appId: a.id, stripeProductId: stripeProduct, stripePriceId: price.id, amountMinor: price.unit_amount, currency: price.currency.toLowerCase(),
      interval: recurring?.interval ?? null, intervalCount: recurring?.interval_count ?? null, trialDays: b.trial_days ?? recurring?.trial_period_days ?? null, createdAt: now,
    }).returning();
    if (b.entitlement_ids?.length) {
      const ents = await db.select({ id: schema.entitlements.id }).from(schema.entitlements).where(and(eq(schema.entitlements.projectId, projectId), inArray(schema.entitlements.id, b.entitlement_ids)));
      if (ents.length) await db.insert(schema.entitlementProducts).values(ents.map((e) => ({ entitlementId: e.id, productId: id }))).onConflictDoNothing();
    }
    return c.json(webProductShape(prod!, web!), 201);
  });

  /* ---------- purchase links ---------- */

  type LinkRow = typeof schema.purchaseLinks.$inferSelect;
  async function linkShapes(c: V2Context, rows: LinkRow[]) {
    const projectId = c.get("projectId");
    const d = await domainOf(db, projectId, deps.now());
    const offs = await db.select().from(schema.offerings).where(eq(schema.offerings.projectId, projectId));
    const stats = rows.length ? await db.select({ id: schema.webCheckouts.sourceId, status: schema.webCheckouts.status, n: count() }).from(schema.webCheckouts)
      .where(and(eq(schema.webCheckouts.sourceType, "purchase_link"), inArray(schema.webCheckouts.sourceId, rows.map((x) => x.id)))).groupBy(schema.webCheckouts.sourceId, schema.webCheckouts.status) : [];
    const now = deps.now();
    return (l: LinkRow) => {
      const o = offs.find((x) => x.id === l.offeringId);
      const st = stats.filter((x) => x.id === l.id);
      return {
        object: "purchase_link" as const, id: l.id, name: l.name, slug: l.slug, app_id: l.appId, offering_id: l.offeringId, offering_lookup_key: o?.lookupKey ?? null,
        offering_display_name: o?.displayName ?? null, discount_id: l.discountId, expires_at: ms(l.expiresAt), disabled_at: ms(l.disabledAt),
        status: l.disabledAt ? "disabled" : l.expiresAt && l.expiresAt <= now ? "expired" : "active",
        url: pageUrl(c, d, l.slug), checkouts: st.reduce((a, x) => a + x.n, 0), purchases: st.filter((x) => x.status === "completed").reduce((a, x) => a + x.n, 0), created_at: l.createdAt.getTime(),
      };
    };
  }
  async function findLink(projectId: string, id: string) {
    const [l] = await db.select().from(schema.purchaseLinks).where(and(eq(schema.purchaseLinks.projectId, projectId), eq(schema.purchaseLinks.id, id))).limit(1);
    if (!l) throw notFound("Purchase link");
    return l;
  }
  async function checkRefs(projectId: string, o: { offering_id?: string; discount_id?: string | null }) {
    if (o.offering_id) {
      const [off] = await db.select({ id: schema.offerings.id }).from(schema.offerings).where(and(eq(schema.offerings.projectId, projectId), eq(schema.offerings.id, o.offering_id))).limit(1);
      if (!off) throw paramError("offering_id does not match an offering of this project.", "offering_id");
    }
    if (o.discount_id) {
      const [dd] = await db.select({ id: schema.discounts.id }).from(schema.discounts).where(and(eq(schema.discounts.projectId, projectId), eq(schema.discounts.id, o.discount_id))).limit(1);
      if (!dd) throw paramError("discount_id does not match a discount of this project.", "discount_id");
    }
  }

  r.get(`${P}/purchase_links`, offRead, async (c) => {
    const rows = await db.select().from(schema.purchaseLinks).where(eq(schema.purchaseLinks.projectId, c.get("projectId")));
    const shape = await linkShapes(c, rows);
    return c.json(paginate(c, rows, (x) => x.id, (x) => x.createdAt.getTime(), shape));
  });
  r.post(`${P}/purchase_links`, offWrite, async (c) => {
    const projectId = c.get("projectId");
    const b = await body(c, LinkIn);
    await checkRefs(projectId, b);
    const app = await defaultStripeApp(projectId, b.app_id);
    if (!app) throw new V2Error(422, "unprocessable_entity_error", "Purchase links need a Stripe app. Connect Stripe on the Web page first.");
    const slug = b.slug ?? (await uniqueSlug(projectId, b.name));
    if (!(await slugFree(projectId, slug))) throw conflict("Another purchase link or funnel already uses this slug.", "slug");
    const now = deps.now();
    const [row] = await db.insert(schema.purchaseLinks).values({
      id: newId("plink_", 12), projectId, appId: app.id, offeringId: b.offering_id, name: b.name, slug, discountId: b.discount_id ?? null,
      expiresAt: b.expires_at ? new Date(b.expires_at) : null, disabledAt: b.enabled === false ? now : null, createdAt: now,
    }).returning();
    return c.json((await linkShapes(c, [row!]))(row!), 201);
  });
  r.get(`${P}/purchase_links/:link_id`, offRead, async (c) => {
    const l = await findLink(c.get("projectId"), c.req.param("link_id")!);
    return c.json((await linkShapes(c, [l]))(l));
  });
  r.patch(`${P}/purchase_links/:link_id`, offWrite, async (c) => {
    const projectId = c.get("projectId");
    const l = await findLink(projectId, c.req.param("link_id")!);
    const b = await body(c, LinkIn.partial());
    await checkRefs(projectId, b);
    if (b.slug && b.slug !== l.slug && !(await slugFree(projectId, b.slug, { link: l.id }))) throw conflict("Another purchase link or funnel already uses this slug.", "slug");
    const app = b.app_id !== undefined ? await defaultStripeApp(projectId, b.app_id) : null;
    const [row] = await db.update(schema.purchaseLinks).set({
      ...(b.name !== undefined ? { name: b.name } : {}), ...(b.slug !== undefined ? { slug: b.slug } : {}), ...(b.offering_id !== undefined ? { offeringId: b.offering_id } : {}),
      ...(app ? { appId: app.id } : {}), ...(b.discount_id !== undefined ? { discountId: b.discount_id } : {}),
      ...(b.expires_at !== undefined ? { expiresAt: b.expires_at ? new Date(b.expires_at) : null } : {}),
      ...(b.enabled !== undefined ? { disabledAt: b.enabled ? null : l.disabledAt ?? deps.now() } : {}),
    }).where(eq(schema.purchaseLinks.id, l.id)).returning();
    return c.json((await linkShapes(c, [row!]))(row!));
  });
  r.delete(`${P}/purchase_links/:link_id`, offWrite, async (c) => {
    const l = await findLink(c.get("projectId"), c.req.param("link_id")!);
    await db.delete(schema.purchaseLinks).where(eq(schema.purchaseLinks.id, l.id));
    return c.json({ object: "purchase_link", id: l.id, deleted_at: deps.now().getTime() });
  });

  /* ---------- funnels ---------- */

  type FunnelRow = typeof schema.funnels.$inferSelect;
  async function funnelShape(c: V2Context, f: FunnelRow, withDoc = true) {
    const d = await domainOf(db, c.get("projectId"), deps.now());
    const changed = !f.published || JSON.stringify(f.published) !== JSON.stringify(f.draft);
    return {
      object: "funnel" as const, id: f.id, name: f.name, slug: f.slug, app_id: f.appId, status: f.published ? "published" : "draft", has_unpublished_changes: !!f.published && changed,
      url: pageUrl(c, d, f.slug), published_at: ms(f.publishedAt), created_at: f.createdAt.getTime(), updated_at: f.updatedAt.getTime(),
      steps: ((f.draft as unknown as FunnelDoc).steps ?? []).length,
      ...(withDoc ? { draft: f.draft, problems: validateFunnel(f.draft, { forPublish: true }) } : {}),
    };
  }
  async function findFunnel(projectId: string, id: string) {
    const [f] = await db.select().from(schema.funnels).where(and(eq(schema.funnels.projectId, projectId), eq(schema.funnels.id, id))).limit(1);
    if (!f) throw notFound("Funnel");
    return f;
  }
  const checkDoc = (doc: unknown) => {
    const problems = validateFunnel(doc);
    if (problems.length) throw paramError(`draft.${problems[0]!.path}: ${problems[0]!.message}`, `draft.${problems[0]!.path}`);
    if (JSON.stringify(doc).length > 200_000) throw paramError("The funnel is too large.", "draft");
    return normalizeFunnel(doc as FunnelDoc);
  };

  r.get(`${P}/funnels`, offRead, async (c) => {
    const projectId = c.get("projectId");
    const rows = await db.select().from(schema.funnels).where(eq(schema.funnels.projectId, projectId));
    const since = new Date(deps.now().getTime() - 30 * 86_400_000);
    const stats = rows.length ? await db.select({ f: schema.funnelEvents.funnelId, type: schema.funnelEvents.type, n: sql<number>`count(distinct ${schema.funnelEvents.sessionId})::int` }).from(schema.funnelEvents)
      .where(and(inArray(schema.funnelEvents.funnelId, rows.map((x) => x.id)), sql`${schema.funnelEvents.createdAt} >= ${since.toISOString()}::timestamptz`, sql`${schema.funnelEvents.type} in ('funnel_viewed','purchase')`)).groupBy(schema.funnelEvents.funnelId, schema.funnelEvents.type) : [];
    const shapes = new Map<string, unknown>();
    for (const f of rows) {
      const views = stats.find((s) => s.f === f.id && s.type === "funnel_viewed")?.n ?? 0, purchases = stats.find((s) => s.f === f.id && s.type === "purchase")?.n ?? 0;
      shapes.set(f.id, { ...(await funnelShape(c, f, false)), views_30d: views, purchases_30d: purchases });
    }
    return c.json(paginate(c, rows, (x) => x.id, (x) => x.createdAt.getTime(), (x) => shapes.get(x.id)));
  });

  r.post(`${P}/funnels`, offWrite, async (c) => {
    const projectId = c.get("projectId");
    const b = await body(c, FunnelIn);
    const app = await defaultStripeApp(projectId, b.app_id);
    const doc = b.draft ? checkDoc(b.draft) : b.template === "blank" ? normalizeFunnel({ theme: starterFunnel().theme, steps: [{ id: "paywall", type: "paywall", title: "Unlock everything", allow_codes: true }, { id: "success", type: "success", title: "You are in", show_redemption: true }] }) : starterFunnel();
    if (app) { const { config } = await webConfigOf(db, app); if (!b.draft) doc.theme = { ...config.theme }; }
    const slug = b.slug ?? (await uniqueSlug(projectId, b.name));
    if (!(await slugFree(projectId, slug))) throw conflict("Another purchase link or funnel already uses this slug.", "slug");
    const now = deps.now();
    const [row] = await db.insert(schema.funnels).values({ id: newId("fnl_", 12), projectId, appId: app?.id ?? null, name: b.name, slug, draft: doc as unknown as Record<string, unknown>, createdAt: now, updatedAt: now }).returning();
    return c.json(await funnelShape(c, row!), 201);
  });

  r.get(`${P}/funnels/ai`, offRead, (c) => c.json({ object: "funnel_ai", available: !!deps.ai, provider: deps.ai?.provider ?? null, model: deps.ai?.model ?? null, max_prompt_length: FUNNEL_AI_MAX_PROMPT }));

  // Build with AI: the paywall generator's model and the same caps (prd/paywalls/PRD.md §3).
  r.post(`${P}/funnels/generate`, offWrite, async (c) => {
    const projectId = c.get("projectId");
    if (!deps.ai) throw new V2Error(503, "server_error", "No language model is configured. On a self-hosted server set OPENAI_API_KEY or ANTHROPIC_API_KEY.");
    const b = await body(c, GenerateIn);
    const now = deps.now();
    if (!(await hit(db, `paywall-ai:${projectId}`, 1, 5_000, now))) throw new V2Error(429, "rate_limit_error", "One generation every 5 seconds. Try again in a moment.", undefined, true);
    if (!(await hit(db, `paywall-ai-day:${projectId}`, 60, 86_400_000, now))) throw new V2Error(429, "rate_limit_error", "This project has used its 60 AI generations for today.", undefined, true);
    const principal = c.get("principal");
    if (principal.kind === "user" && !(await hit(db, `paywall-ai-user:${principal.userId}`, 100, 86_400_000, now))) throw new V2Error(429, "rate_limit_error", "You have used your 100 AI generations for today.", undefined, true);
    if (!(await hit(db, "paywall-ai-server", 5_000, 86_400_000, now))) throw new V2Error(429, "rate_limit_error", "AI generation is busy today. Try again tomorrow.", undefined, true);
    const m = funnelAiMessages({ prompt: b.prompt, appName: b.app_name });
    let answer: string;
    try { answer = await deps.ai.complete(m.system, m.user); } catch (e) {
      console.error("funnel AI", e instanceof Error ? e.message : e);
      throw new V2Error(502, "server_error", "The language model did not answer. Try again.", undefined, true);
    }
    let out;
    try { out = funnelFromModel(answer); } catch { throw new V2Error(502, "server_error", "The language model's answer was not a funnel. Try again or reword the request.", undefined, true); }
    if (out.problems.length) throw new V2Error(502, "server_error", `The generated funnel is not valid (${out.problems[0]!.path}: ${out.problems[0]!.message}). Try again.`, undefined, true);
    return c.json({ object: "funnel_generation", draft: out.funnel, fixes: out.fixes, provider: deps.ai.provider, model: deps.ai.model });
  });

  r.get(`${P}/funnels/:funnel_id`, offRead, async (c) => c.json(await funnelShape(c, await findFunnel(c.get("projectId"), c.req.param("funnel_id")!))));

  r.patch(`${P}/funnels/:funnel_id`, offWrite, async (c) => {
    const projectId = c.get("projectId");
    const f = await findFunnel(projectId, c.req.param("funnel_id")!);
    const b = await body(c, FunnelPatch);
    if (b.slug && b.slug !== f.slug && !(await slugFree(projectId, b.slug, { funnel: f.id }))) throw conflict("Another purchase link or funnel already uses this slug.", "slug");
    const app = b.app_id !== undefined ? await defaultStripeApp(projectId, b.app_id) : undefined;
    const [row] = await db.update(schema.funnels).set({
      ...(b.name !== undefined ? { name: b.name } : {}), ...(b.slug !== undefined ? { slug: b.slug } : {}), ...(app !== undefined ? { appId: app?.id ?? null } : {}),
      ...(b.draft !== undefined ? { draft: checkDoc(b.draft) as unknown as Record<string, unknown> } : {}), updatedAt: deps.now(),
    }).where(eq(schema.funnels.id, f.id)).returning();
    return c.json(await funnelShape(c, row!));
  });

  r.delete(`${P}/funnels/:funnel_id`, offWrite, async (c) => {
    const f = await findFunnel(c.get("projectId"), c.req.param("funnel_id")!);
    await db.delete(schema.funnels).where(eq(schema.funnels.id, f.id));
    return c.json({ object: "funnel", id: f.id, deleted_at: deps.now().getTime() });
  });

  r.post(`${P}/funnels/:funnel_id/actions/publish`, offWrite, async (c) => {
    const projectId = c.get("projectId");
    const f = await findFunnel(projectId, c.req.param("funnel_id")!);
    const problems = validateFunnel(f.draft, { forPublish: true });
    if (problems.length) throw new V2Error(422, "unprocessable_entity_error", `The funnel cannot be published: ${problems[0]!.path} ${problems[0]!.message}.`, `draft.${problems[0]!.path}`);
    const app = await defaultStripeApp(projectId, f.appId);
    if (!app) throw new V2Error(422, "unprocessable_entity_error", "Connect Stripe on the Web page before publishing a funnel.");
    const now = deps.now();
    const [row] = await db.update(schema.funnels).set({ published: f.draft, publishedAt: now, appId: app.id, updatedAt: now }).where(eq(schema.funnels.id, f.id)).returning();
    return c.json(await funnelShape(c, row!));
  });
  r.post(`${P}/funnels/:funnel_id/actions/unpublish`, offWrite, async (c) => {
    const f = await findFunnel(c.get("projectId"), c.req.param("funnel_id")!);
    const [row] = await db.update(schema.funnels).set({ published: null, publishedAt: null, updatedAt: deps.now() }).where(eq(schema.funnels.id, f.id)).returning();
    return c.json(await funnelShape(c, row!));
  });

  r.get(`${P}/funnels/:funnel_id/analytics`, offRead, async (c) => {
    const f = await findFunnel(c.get("projectId"), c.req.param("funnel_id")!);
    const days = Math.min(365, Math.max(1, Math.trunc(Number(c.req.query("days") ?? 30)) || 30));
    return c.json(await funnelAnalytics(db, f, days, deps.now()));
  });

  // What the builder's live preview needs: the look, and the web packages of every offering (rendered in the browser).
  r.get(`${P}/funnels/:funnel_id/preview_data`, offRead, async (c) => {
    const projectId = c.get("projectId");
    const f = await findFunnel(projectId, c.req.param("funnel_id")!);
    const app = await defaultStripeApp(projectId, f.appId).catch(() => null);
    const offs = await db.select().from(schema.offerings).where(eq(schema.offerings.projectId, projectId));
    const packages: Record<string, PagePackage[]> = {};
    if (app) {
      for (const o of offs) {
        const list = (await webPackages(db, projectId, app.id, o.id)).map((x) => x.page);
        packages[o.lookupKey] = list;
        if (o.isCurrent) packages[""] = list;
      }
    }
    const look = app ? lookOf((await webConfigOf(db, app)).config) : { app_name: "Your app" };
    const discounts = await db.select({ id: schema.discounts.id, name: schema.discounts.customerFacingName, identifier: schema.discounts.identifier }).from(schema.discounts).where(eq(schema.discounts.projectId, projectId));
    return c.json({
      object: "funnel_preview_data", app_id: app?.id ?? null, look, packages, presets: THEME_PRESETS,
      offerings: offs.map((o) => ({ id: o.id, lookup_key: o.lookupKey, display_name: o.displayName, is_current: o.isCurrent, web_packages: (packages[o.lookupKey] ?? []).length })),
      discounts,
    });
  });

  /* ---------- domains ---------- */

  function domainShape(c: V2Context, d: DomainRow) {
    const target = cnameTarget(deps.customDomainTarget, payBase(c));
    return {
      object: "web_domain" as const, slug: d.slug, pay_base: payBase(c), default_base: `${payBase(c)}/${d.slug}`, base: projectBase(payBase(c), d),
      custom_domain: d.customDomain, status: d.customDomain ? d.status : "none", verified_at: ms(d.verifiedAt), checked_at: ms(d.checkedAt), error: d.error,
      dns: d.customDomain ? [
        { type: "CNAME", name: d.customDomain, value: target },
        { type: "TXT", name: txtName(d.customDomain), value: txtValue(d.verificationToken) },
      ] : [],
      cloud_note: deps.edition === "cloud" ? "On RevenueDot Cloud the domain also needs a TLS certificate, which RevenueDot adds after verification (see the custom domains guide)." : null,
    };
  }

  async function verifiedElsewhere(domain: string, projectId: string) {
    const [other] = await db.select({ p: schema.webDomains.projectId }).from(schema.webDomains)
      .where(and(eq(schema.webDomains.customDomain, domain), eq(schema.webDomains.status, "verified"), ne(schema.webDomains.projectId, projectId))).limit(1);
    return !!other;
  }

  r.get(`${P}/web_domain`, appsRead, async (c) => c.json(domainShape(c, await domainOf(db, c.get("projectId"), deps.now()))));
  r.put(`${P}/web_domain`, appsWrite, async (c) => {
    const projectId = c.get("projectId");
    const b = await body(c, DomainIn);
    const d = await domainOf(db, projectId, deps.now());
    const set: Partial<typeof schema.webDomains.$inferInsert> = {};
    if (b.slug !== undefined && b.slug !== d.slug) {
      if (await slugTaken(db, b.slug, projectId)) throw conflict("This address is taken. Pick another.", "slug");
      set.slug = b.slug;
    }
    if (b.custom_domain !== undefined && b.custom_domain !== d.customDomain) {
      if (b.custom_domain) {
        const knownHosts = [payBase(c), deps.publicUrl, deps.apiUrl].filter(Boolean).map((u) => { try { return new URL(u!).hostname; } catch { return ""; } });
        if (knownHosts.includes(b.custom_domain) || /(^|\.)revenuedot\.app$/.test(b.custom_domain)) throw paramError("Use a domain you own, such as pay.yourapp.com.", "custom_domain");
        // Only a verified claim blocks: anyone can type a domain, only its owner can add the TXT record.
        if (await verifiedElsewhere(b.custom_domain, projectId)) throw conflict("This domain is used by another project.", "custom_domain");
      }
      forgetHost(d.customDomain);
      Object.assign(set, { customDomain: b.custom_domain, status: b.custom_domain ? "pending" : "none", verifiedAt: null, checkedAt: null, error: null, verificationToken: newId("", 24) });
    }
    const [row] = Object.keys(set).length ? await db.update(schema.webDomains).set(set).where(eq(schema.webDomains.projectId, projectId)).returning() : [d];
    return c.json(domainShape(c, row!));
  });
  r.post(`${P}/web_domain/actions/verify`, appsWrite, async (c) => {
    const projectId = c.get("projectId");
    const d = await domainOf(db, projectId, deps.now());
    if (!d.customDomain) throw paramError("Set a custom domain first.", "custom_domain");
    const now = deps.now();
    if (!(await hit(db, `web-domain-verify:${projectId}`, 6, 60_000, now))) throw new V2Error(429, "rate_limit_error", "Wait a minute before checking again.", undefined, true);
    const v = await verifyDomain(deps.fetch ?? fetch, d, cnameTarget(deps.customDomainTarget, payBase(c)));
    const taken = v.ok && (await verifiedElsewhere(d.customDomain, projectId));
    const ok = v.ok && !taken;
    const set = { status: ok ? "verified" : "failed", verifiedAt: ok ? d.verifiedAt ?? now : null, checkedAt: now, error: taken ? "This domain is verified by another project." : v.error };
    let row;
    try {
      [row] = await db.update(schema.webDomains).set(set).where(eq(schema.webDomains.projectId, projectId)).returning();
    } catch (e) {
      // Another project verified the same domain at the same moment (the unique index on verified domains).
      if (!ok) throw e;
      [row] = await db.update(schema.webDomains).set({ ...set, status: "failed", verifiedAt: null, error: "This domain is verified by another project." }).where(eq(schema.webDomains.projectId, projectId)).returning();
    }
    forgetHost(d.customDomain);
    return c.json({ ...domainShape(c, row!), found: { cname: v.cname, txt: v.txt } });
  });

}
