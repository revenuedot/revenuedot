import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { newId } from "@revenuedot/core";
import { schema } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import {
  codeKeyOf, codeShape, deleteCoupons, discountLabel, discountShape, monthsOf, setCodesActive, StripeSyncError, syncCodes, syncCoupons,
  type CodeRow, type DiscountRow,
} from "../../services/web/discounts.js";
import { body, conflict, notFound, paginate, paramError, scope, V2Error, type V2Context, type V2Router } from "./common.js";

/**
 * Web discounts: RevenueCat's 10 v2 discount operations (prd/web-billing/PRD.md §6), real for RevenueDot's own web
 * checkout on the developer's Stripe. Responses are exactly RevenueCat's `Discount`, `DiscountCode` and `DeletedObject`
 * (closed schemas). RevenueDot's additions (`max_redemptions`, `expires_at`) are accepted in requests and read back from
 * the extension list `GET /v2/projects/{id}/web_discounts`.
 */

const Amount = z.object({ currency: z.string().regex(/^[A-Za-z]{3}$/), amount: z.number().positive().max(1_000_000) });
const Base = {
  customer_facing_name: z.string().trim().min(1).max(255),
  type: z.enum(["percentage", "fixed_amount"]),
  percentage: z.number().int().min(1).max(100).optional(),
  fixed_amounts: z.record(Amount).optional(),
  duration_mode: z.enum(["one_time", "time_window", "forever"]),
  eligibility: z.enum(["everyone", "never_purchased", "never_subscribed", "never_subscribed_to_the_same_product"]),
  time_window: z.string().max(20).optional(),
  product_identifiers: z.array(z.string().min(1).max(255)).max(100).optional(),
  max_redemptions: z.number().int().min(1).max(10_000_000).nullable().optional(),
  expires_at: z.number().int().positive().nullable().optional(),
};
const Create = z.object({ identifier: z.string().trim().min(1).max(255).regex(/^[A-Za-z0-9_.-]+$/, "may use letters, digits, _ . -"), ...Base });
const Update = z.object({ ...Base, customer_facing_name: Base.customer_facing_name.optional(), type: Base.type.optional(), duration_mode: Base.duration_mode.optional(), eligibility: Base.eligibility.optional() });
const Codes = z.object({ codes: z.array(z.string().trim().min(1).max(255).regex(/^[A-Za-z0-9_-]+$/, "may use letters, digits, _ and -")).min(1).max(10_000) });

/** The checks RevenueCat's request schema implies, on the merged result. */
function checkShape(d: { type: string; percentage?: number | null; fixed_amounts?: Record<string, number> | null; duration_mode: string; time_window?: string | null }) {
  if (d.type === "percentage" && !d.percentage) throw paramError("percentage is required for a percentage discount (1-100).", "percentage");
  if (d.type === "fixed_amount" && !Object.keys(d.fixed_amounts ?? {}).length) throw paramError("fixed_amounts is required for a fixed amount discount.", "fixed_amounts");
  if (d.duration_mode === "time_window" && monthsOf(d.time_window) === null) throw paramError("time_window must be whole months or years between 1 and 36 months (P3M, P1Y) for a time_window discount.", "time_window");
}
const amountsOf = (fa: Record<string, { currency: string; amount: number }> | undefined) => {
  if (!fa) return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(fa)) {
    if (k.toUpperCase() !== v.currency.toUpperCase()) throw paramError(`fixed_amounts.${k}: the key must be the currency code.`, `fixed_amounts.${k}`);
    out[v.currency.toUpperCase()] = v.amount;
  }
  return out;
};
const storeError = (e: unknown) => {
  if (e instanceof StripeSyncError) return new V2Error(422, "store_error", e.message, undefined, e.retryable);
  return e;
};

export function discountRoutes(r: V2Router, deps: Deps) {
  const { db } = deps;
  const D = "/v2/projects/:project_id/discounts";
  const read = scope("project_configuration:discounts:read");
  const write = scope("project_configuration:discounts:read_write");

  const find = async (projectId: string, id: string) => {
    const [d] = await db.select().from(schema.discounts).where(and(eq(schema.discounts.projectId, projectId), eq(schema.discounts.id, id))).limit(1);
    if (!d) throw new V2Error(404, "resource_missing", "Discount not found.", "discount_id");
    return d;
  };
  const codesOf = (id: string) => db.select().from(schema.discountCodes).where(eq(schema.discountCodes.discountId, id)).orderBy(asc(schema.discountCodes.createdAt), asc(schema.discountCodes.codeKey));

  r.get(D, read, async (c) => {
    const rows = await db.select().from(schema.discounts).where(eq(schema.discounts.projectId, c.get("projectId")));
    return c.json(paginate(c, rows, (d) => d.id, (d) => d.createdAt.getTime(), discountShape));
  });

  r.post(D, write, async (c) => {
    const projectId = c.get("projectId");
    const b = await body(c, Create);
    const fixed = amountsOf(b.fixed_amounts);
    checkShape({ ...b, fixed_amounts: fixed });
    const [dup] = await db.select({ id: schema.discounts.id }).from(schema.discounts).where(and(eq(schema.discounts.projectId, projectId), eq(schema.discounts.identifier, b.identifier))).limit(1);
    if (dup) throw conflict("A discount with this identifier already exists.", "identifier");
    const now = deps.now();
    const [row] = await db.insert(schema.discounts).values({
      id: newId("disc", 14), projectId, identifier: b.identifier, customerFacingName: b.customer_facing_name, type: b.type,
      percentage: b.type === "percentage" ? b.percentage! : null, fixedAmounts: b.type === "fixed_amount" ? fixed! : null,
      durationMode: b.duration_mode, timeWindow: b.duration_mode === "time_window" ? b.time_window! : null, eligibility: b.eligibility,
      productIdentifiers: b.product_identifiers?.length ? b.product_identifiers : null, maxRedemptions: b.max_redemptions ?? null,
      expiresAt: b.expires_at ? new Date(b.expires_at) : null, createdAt: now, updatedAt: now,
    }).returning();
    let saved = row!;
    try { saved = await syncCoupons(deps, saved); } catch (e) {
      await db.delete(schema.discounts).where(eq(schema.discounts.id, saved.id));
      throw storeError(e);
    }
    return c.json(discountShape(saved), 201);
  });

  r.get(`${D}/:discount_id`, read, async (c) => c.json(discountShape(await find(c.get("projectId"), c.req.param("discount_id")!))));

  r.patch(`${D}/:discount_id`, write, async (c) => {
    const d = await find(c.get("projectId"), c.req.param("discount_id")!);
    const b = await body(c, Update);
    const fixed = amountsOf(b.fixed_amounts);
    const type = b.type ?? d.type;
    const merged = {
      type, percentage: type === "percentage" ? b.percentage ?? d.percentage : null, fixed_amounts: type === "fixed_amount" ? fixed ?? d.fixedAmounts : null,
      duration_mode: b.duration_mode ?? d.durationMode, time_window: (b.duration_mode ?? d.durationMode) === "time_window" ? b.time_window ?? d.timeWindow : null,
    };
    checkShape(merged);
    const money = ["type", "percentage", "fixed_amounts", "duration_mode", "time_window", "product_identifiers", "max_redemptions", "expires_at"].some((k) => (b as Record<string, unknown>)[k] !== undefined);
    const [row] = await db.update(schema.discounts).set({
      customerFacingName: b.customer_facing_name ?? d.customerFacingName, type, percentage: merged.percentage, fixedAmounts: merged.fixed_amounts,
      durationMode: merged.duration_mode, timeWindow: merged.time_window, eligibility: b.eligibility ?? d.eligibility,
      ...(b.product_identifiers !== undefined ? { productIdentifiers: b.product_identifiers.length ? b.product_identifiers : null } : {}),
      ...(b.max_redemptions !== undefined ? { maxRedemptions: b.max_redemptions } : {}), ...(b.expires_at !== undefined ? { expiresAt: b.expires_at ? new Date(b.expires_at) : null } : {}),
      updatedAt: deps.now(),
    }).where(eq(schema.discounts.id, d.id)).returning();
    let saved = row!;
    // Stripe coupons cannot change their amount or duration: a new coupon (and new promotion codes) replace the old ones.
    if (money) {
      try {
        const codes = await codesOf(d.id);
        await setCodesActive(deps, saved, codes, false);
        saved = await syncCoupons(deps, saved, { recreate: true });
        await syncCodes(deps, saved, codes, { recreate: true });
      } catch (e) { throw storeError(e); }
    }
    return c.json(discountShape(saved));
  });

  r.delete(`${D}/:discount_id`, write, async (c) => {
    const d = await find(c.get("projectId"), c.req.param("discount_id")!);
    try {
      await setCodesActive(deps, d, await codesOf(d.id), false);
      await deleteCoupons(deps, d);
    } catch (e) { throw storeError(e); }
    await db.delete(schema.discounts).where(eq(schema.discounts.id, d.id));
    return c.json({ object: "discount", id: d.id, deleted_at: deps.now().getTime() });
  });

  const toggle = (enable: boolean) => async (c: V2Context) => {
    const d = await find(c.get("projectId"), c.req.param("discount_id")!);
    const now = deps.now();
    const [row] = await db.update(schema.discounts).set({ disabledAt: enable ? null : d.disabledAt ?? now, updatedAt: now }).where(eq(schema.discounts.id, d.id)).returning();
    try { await setCodesActive(deps, row!, await codesOf(d.id), enable); } catch (e) { throw storeError(e); }
    return c.json(discountShape(row!));
  };
  r.post(`${D}/:discount_id/actions/enable`, write, toggle(true));
  r.post(`${D}/:discount_id/actions/disable`, write, toggle(false));

  r.get(`${D}/:discount_id/discount_codes`, read, async (c) => {
    const d = await find(c.get("projectId"), c.req.param("discount_id")!);
    const rows = await codesOf(d.id);
    return c.json(paginate(c, rows, (x) => x.code, (x) => x.createdAt.getTime(), codeShape));
  });

  r.post(`${D}/:discount_id/discount_codes`, write, async (c) => {
    const projectId = c.get("projectId");
    const d = await find(projectId, c.req.param("discount_id")!);
    const b = await body(c, Codes);
    const keys = b.codes.map(codeKeyOf);
    if (new Set(keys).size !== keys.length) throw paramError("codes has the same code twice (codes are not case sensitive).", "codes");
    const taken = await db.select({ code: schema.discountCodes.code }).from(schema.discountCodes).where(and(eq(schema.discountCodes.projectId, projectId), inArray(schema.discountCodes.codeKey, keys)));
    if (taken.length) throw conflict(`The code ${taken[0]!.code} is already used in this project.`, "codes");
    const now = deps.now();
    const rows: CodeRow[] = await db.insert(schema.discountCodes).values(b.codes.map((code) => ({ projectId, codeKey: codeKeyOf(code), code, discountId: d.id, createdAt: now }))).returning();
    try {
      const synced = Object.keys(d.stripe ?? {}).length ? d : await syncCoupons(deps, d);
      await syncCodes(deps, synced, rows);
    } catch (e) {
      await db.delete(schema.discountCodes).where(and(eq(schema.discountCodes.projectId, projectId), inArray(schema.discountCodes.codeKey, keys)));
      throw storeError(e);
    }
    return c.json(rows.map(codeShape), 201);
  });

  r.delete(`${D}/:discount_id/discount_codes/:discount_code`, write, async (c) => {
    const projectId = c.get("projectId");
    const d = await find(projectId, c.req.param("discount_id")!);
    const key = codeKeyOf(decodeURIComponent(c.req.param("discount_code")!));
    const [code] = await db.select().from(schema.discountCodes).where(and(eq(schema.discountCodes.projectId, projectId), eq(schema.discountCodes.codeKey, key), eq(schema.discountCodes.discountId, d.id))).limit(1);
    if (!code) throw notFound("Discount code");
    try { await setCodesActive(deps, d, [code], false); } catch (e) { throw storeError(e); }
    await db.delete(schema.discountCodes).where(and(eq(schema.discountCodes.projectId, projectId), eq(schema.discountCodes.codeKey, key)));
    return c.json({ object: "discount_code", id: code.code, deleted_at: deps.now().getTime() });
  });

  // RevenueDot extension: discounts with the settings RevenueCat's closed schema has no room for, codes and Stripe ids.
  r.get("/v2/projects/:project_id/web_discounts", read, async (c) => {
    const projectId = c.get("projectId");
    const rows = await db.select().from(schema.discounts).where(eq(schema.discounts.projectId, projectId));
    const codes = rows.length ? await db.select().from(schema.discountCodes).where(inArray(schema.discountCodes.discountId, rows.map((d) => d.id))) : [];
    const now = deps.now();
    const shape = (d: DiscountRow) => ({
      ...discountShape(d), object: "web_discount" as const, label: discountLabel(d), product_identifiers: d.productIdentifiers ?? [], max_redemptions: d.maxRedemptions,
      expires_at: d.expiresAt ? d.expiresAt.getTime() : null, times_redeemed: d.timesRedeemed,
      status: d.disabledAt ? "disabled" : d.expiresAt && d.expiresAt <= now ? "expired" : d.maxRedemptions && d.timesRedeemed >= d.maxRedemptions ? "used_up" : "active",
      stripe: Object.entries(d.stripe ?? {}).map(([app_id, v]) => ({ app_id, coupon_id: v.coupon })),
      codes: codes.filter((x) => x.discountId === d.id).map((x) => ({ code: x.code, times_redeemed: x.timesRedeemed, created_at: x.createdAt.getTime(), stripe_promotion_codes: x.stripe })),
    });
    return c.json(paginate(c, rows, (d) => d.id, (d) => d.createdAt.getTime(), shape));
  });
}
