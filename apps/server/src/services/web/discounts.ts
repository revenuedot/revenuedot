import { and, eq, inArray, or, sql } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";
import { formatMoney, majorToMinor } from "@revenuedot/core/funnels";
import type { Deps } from "../../context.js";
import { findCustomer } from "../../repo/customers.js";
import { withStoreSecrets } from "../store-secrets.js";
import { stripeClientFor } from "../../stores/stripe/index.js";
import { stripeKeyOf, StripeApiError } from "../../stores/stripe/api.js";
import { stripeAppsOf } from "./config.js";

/**
 * Web discounts (prd/web-billing/PRD.md §6): RevenueCat's v2 `discount` objects, created as a Stripe coupon in every Stripe
 * app of the project, with one Stripe promotion code per discount code. Checkout applies a code's promotion code or a
 * link's coupon after RevenueDot's own checks (enabled, expiry, cap, products, eligibility).
 */

export type DiscountRow = typeof schema.discounts.$inferSelect;
export type CodeRow = typeof schema.discountCodes.$inferSelect;

/** RevenueCat's `Discount` (DiscountPercentageVariant or DiscountFixedAmountVariant), nothing more: its schema is closed. */
export function discountShape(d: DiscountRow) {
  const common = {
    object: "discount" as const, id: d.id, identifier: d.identifier, customer_facing_name: d.customerFacingName, duration_mode: d.durationMode,
    eligibility: d.eligibility, time_window: d.timeWindow ?? null, disabled_at: d.disabledAt ? d.disabledAt.getTime() : null,
  };
  const times = { created_at: d.createdAt.getTime(), updated_at: d.updatedAt.getTime() };
  return d.type === "percentage"
    ? { ...common, type: "percentage" as const, percentage: d.percentage ?? 0, ...times }
    : { ...common, type: "fixed_amount" as const, fixed_amount: d.fixedAmounts ?? {}, ...times };
}

export const codeShape = (c: CodeRow) => ({ object: "discount_code" as const, code: c.code, created_at: c.createdAt.getTime() });

/** Months in an ISO 8601 duration of whole months or years (P3M, P1Y, P1Y6M); null for anything Stripe cannot repeat by. */
export function monthsOf(window: string | null | undefined): number | null {
  const m = /^P(?:(\d+)Y)?(?:(\d+)M)?$/.exec(window ?? "");
  if (!m || (!m[1] && !m[2])) return null;
  const n = Number(m[1] ?? 0) * 12 + Number(m[2] ?? 0);
  return n >= 1 && n <= 36 ? n : null;
}

/** "20% off for 3 months", "$5.00 off your first payment". */
export function discountLabel(d: DiscountRow, currency?: string | null): string {
  let what: string;
  if (d.type === "percentage") what = `${d.percentage}% off`;
  else {
    const amounts = d.fixedAmounts ?? {};
    const cur = currency && amounts[currency.toUpperCase()] !== undefined ? currency.toUpperCase() : Object.keys(amounts)[0] ?? "USD";
    what = `${formatMoney(majorToMinor(amounts[cur] ?? 0, cur), cur)} off`;
  }
  if (d.durationMode === "forever") return `${what}, every payment`;
  if (d.durationMode === "time_window") { const n = monthsOf(d.timeWindow); return `${what} for ${n} month${n === 1 ? "" : "s"}`; }
  return `${what} your first payment`;
}

/** Stripe product ids for the discount's product identifiers (store identifiers or RevenueDot product ids) in one app. */
async function stripeProductsFor(db: DB, d: DiscountRow, appId: string): Promise<string[] | null> {
  const ids = d.productIdentifiers ?? [];
  if (!ids.length) return null;
  const rows = await db.select({ product: schema.products, web: schema.webProducts }).from(schema.products)
    .leftJoin(schema.webProducts, eq(schema.webProducts.productId, schema.products.id))
    .where(and(eq(schema.products.projectId, d.projectId), eq(schema.products.appId, appId), or(inArray(schema.products.storeIdentifier, ids), inArray(schema.products.id, ids))));
  const out = new Set<string>();
  for (const r of rows) {
    if (r.web) out.add(r.web.stripeProductId);
    else if (r.product.storeIdentifier.startsWith("prod_")) out.add(r.product.storeIdentifier);
  }
  return [...out];
}

/** The Stripe coupon parameters for a discount (https://docs.stripe.com/api/coupons/create). */
export async function couponParams(db: DB, d: DiscountRow, appId: string): Promise<Record<string, unknown>> {
  const p: Record<string, unknown> = { name: d.customerFacingName.slice(0, 40), metadata: { revenuedot_discount: d.id, revenuedot_identifier: d.identifier } };
  if (d.type === "percentage") p.percent_off = d.percentage;
  else {
    const entries = Object.entries(d.fixedAmounts ?? {});
    const [first, ...rest] = entries;
    if (first) {
      p.amount_off = majorToMinor(first[1], first[0]);
      p.currency = first[0].toLowerCase();
      if (rest.length) p.currency_options = Object.fromEntries(rest.map(([c, a]) => [c.toLowerCase(), { amount_off: majorToMinor(a, c) }]));
    }
  }
  if (d.durationMode === "forever") p.duration = "forever";
  else if (d.durationMode === "time_window") { p.duration = "repeating"; p.duration_in_months = monthsOf(d.timeWindow); }
  else p.duration = "once";
  if (d.maxRedemptions) p.max_redemptions = d.maxRedemptions;
  if (d.expiresAt) p.redeem_by = Math.floor(d.expiresAt.getTime() / 1000);
  const products = await stripeProductsFor(db, d, appId);
  if (products?.length) p.applies_to = { products };
  return p;
}

export class StripeSyncError extends Error {
  constructor(message: string, public retryable: boolean) { super(message); }
}
const syncError = (e: unknown) => {
  if (e instanceof StripeApiError) return new StripeSyncError(`Stripe: ${e.message}`, e.kind === "transient");
  return e;
};

async function stripeApps(deps: Deps, projectId: string) {
  const out = [];
  for (const a of await stripeAppsOf(deps.db, projectId)) {
    const opened = await withStoreSecrets(deps, a);
    if (stripeKeyOf(opened)) out.push(opened);
  }
  return out;
}

/** Creates the discount's coupon in every Stripe app that has none yet. Returns the stored Stripe map. */
export async function syncCoupons(deps: Deps, d: DiscountRow, opts: { recreate?: boolean } = {}): Promise<DiscountRow> {
  const { client } = stripeClientFor(deps.stores, deps.fetch);
  const map = { ...(d.stripe ?? {}) };
  try {
    for (const app of await stripeApps(deps, d.projectId)) {
      if (map[app.id] && !opts.recreate) continue;
      if (map[app.id] && opts.recreate) {
        await client.del(app, `/v1/coupons/${encodeURIComponent(map[app.id]!.coupon)}`).catch((e) => { if (!(e instanceof StripeApiError && e.kind === "not_found")) throw e; });
      }
      const c = await client.post<{ id: string }>(app, "/v1/coupons", await couponParams(deps.db, d, app.id), `rd-coupon-${d.id}-${app.id}-${d.updatedAt.getTime()}`);
      map[app.id] = { coupon: c.id };
    }
  } catch (e) { throw syncError(e); }
  const [row] = await deps.db.update(schema.discounts).set({ stripe: map }).where(eq(schema.discounts.id, d.id)).returning();
  return row!;
}

/** Promotion codes for `codes` in every Stripe app of the discount; active unless the discount is disabled. */
export async function syncCodes(deps: Deps, d: DiscountRow, codes: CodeRow[], opts: { recreate?: boolean } = {}) {
  const { client } = stripeClientFor(deps.stores, deps.fetch);
  try {
    for (const app of await stripeApps(deps, d.projectId)) {
      const coupon = d.stripe?.[app.id]?.coupon;
      if (!coupon) continue;
      for (const code of codes) {
        const have = code.stripe?.[app.id];
        if (have && !opts.recreate) continue;
        if (have && opts.recreate) await client.post(app, `/v1/promotion_codes/${encodeURIComponent(have)}`, { active: false }).catch(() => {});
        const params: Record<string, unknown> = { coupon, code: code.code, active: !d.disabledAt, metadata: { revenuedot_discount: d.id } };
        if (d.expiresAt) params.expires_at = Math.floor(d.expiresAt.getTime() / 1000);
        const pc = await client.post<{ id: string }>(app, "/v1/promotion_codes", params, `rd-promo-${d.id}-${app.id}-${code.codeKey}-${coupon}`);
        const stripe = { ...(code.stripe ?? {}), [app.id]: pc.id };
        await deps.db.update(schema.discountCodes).set({ stripe }).where(and(eq(schema.discountCodes.projectId, d.projectId), eq(schema.discountCodes.codeKey, code.codeKey)));
        code.stripe = stripe;
      }
    }
  } catch (e) { throw syncError(e); }
}

/** Turns the promotion codes on or off in Stripe (enable, disable, delete a code). */
export async function setCodesActive(deps: Deps, d: DiscountRow, codes: CodeRow[], active: boolean) {
  const { client } = stripeClientFor(deps.stores, deps.fetch);
  try {
    for (const app of await stripeApps(deps, d.projectId)) {
      for (const code of codes) {
        const id = code.stripe?.[app.id];
        if (id) await client.post(app, `/v1/promotion_codes/${encodeURIComponent(id)}`, { active });
      }
    }
  } catch (e) { throw syncError(e); }
}

export async function deleteCoupons(deps: Deps, d: DiscountRow) {
  const { client } = stripeClientFor(deps.stores, deps.fetch);
  try {
    for (const app of await stripeApps(deps, d.projectId)) {
      const coupon = d.stripe?.[app.id]?.coupon;
      if (coupon) await client.del(app, `/v1/coupons/${encodeURIComponent(coupon)}`).catch((e) => { if (!(e instanceof StripeApiError && e.kind === "not_found")) throw e; });
    }
  } catch (e) { throw syncError(e); }
}

export const codeKeyOf = (code: string) => code.trim().toUpperCase();

export interface AppliedDiscount { discount: DiscountRow; code: CodeRow | null; stripe: { promotion_code: string } | { coupon: string }; label: string }

/**
 * The discount a checkout may use: a typed code, or an automatic discount (a link's or a paywall step's). Throws a message
 * for the buyer when it does not apply.
 */
export async function discountForCheckout(db: DB, o: {
  projectId: string; appId: string; code?: string | null; discountId?: string | null; product: { id: string; storeIdentifier: string }; currency: string; appUserId?: string | null; now: Date;
  /** With deps, a discount or code made before the Stripe app had a key is created in Stripe now. */
  deps?: Deps;
}): Promise<AppliedDiscount | null> {
  let d: DiscountRow | undefined, code: CodeRow | null = null;
  if (o.code?.trim()) {
    const [c] = await db.select().from(schema.discountCodes).where(and(eq(schema.discountCodes.projectId, o.projectId), eq(schema.discountCodes.codeKey, codeKeyOf(o.code)))).limit(1);
    if (!c) throw new DiscountRefused("This code is not valid.");
    code = c;
    [d] = await db.select().from(schema.discounts).where(eq(schema.discounts.id, c.discountId)).limit(1);
  } else if (o.discountId) {
    [d] = await db.select().from(schema.discounts).where(and(eq(schema.discounts.projectId, o.projectId), eq(schema.discounts.id, o.discountId))).limit(1);
    if (!d) return null;
  } else return null;
  if (!d) throw new DiscountRefused("This code is not valid.");
  if (d.disabledAt) throw new DiscountRefused("This code is no longer active.");
  if (d.expiresAt && d.expiresAt <= o.now) throw new DiscountRefused("This code has expired.");
  if (d.maxRedemptions && d.timesRedeemed >= d.maxRedemptions) throw new DiscountRefused("This code has been used the maximum number of times.");
  const ids = d.productIdentifiers ?? [];
  if (ids.length && !ids.includes(o.product.storeIdentifier) && !ids.includes(o.product.id)) throw new DiscountRefused("This code does not apply to this plan.");
  if (d.type === "fixed_amount" && (d.fixedAmounts ?? {})[o.currency.toUpperCase()] === undefined) throw new DiscountRefused(`This code does not apply to payments in ${o.currency.toUpperCase()}.`);
  if (d.eligibility !== "everyone" && o.appUserId) {
    const cust = await findCustomer(db, o.projectId, o.appUserId);
    if (cust) {
      const subs = await db.select({ p: schema.subscriptions.productIdentifier }).from(schema.subscriptions).where(eq(schema.subscriptions.customerId, cust.id));
      const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.nonSubscriptions).where(eq(schema.nonSubscriptions.customerId, cust.id));
      const refused = d.eligibility === "never_purchased" ? subs.length + n > 0
        : d.eligibility === "never_subscribed" ? subs.length > 0
        : subs.some((s) => s.p === o.product.storeIdentifier);
      if (refused) throw new DiscountRefused("This code is for new customers only.");
    }
  }
  if (o.deps && (!d.stripe?.[o.appId] || (code && !code.stripe?.[o.appId]))) {
    try {
      if (!d.stripe?.[o.appId]) d = await syncCoupons(o.deps, d);
      if (code) await syncCodes(o.deps, d, [code]);
    } catch (e) {
      console.error("discount sync at checkout", e instanceof Error ? e.message : e);
    }
  }
  const coupon = d.stripe?.[o.appId]?.coupon;
  if (!coupon) throw new DiscountRefused("This code cannot be used right now.");
  let stripe: AppliedDiscount["stripe"];
  if (code) {
    const promo = code.stripe?.[o.appId];
    if (!promo) throw new DiscountRefused("This code cannot be used right now.");
    stripe = { promotion_code: promo };
  } else stripe = { coupon };
  return { discount: d, code, stripe, label: discountLabel(d, o.currency) };
}

export class DiscountRefused extends Error {}

/** Counts one use of the discount (and its code) once a checkout that used it is paid. */
export async function countRedemption(db: DB, projectId: string, discountId: string, codeKey: string | null) {
  await db.update(schema.discounts).set({ timesRedeemed: sql`${schema.discounts.timesRedeemed} + 1` }).where(eq(schema.discounts.id, discountId));
  if (codeKey) await db.update(schema.discountCodes).set({ timesRedeemed: sql`${schema.discountCodes.timesRedeemed} + 1` }).where(and(eq(schema.discountCodes.projectId, projectId), eq(schema.discountCodes.codeKey, codeKey)));
}
