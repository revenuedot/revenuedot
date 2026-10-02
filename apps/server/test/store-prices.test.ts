// Store prices and status (prd/catalog/PRD.md "Store prices and status"): prices per territory, periods and review
// states read from fake App Store Connect and Google Play APIs (paging, included resources, scheduled and historical
// prices, manual and automatic in-app purchase prices, base plans, one-time products), the cache, `indicative_price`
// and `store_details` on products, refresh errors, roles and the daily refresh in the tick.
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { storeCatalogServer } from "./store-catalog-helpers.js";
import { refreshDueStorePrices } from "../src/services/store-prices.js";
import { loadSpec } from "../../../packages/contract/src/openapi.js";

type Server = Awaited<ReturnType<typeof storeCatalogServer>>;
let s: Server | undefined;
afterEach(async () => { await s?.close(); s = undefined; });

const refresh = (srv: Server, app: string) => srv.api("POST", `${srv.P}/apps/${app}/store_prices/actions/refresh`, {});
const priceIn = (item: any, t: string) => item.prices.find((p: any) => p.territory === t);

describe("App Store prices", () => {
  it("reads every subscription's current price per territory over all pages, and in-app purchases' manual and automatic prices", async () => {
    s = await storeCatalogServer();
    s.asc.pageSize.prices = 5;
    s.asc.pageSize.iaps = 1;
    // Price history: an old USA price before today's, and a price scheduled for next week that is not current yet.
    s.asc.subPrices.push({ id: "old1", subscriptionId: s.ids.proMonthly, territory: "USA", tier: s.asc.tierOf(7.99), startDate: null, preserved: false });
    s.asc.subPrices.find((p) => p.subscriptionId === s!.ids.proMonthly && p.territory === "USA" && p.id !== "old1")!.startDate = "2026-09-01";
    s.asc.subPrices.push({ id: "future1", subscriptionId: s.ids.proMonthly, territory: "USA", tier: s.asc.tierOf(12.99), startDate: "2026-10-07", preserved: false });
    // The lifetime unlock has a manual price in Japan; the other territories follow the USA base price.
    s.asc.schedules.get(s.ids.lifetime)!.manual.set("JPN", s.asc.tierOf(79.99));

    const r = await refresh(s, "app_ios");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ object: "store_price_refresh", app_id: "app_ios", sync: { status: "ok", item_count: 5, can_read_prices: true } });
    const by = Object.fromEntries(r.body.items.map((i: any) => [i.store_identifier, i]));
    expect(by.focus_pro_monthly).toMatchObject({ type: "subscription", duration: "P1M", store_state: "APPROVED", status: "approved", group: { name: "Focus Pro" }, product_id: "prod_ios_m", editable: true, price: { territory: "USA", currency: "USD", amount_micros: 9_990_000 } });
    expect(by.focus_pro_monthly.prices).toHaveLength(12);
    expect(priceIn(by.focus_pro_monthly, "JPN")).toEqual({ territory: "JPN", currency: "JPY", amount_micros: Number(s.asc.customerPrice("JPN", s.asc.tierOf(9.99))) * 1_000_000 });
    expect(by.focus_pro_annual.price).toEqual({ territory: "USA", currency: "USD", amount_micros: 59_990_000 });
    expect(by.focus_pro_weekly).toMatchObject({ status: "ready_to_submit", price: null, prices: [] });
    expect(by.focus_lifetime).toMatchObject({ type: "non_consumable", price: { territory: "USA", amount_micros: 99_990_000 } });
    expect(priceIn(by.focus_lifetime, "JPN").amount_micros).toBe(Number(s.asc.customerPrice("JPN", s.asc.tierOf(79.99))) * 1_000_000);
    expect(priceIn(by.focus_lifetime, "GBR").amount_micros).toBe(Number(s.asc.customerPrice("GBR", s.asc.tierOf(99.99))) * 1_000_000);
    expect(by.focus_coins_100).toMatchObject({ status: "waiting_for_review", price: { amount_micros: 990_000 } });
    // Every page of prices was read (12 territories and 2 history rows, 5 a page), with territories and price points included.
    const priceCalls = s.asc.calls.filter((c) => c.path.startsWith(`/v1/subscriptions/${s!.ids.proMonthly}/prices`));
    expect(priceCalls).toHaveLength(3);
    expect(new URL(`https://x${priceCalls[0]!.path}`).searchParams.get("include")).toBe("territory,subscriptionPricePoint");
    expect(s.asc.calls.filter((c) => c.path.startsWith("/v1/apps/") && c.path.includes("inAppPurchasesV2"))).toHaveLength(2);
    expect(s.asc.calls.every((c) => c.method === "GET")).toBe(true);

    // The cache answers products: indicative_price (RevenueCat's field) and store_details (extension).
    const products = await s.api("GET", `${s.P}/products?expand=items.indicative_price&expand=items.store_details&limit=100`);
    const p = Object.fromEntries(products.body.items.map((x: any) => [x.id, x]));
    expect(p.prod_ios_m.indicative_price).toEqual({ object: "indicative_price", currency: "USD", country: "US", amount_micros: 9_990_000 });
    expect(p.prod_ios_m.store_details).toMatchObject({ object: "store_details", status: "approved", price: { territory: "USA", amount_micros: 9_990_000 }, territories: 12, refresh_status: "ok" });
    expect(p.prod_ts_m.indicative_price).toEqual({ object: "indicative_price", currency: "EUR", country: null, amount_micros: 4_990_000 });
    expect(p.prod_ts_m.store_details).toBeNull();
    const one = await s.api("GET", `${s.P}/products/prod_ios_life?expand=indicative_price`);
    expect(one.body.indicative_price).toMatchObject({ amount_micros: 99_990_000, currency: "USD" });
    expect(one.body).not.toHaveProperty("store_details");
    // Store prices in indicative_price still validate against RevenueCat's OpenAPI v2 product list (when the spec is present).
    const spec = loadSpec();
    if (spec) {
      const rc = await s.api("GET", `${s.P}/products?expand=items.indicative_price&limit=100`);
      expect(spec.check("GET", "/v2/projects/{project_id}/products", 200, rc.body)).toBeNull();
    }
    // Without the expand the answer is RevenueCat's shape, unchanged.
    expect((await s.api("GET", `${s.P}/products/prod_ios_m`)).body).not.toHaveProperty("indicative_price");

    // The list of cached prices, with each price-reading app's state.
    const list = await s.api("GET", `${s.P}/store_prices?app_id=app_ios`);
    expect(list.body.items).toHaveLength(5);
    expect(list.body.apps).toEqual([expect.objectContaining({ app_id: "app_ios", status: "ok", item_count: 5, can_read_prices: true })]);
  });

  it("explains the missing App Store Connect key and the In-App Purchase key, records refused keys and keeps the old prices", async () => {
    s = await storeCatalogServer();
    const all = await s.api("GET", `${s.P}/store_prices`);
    const iapOnly = all.body.apps.find((a: any) => a.app_id === "app_iap_only");
    expect(iapOnly).toMatchObject({ can_read_prices: false, status: "never" });
    expect(iapOnly.reason).toMatch(/App Store Connect API team key with the App Manager role/);
    expect(iapOnly.reason).toMatch(/In-App Purchase key only works with the App Store Server API/);
    expect(all.body.apps.find((a: any) => a.app_id === "app_ts")).toBeUndefined();
    const missing = await refresh(s, "app_iap_only");
    expect(missing).toMatchObject({ status: 422, body: { type: "unprocessable_entity_error" } });
    expect(missing.body.message).toMatch(/App Manager role/);

    expect((await refresh(s, "app_ios")).status).toBe(200);
    s.asc.keyIds.clear();
    const refused = await refresh(s, "app_ios");
    expect(refused).toMatchObject({ status: 422, body: { type: "unprocessable_entity_error" } });
    expect(refused.body.message).toMatch(/refused the API key \(401\).*App Manager role/s);
    const after = await s.api("GET", `${s.P}/store_prices?app_id=app_ios`);
    expect(after.body.apps[0]).toMatchObject({ status: "failing", error: expect.stringMatching(/401/) });
    expect(after.body.items).toHaveLength(5);

    s.asc.keyIds.add("ASCTEAM001");
    s.asc.fail((m, p) => p.includes("/prices"), 503, "Service Unavailable");
    expect(await refresh(s, "app_ios")).toMatchObject({ status: 422, body: { type: "store_error", retryable: true } });
  });
});

describe("Google Play prices", () => {
  it("reads base plans' regional prices over every page, one-time products' prices, and states", async () => {
    s = await storeCatalogServer();
    s.play.pageSize = 1;
    const r = await refresh(s, "app_play");
    expect(r.status).toBe(200);
    const by = Object.fromEntries(r.body.items.map((i: any) => [i.store_identifier, i]));
    expect(Object.keys(by).sort()).toEqual(["family:yearly", "focus_unlock", "premium:annual", "premium:monthly"]);
    expect(by["premium:monthly"]).toMatchObject({ status: "active", duration: "P1M", product_id: "prod_play_m", editable: true, price: { territory: "US", currency: "USD", amount_micros: 9_990_000 }, store_id: "premium" });
    expect(by["premium:monthly"].prices).toHaveLength(12);
    expect(priceIn(by["premium:monthly"], "JP")).toMatchObject({ currency: "JPY" });
    expect(by["family:yearly"]).toMatchObject({ status: "draft", price: { amount_micros: 79_990_000 } });
    expect(by.focus_unlock).toMatchObject({ type: "one_time", editable: false, price: { territory: "US", amount_micros: 4_990_000 } });
    expect(s.play.calls.filter((c) => c.path.startsWith("/subscriptions?")).map((c) => new URL(`https://x${c.path}`).searchParams.get("pageToken"))).toEqual([null, "page-1"]);
    const products = await s.api("GET", `${s.P}/products?expand=items.indicative_price`);
    expect(products.body.items.find((x: any) => x.id === "prod_play_m").indicative_price).toEqual({ object: "indicative_price", currency: "USD", country: "US", amount_micros: 9_990_000 });

    s.play.denied.add("editor@focus-project.iam.gserviceaccount.com");
    s.play.emails.clear();
    const denied = await refresh(s, "app_play");
    expect(denied).toMatchObject({ status: 422, body: { type: "unprocessable_entity_error" } });
    expect(denied.body.message).toMatch(/View app information and download bulk reports/);
  });

  it("a Stripe web product's price is the fallback; viewers read prices but cannot refresh", async () => {
    s = await storeCatalogServer();
    await s.db.insert(schema.apps).values({ id: "app_stripe", projectId: s.pid, name: "Web", type: "stripe", publicKey: "strp_focus" });
    await s.db.insert(schema.products).values({ id: "prod_web", projectId: s.pid, appId: "app_stripe", storeIdentifier: "price_1Web", type: "subscription", duration: "P1M" });
    await s.db.insert(schema.webProducts).values({ productId: "prod_web", projectId: s.pid, appId: "app_stripe", stripeProductId: "prod_W", stripePriceId: "price_1Web", amountMinor: 1200, currency: "jpy", interval: "month", intervalCount: 1 });
    const products = await s.api("GET", `${s.P}/products?expand=items.indicative_price`);
    expect(products.body.items.find((x: any) => x.id === "prod_web").indicative_price).toEqual({ object: "indicative_price", currency: "JPY", country: null, amount_micros: 1_200_000_000 });

    const viewer = await s.member("vic@example.com", "viewer");
    expect((await viewer.browser.call("GET", `${s.P}/store_prices`)).status).toBe(200);
    expect((await viewer.browser.call("POST", `${s.P}/apps/app_play/store_prices/actions/refresh`, {})).status).toBe(403);
    const dev = await s.member("dev@example.com", "developer");
    expect((await dev.browser.call("POST", `${s.P}/apps/app_play/store_prices/actions/refresh`, {})).status).toBe(200);
    // A refresh changes nothing in the project, so it is not in the audit log.
    expect(await s.db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.projectId, s.pid), eq(schema.auditLogs.actionType, "app_store_prices_refresh")))).toHaveLength(0);
  });
});

describe("daily refresh", () => {
  it("refreshes apps with store keys whose prices are older than a day, at most `max` a tick", async () => {
    s = await storeCatalogServer();
    const deps = s.deps;
    expect(await refreshDueStorePrices(deps, 1)).toBe(1);
    expect(await refreshDueStorePrices(deps, 5)).toBe(1);
    // Both apps are fresh now; the App Store app with only an In-App Purchase key is never picked.
    expect(await refreshDueStorePrices(deps, 5)).toBe(0);
    const syncs = await s.db.select().from(schema.storeListingSyncs);
    expect(syncs.map((x) => x.appId).sort()).toEqual(["app_ios", "app_play"]);
    s.advance(25 * 3600_000);
    expect(await refreshDueStorePrices(deps, 5)).toBe(2);
  });
});
