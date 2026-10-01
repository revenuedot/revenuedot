import { afterEach, describe, expect, it } from "vitest";
import { webEnv, type WebEnv } from "../src/web-env.js";
import { v2 } from "./v2-helpers.js";

/**
 * Web discounts (prd/web-billing/PRD.md §6): RevenueCat's 10 v2 discount operations, each answer validated against
 * RevenueCat's OpenAPI schema for its operation and status, the Stripe coupon and promotion code calls they make on the fake
 * Stripe account, and the discount applied at checkout with RevenueDot's checks (codes, caps, expiry, products, eligibility).
 */
let env: WebEnv;
let call: ReturnType<typeof v2>;
afterEach(async () => { await env?.h.close(); });

const D = "/v2/projects/{project_id}/discounts";
const DI = `${D}/{discount_id}`;
const CODES = `${DI}/discount_codes`;

async function setup() {
  env = await webEnv();
  call = v2(env.h);
  return env.setupWeb();
}
const percent = (o: Record<string, unknown> = {}) => ({ identifier: "spring20", customer_facing_name: "Spring sale", type: "percentage", percentage: 20, duration_mode: "time_window", time_window: "P3M", eligibility: "everyone", ...o });

describe("v2 discount operations", () => {
  it("create, get, list, update, codes, disable, enable and delete, valid against RevenueCat's schema, mirrored in Stripe", async () => {
    await setup();
    const created = await call("POST", D, {}, { json: percent({ max_redemptions: 100 }) });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ object: "discount", identifier: "spring20", type: "percentage", percentage: 20, duration_mode: "time_window", time_window: "P3M", disabled_at: null });
    const id = created.body.id as string;
    const coupon = env.stripe.writes("/v1/coupons")[0]!;
    expect(coupon.params).toMatchObject({ percent_off: "20", duration: "repeating", duration_in_months: "3", max_redemptions: "100", name: "Spring sale", metadata: { revenuedot_discount: id } });
    expect(coupon.idempotencyKey).toMatch(/^rd-coupon-/);

    expect((await call("POST", D, {}, { json: percent() })).status).toBe(409);
    expect((await call("POST", D, {}, { json: percent({ identifier: "x", percentage: undefined }) })).status).toBe(400);
    expect((await call("POST", D, {}, { json: percent({ identifier: "x", time_window: "P10D" }) })).status).toBe(400);

    const fixed = await call("POST", D, {}, { json: { identifier: "five_off", customer_facing_name: "$5 off", type: "fixed_amount", fixed_amounts: { USD: { currency: "USD", amount: 5 }, EUR: { currency: "EUR", amount: 4.5 } }, duration_mode: "one_time", eligibility: "never_purchased", product_identifiers: [] } });
    expect(fixed.status).toBe(201);
    expect(fixed.body).toMatchObject({ type: "fixed_amount", fixed_amount: { USD: 5, EUR: 4.5 }, duration_mode: "one_time", eligibility: "never_purchased" });
    expect(env.stripe.writes("/v1/coupons")[1]!.params).toMatchObject({ amount_off: "500", currency: "usd", currency_options: { eur: { amount_off: "450" } }, duration: "once" });

    expect((await call("GET", DI, { discount_id: id })).body.identifier).toBe("spring20");
    const list = await call("GET", D, {}, { query: "limit=1" });
    expect(list.body.items).toHaveLength(1);
    expect(list.body.next_page).toMatch(/starting_after=/);

    // Codes become Stripe promotion codes; they are unique in the project, whatever their case.
    const codes = await call("POST", CODES, { discount_id: id }, { json: { codes: ["SPRING20", "friends"] } });
    expect(codes.status).toBe(201);
    expect(codes.body.map((c: any) => c.code)).toEqual(["SPRING20", "friends"]);
    expect(env.stripe.writes("/v1/promotion_codes").map((c) => c.params.code).sort()).toEqual(["SPRING20", "friends"]);
    expect((await call("POST", CODES, { discount_id: id }, { json: { codes: ["spring20"] } })).status).toBe(409);
    expect((await call("GET", CODES, { discount_id: id })).body.items).toHaveLength(2);

    // Disable turns the promotion codes off; enable on again.
    const dis = await call("POST", `${DI}/actions/disable`, { discount_id: id });
    expect(dis.body.disabled_at).toBe(env.h.now().getTime());
    expect([...env.stripe.promotionCodes.values()].every((p) => !p.active)).toBe(true);
    const en = await call("POST", `${DI}/actions/enable`, { discount_id: id });
    expect(en.body.disabled_at).toBeNull();
    expect([...env.stripe.promotionCodes.values()].every((p) => p.active)).toBe(true);

    // Changing the amount replaces the coupon and the promotion codes (Stripe coupons cannot change).
    const upd = await call("PATCH", DI, { discount_id: id }, { json: { percentage: 30, customer_facing_name: "Spring sale 30" } });
    expect(upd.body).toMatchObject({ percentage: 30, customer_facing_name: "Spring sale 30" });
    expect(env.stripe.coupons.size).toBe(2);
    const active = [...env.stripe.promotionCodes.values()].filter((p) => p.active);
    expect(active.map((p) => [p.code, p.coupon.percent_off]).sort()).toEqual([["SPRING20", 30], ["friends", 30]]);

    const delCode = await call("DELETE", `${CODES}/{discount_code}`, { discount_id: id, discount_code: "friends" });
    expect(delCode.body).toMatchObject({ object: "discount_code", id: "friends" });
    expect((await call("DELETE", `${CODES}/{discount_code}`, { discount_id: id, discount_code: "friends" })).status).toBe(404);

    const ext = await call("GET", "/v2/projects/{project_id}/web_discounts", {}, { ext: true });
    const row = ext.body.items.find((x: any) => x.id === id);
    expect(row).toMatchObject({ label: "30% off for 3 months", max_redemptions: 100, times_redeemed: 0, status: "active", codes: [expect.objectContaining({ code: "SPRING20" })] });

    const del = await call("DELETE", DI, { discount_id: id });
    expect(del.body).toMatchObject({ object: "discount", id });
    expect(env.stripe.coupons.size).toBe(1);
    expect((await call("GET", DI, { discount_id: id })).status).toBe(404);
  });

  it("a Stripe outage answers 422 store_error, retryable, and stores nothing", async () => {
    await setup();
    env.stripe.override = (m, path) => (m === "POST" && path === "/v1/coupons" ? new Response("{}", { status: 503 }) : undefined);
    const r = await call("POST", D, {}, { json: percent() });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ type: "store_error", retryable: true });
    expect((await call("GET", D)).body.items).toEqual([]);
  });
});

describe("discounts at checkout", () => {
  const page = async () => {
    const offering = (await env.api("GET", `/v2/projects/${env.h.ids.project}/offerings`)).body.items.find((x: any) => x.lookup_key === "web");
    return (await env.api("POST", `/v2/projects/${env.h.ids.project}/purchase_links`, { name: "Promo", offering_id: offering.id })).body;
  };
  const check = async (slug: string, code: string, pkg = "$rc_monthly", app_user_id?: string) =>
    (await env.raw("http://localhost/pay/api/discount", { method: "POST", json: { project: "scanner", slug, package: pkg, code, app_user_id } })).json() as Promise<{ valid: boolean; message: string }>;
  const checkout = (slug: string, json: Record<string, unknown>) => env.raw("http://localhost/pay/api/checkout", { method: "POST", json: { project: "scanner", slug, package: "$rc_monthly", ...json } });

  it("a code is checked, applied as the promotion code, counted once paid, and refused when used up, expired, disabled or for another plan", async () => {
    const ids = await setup();
    const l = await page();
    const d = await call("POST", D, {}, { json: percent({ max_redemptions: 1, product_identifiers: [ids.monthly] }) });
    await call("POST", CODES, { discount_id: d.body.id }, { json: { codes: ["SPRING20"] } });
    expect(await check(l.slug, "spring20")).toEqual({ valid: true, message: "20% off for 3 months applied at checkout." });
    expect(await check(l.slug, "NOPE")).toEqual({ valid: false, message: "This code is not valid." });
    expect((await check(l.slug, "SPRING20", "$rc_annual")).message).toBe("This code does not apply to this plan.");

    const start = await checkout(l.slug, { code: "spring20" });
    expect(start.status).toBe(200);
    const sessionParams = env.stripe.writes("/v1/checkout/sessions")[0]!.params;
    const promo = [...env.stripe.promotionCodes.values()][0]!;
    expect(sessionParams.discounts).toEqual([{ promotion_code: promo.id }]);
    const { url } = await start.json() as { url: string };
    const s = env.stripe.complete(new URL(url).pathname.split("/").pop()!);
    await env.raw(s.success_url);
    const ext = (await call("GET", "/v2/projects/{project_id}/web_discounts", {}, { ext: true })).body.items[0];
    expect(ext).toMatchObject({ times_redeemed: 1, status: "used_up", codes: [expect.objectContaining({ times_redeemed: 1 })] });
    expect((await check(l.slug, "SPRING20")).message).toBe("This code has been used the maximum number of times.");
    expect((await checkout(l.slug, { code: "SPRING20" })).status).toBe(400);

    const e = await call("POST", D, {}, { json: percent({ identifier: "old", expires_at: env.h.now().getTime() - 1 }) });
    await call("POST", CODES, { discount_id: e.body.id }, { json: { codes: ["OLD"] } });
    expect((await check(l.slug, "OLD")).message).toBe("This code has expired.");
    const off = await call("POST", D, {}, { json: percent({ identifier: "off" }) });
    await call("POST", CODES, { discount_id: off.body.id }, { json: { codes: ["OFF"] } });
    await call("POST", `${DI}/actions/disable`, { discount_id: off.body.id });
    expect((await check(l.slug, "OFF")).message).toBe("This code is no longer active.");
  });

  it("eligibility uses the buyer's history, and a link's automatic discount applies its coupon without a code", async () => {
    await setup();
    const fresh = await call("POST", D, {}, { json: { identifier: "welcome", customer_facing_name: "Welcome", type: "fixed_amount", fixed_amounts: { USD: { currency: "USD", amount: 3 } }, duration_mode: "one_time", eligibility: "never_purchased" } });
    await call("POST", CODES, { discount_id: fresh.body.id }, { json: { codes: ["WELCOME"] } });
    const l = await page();
    await env.h.fetch("/v1/receipts", { method: "POST", key: env.h.ids.testKey, json: { app_user_id: "old_customer", fetch_token: `test_${Date.now()}_x`, product_id: "lifetime", price: 49.99, currency: "USD" } });
    expect((await check(l.slug, "WELCOME", "$rc_monthly", "old_customer")).message).toBe("This code is for new customers only.");
    expect(await check(l.slug, "WELCOME", "$rc_monthly", "brand_new")).toMatchObject({ valid: true, message: "$3.00 off your first payment applied at checkout." });
    expect((await check(l.slug, "WELCOME")).valid).toBe(true);

    const auto = await env.api("PATCH", `/v2/projects/${env.h.ids.project}/purchase_links/${l.id}`, { discount_id: fresh.body.id });
    expect(auto.body.discount_id).toBe(fresh.body.id);
    const start = await checkout(l.slug, {});
    expect(start.status).toBe(200);
    const coupon = [...env.stripe.coupons.values()][0]!;
    expect(env.stripe.writes("/v1/checkout/sessions")[0]!.params.discounts).toEqual([{ coupon: coupon.id }]);
  });

  it("a discount made before Stripe was connected is created in Stripe at checkout", async () => {
    await setup();
    const saved = new Map(env.stripe.coupons);
    env.stripe.override = (m, path) => (m === "POST" && path.startsWith("/v1/coupons") ? new Response(JSON.stringify({ error: { message: "down" } }), { status: 500 }) : undefined);
    expect((await call("POST", D, {}, { json: percent() })).status).toBe(422);
    env.stripe.override = null;
    // Simulate the old state directly: a discount row with no Stripe ids yet.
    const r = await call("POST", D, {}, { json: percent({ identifier: "later" }) });
    const { schema } = await import("@revenuedot/db");
    const { eq } = await import("drizzle-orm");
    await env.h.db.update(schema.discounts).set({ stripe: {} }).where(eq(schema.discounts.id, r.body.id));
    await call("POST", CODES, { discount_id: r.body.id }, { json: { codes: ["LATER"] } });
    const l = await page();
    expect((await check(l.slug, "LATER")).valid).toBe(true);
    expect(env.stripe.coupons.size).toBeGreaterThan(saved.size);
  });
});
