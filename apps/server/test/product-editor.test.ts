// The product editor (prd/catalog/PRD.md "Product editor"): CSV export, every validation error, the review diff, and
// commits against stateful fakes of App Store Connect and Google Play (price points, price schedules, base plans, new
// products, partial failures, retry, outages, refused keys, the time budget and the commit lock), the audit log and roles.
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { csvRows, storeCatalogServer } from "./store-catalog-helpers.js";
import { buildCsv, commitEdit, microsText, parsePrice, readCsv, validateFile } from "../src/services/product-editor.js";
import type { PricedListing } from "../src/services/store-prices.js";

type Server = Awaited<ReturnType<typeof storeCatalogServer>>;
let s: Server | undefined;
afterEach(async () => { await s?.close(); s = undefined; });

const HEADER = "store_identifier,display_name,type,duration,group,territory,currency,price,action";
async function download(srv: Server, app: string, query: string, cookie = srv.admin.browser.cookie!) {
  const res = await srv.app.fetch(new Request(`http://localhost${srv.P}/apps/${app}/store_products/export.csv?${query}`, { headers: { cookie } }));
  return { status: res.status, type: res.headers.get("content-type"), disposition: res.headers.get("content-disposition"), text: await res.text() };
}
const upload = (srv: Server, app: string, csv: string, extra: Record<string, unknown> = {}, browser = srv.admin.browser) =>
  browser.call("POST", `${srv.P}/product_edits`, { app_id: app, file_name: "prices.csv", csv, ...extra });
const commit = (srv: Server, id: string, action = "commit", browser = srv.admin.browser) => browser.call("POST", `${srv.P}/product_edits/${id}/actions/${action}`, {});
/** The downloaded CSV with prices changed: `[store_identifier, territory, price]`. */
function edit(csv: string, changes: [string, string, string][], add: string[] = []) {
  const rows = csvRows(csv);
  for (const r of rows.slice(1)) {
    const c = changes.find(([id, t]) => r[0] === id && r[5] === t);
    if (c) r[7] = c[2];
  }
  return [...rows.map((r) => r.join(",")), ...add].join("\r\n");
}

const listing = (id: string, prices: [string, string, number][], o: Partial<PricedListing> = {}): PricedListing => ({
  store_identifier: id, type: "subscription", display_name: id, duration: "P1M", store_state: "APPROVED", group: { id: "g", name: "Pro" }, price: null, importable: true, note: null,
  prices: prices.map(([territory, currency, amount_micros]) => ({ territory, currency, amount_micros })), base: null, storeRef: "1", editable: true, ...o,
});
const TERR = new Map([["USA", "USD"], ["GBR", "GBP"], ["JPN", "JPY"], ["KWT", "KWD"]]);
const LIVE = [listing("pro_monthly", [["USA", "USD", 9_990_000], ["GBR", "GBP", 8_990_000], ["JPN", "JPY", 1_500_000_000]]), listing("lifetime", [["USA", "USD", 99_990_000]], { type: "non_consumable", duration: null, group: null })];

describe("CSV and validation (pure)", () => {
  it("reads quoted cells, CRLF, a BOM and semicolon files, keeps line numbers, and refuses an unclosed quote", () => {
    expect(readCsv('﻿a,b\r\n"x, ""y""",2\n\n"multi\nline",3')).toEqual([{ line: 1, cells: ["a", "b"] }, { line: 2, cells: ['x, "y"', "2"] }, { line: 3, cells: [""] }, { line: 4, cells: ["multi\nline", "3"] }]);
    expect(readCsv("a;b\n1;2")).toEqual([{ line: 1, cells: ["a", "b"] }, { line: 2, cells: ["1", "2"] }]);
    expect(() => readCsv('a,b\n"open,1')).toThrow(/line 2 is never closed/);
    expect(microsText(9_990_000, "USD")).toBe("9.99");
    expect(microsText(1_740_000_000, "JPY")).toBe("1740");
    expect(microsText(2_990_000, "KWD")).toBe("2.990");
    expect(parsePrice("9.999", "USD")).toEqual({ error: 'USD prices have at most 2 decimals; "9.999" has 3.' });
    expect(parsePrice("1740.5", "JPY")).toEqual({ error: 'JPY prices have no decimals; "1740.5" has 1.' });
    expect(parsePrice("2.995", "KWD")).toEqual({ micros: 2_995_000 });
    expect(parsePrice("0", "USD")).toEqual({ error: "price must be above 0." });
    expect(parsePrice("-1", "USD")).toMatchObject({ error: expect.stringMatching(/not a number/) });
    expect(parsePrice("abc", "USD")).toMatchObject({ error: expect.stringMatching(/not a number/) });
    expect(parsePrice("10,99", "EUR")).toEqual({ error: 'price "10,99" is not a number such as 9.99. Use a dot for decimals and no thousands separators.' });
    expect(parsePrice("100000001", "USD")).toMatchObject({ error: expect.stringMatching(/largest price/) });
  });

  it("exports base territory first, guards formula cells, and skips products the editor cannot change", () => {
    const items = [listing("pro_monthly", [["GBR", "GBP", 8_990_000], ["USA", "USD", 9_990_000]], { base: { territory: "USA", currency: "USD", amount_micros: 9_990_000 }, display_name: "=HYPERLINK(1)" }), listing("unlock", [["US", "USD", 4_990_000]], { editable: false })];
    const out = buildCsv(items, null);
    expect(out).toMatchObject({ products: 1, rows: 2 });
    expect(out.csv).toBe(`${HEADER}\r\npro_monthly,'=HYPERLINK(1),subscription,P1M,Pro,USA,USD,9.99,\r\npro_monthly,'=HYPERLINK(1),subscription,P1M,Pro,GBR,GBP,8.99,\r\n`);
  });

  it("reports every problem with its line", () => {
    const v = validateFile("apple", [
      HEADER,
      "pro_monthly,,,,,USA,USD,10.99,",            // 2: a change
      "pro_monthly,,,,,USA,USD,11.99,",            // 3: duplicate of line 2
      "pro_monthly,,,,,GBR,EUR,8.99,",             // 4: wrong currency
      "pro_monthly,,,,,XXX,USD,1,",                // 5: unknown territory
      "pro_monthly,,,,,JPN,JPY,1500.5,",           // 6: decimals in yen
      "pro_yearly,,,,,USA,USD,59.99,",             // 7: unknown product
      "lifetime,,,,,USA,USD,abc,",                 // 8: not a number
      "lifetime,,,,,USA,USD,0,",                   // 9: the same product and territory as line 8 (whatever line 8's price)
      "new.sub,New,subscription,P1M,,USA,USD,4.99,create",   // 10: no group
      "pro_monthly,,,,,GBR,GBP,8.99,create",       // 11: create an existing product
      "x,,,,,USA,USD,1,delete",                    // 12: unknown action
      "new.iap,Coins,consumable,,,USA,USD,0.99,create",       // 13: fine
      "new.iap,Other name,,,,GBR,GBP,0.99,create",            // 14: conflicting name
      ",,,,,USA,USD,1,",                                      // 15: no identifier
      "new.weird,Odd,weird_type,,,USA,USD,1,create",          // 16: bad type
    ].join("\n"), LIVE, TERR);
    expect(v.changes).toEqual([]);
    expect(v.errors.map((e) => [e.line, e.message])).toEqual([
      [3, "pro_monthly in USA is on lines 2 and 3. Keep one of them."],
      [4, "The currency of GBR is GBP, not EUR."],
      [5, "territory XXX is not an App Store territory."],
      [6, 'JPY prices have no decimals; "1500.5" has 1.'],
      [7, "pro_yearly is not in App Store Connect for this app. Check the identifier, or set action to create to add it as a new product."],
      [8, 'price "abc" is not a number such as 9.99.'],
      [9, "lifetime in USA is on lines 8 and 9. Keep one of them."],
      [10, "New subscription new.sub needs a group: the subscription group's reference name, created when it does not exist."],
      [11, "pro_monthly already exists in App Store Connect. Leave action empty to change its prices."],
      [12, 'action "delete" is not one of: create, update, or empty.'],
      [14, 'display_name "Other name" of new.iap conflicts with "Coins" on line 13.'],
      [15, "store_identifier is empty."],
      [16, 'type "weird_type" of new product new.weird is not one of: subscription, consumable, non_consumable, non_renewing_subscription.'],
    ]);
  });

  it("builds the diff: changes, new territories, unchanged rows, new products, ignored columns and big-change warnings", () => {
    const v = validateFile("apple", [
      HEADER,
      "pro_monthly,Renamed,,,,USA,USD,19.99,",   // +100%: a warning; the new name is ignored with a warning
      "pro_monthly,,,,,GBR,GBP,8.99,",           // unchanged
      "pro_monthly,,,,,JPN,JPY,,",               // no price: nothing changes
      "pro_monthly,,,,,KWT,KWD,2.990,",          // a territory without a price yet
      "new.sub,New Sub,subscription,P1M,Pro,USA,USD,4.99,create",
    ].join("\n"), LIVE, TERR);
    expect(v.errors).toEqual([]);
    expect(v.changes.map((c) => [c.kind, c.store_identifier, c.territory, c.old_micros, c.new_micros])).toEqual([
      ["price_change", "pro_monthly", "USA", 9_990_000, 19_990_000], ["price_change", "pro_monthly", "KWT", null, 2_990_000], ["new_product", "new.sub", "USA", null, 4_990_000],
    ]);
    expect(v.summary).toEqual({ price_changes: 2, new_products: 1, new_product_prices: 1, unchanged: 1, products: 2, rows: 5 });
    expect(v.warnings.map((w) => w.message)).toEqual([
      "The product editor changes prices only: the new display_name of pro_monthly is ignored. Change it in App Store Connect.",
      "pro_monthly in JPN has no price; nothing changes for it.",
      "pro_monthly in USA changes by +100% (9.99 → 19.99). Check it is not a typo.",
      "new.sub gets a price in 1 of 4 territories; the App Store sells it only where it has one.",
    ]);
    expect(validateFile("apple", `${HEADER}\npro_monthly,,,,,USA,USD,9.99,`, LIVE, TERR).errors).toEqual([{ line: null, message: "The file changes nothing: every price matches App Store Connect." }]);
    expect(validateFile("apple", "id,price\n1,2", LIVE, TERR).errors[0]!.message).toMatch(/store_identifier, territory, currency is missing|are missing/);
    expect(validateFile("apple", "", LIVE, TERR).errors[0]!.message).toMatch(/The file is empty/);
  });

  it("Google Play: subscription:base_plan identifiers, one-time products refused, base plan ids checked", () => {
    const live = [listing("premium:monthly", [["US", "USD", 9_990_000]]), listing("unlock", [["US", "USD", 4_990_000]], { type: "one_time", editable: false })];
    const v = validateFile("play", [
      HEADER,
      "premium,,,,,US,USD,10.99,",
      "unlock,,,,,US,USD,5.99,",
      "premium:Weekly,W,subscription,P1W,,US,USD,2.99,create",
      "gems,Gems,consumable,,,US,USD,0.99,create",
      "premium:weekly,Weekly,subscription,P5W,,US,USD,2.99,create",
      "premium:monthly,,,,,USA,USD,10.99,",
    ].join("\n"), live, new Map([["US", "USD"]]));
    expect(v.errors.map((e) => e.message)).toEqual([
      "premium is not in Google Play for this app. Google Play subscriptions are named subscription:base_plan, such as premium:monthly.",
      "unlock is a Google Play one-time product. Play Store one-time purchases aren't supported yet; change their prices in Play Console.",
      'Base plan ID "Weekly" must start with a lowercase letter or digit and use lowercase letters, digits and hyphens (63 at most).',
      "gems is a one-time product. Play Store one-time purchases aren't supported yet; create it in Play Console.",
      "New base plan premium:weekly needs a duration of P1W, P1M, P2M, P3M, P4M, P6M or P1Y, not P5W.",
      'territory "USA" is not a two-letter Google Play region code such as US.',
    ]);
  });
});

describe("App Store commits", () => {
  it("downloads, reviews and commits subscription and in-app purchase prices and a new subscription; audits every store write", async () => {
    s = await storeCatalogServer();
    s.asc.schedules.get(s.ids.lifetime)!.manual.set("JPN", s.asc.tierOf(79.99));
    const csv = await download(s, "app_ios", "store_identifiers=focus_pro_monthly,focus_lifetime");
    expect(csv.status).toBe(200);
    expect(csv.type).toBe("text/csv; charset=utf-8");
    expect(csv.disposition).toMatch(/attachment; filename="focus-ios-app-store-products-2026-09-30\.csv"/);
    const rows = csvRows(csv.text);
    expect(rows[0]!.join(",")).toBe(HEADER);
    expect(rows.slice(1).map((r) => `${r[0]}|${r[5]}|${r[6]}`).slice(0, 2)).toEqual(["focus_pro_monthly|USA|USD", "focus_pro_monthly|AUS|AUD"]);
    expect(rows).toHaveLength(1 + 12 + 12);
    expect((await download(s, "app_ios", "store_identifiers=nope")).status).toBe(422);
    expect((await download(s, "app_ios", "")).status).toBe(400);

    const jpManual = s.asc.currentIapPrice(s.ids.lifetime, "JPN");
    const file = edit(csv.text, [["focus_pro_monthly", "USA", "10.99"], ["focus_pro_monthly", "GBR", s.asc.customerPrice("GBR", s.asc.tierOf(10.99))], ["focus_lifetime", "USA", "119.99"]],
      ["focus_pro_weekly_v2,Focus Pro Weekly v2,subscription,P1W,Focus Pro,USA,USD,2.99,create", "focus_pro_weekly_v2,,,,,GBR,GBP,2.99,create"]);
    const up = await upload(s, "app_ios", file);
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ object: "product_edit", status: "ready", store: "app_store", errors: [], options: { preserve_current_price: true }, summary: { price_changes: 3, new_products: 1, new_product_prices: 2 } });
    expect(up.body.rows.map((r: any) => [r.kind, r.store_identifier, r.territory, r.old_amount_micros, r.new_amount_micros, r.status])).toEqual([
      ["price_change", "focus_pro_monthly", "USA", 9_990_000, 10_990_000, "pending"],
      ["price_change", "focus_pro_monthly", "GBR", Number(s.asc.customerPrice("GBR", s.asc.tierOf(9.99))) * 1e6, Number(s.asc.customerPrice("GBR", s.asc.tierOf(10.99))) * 1e6, "pending"],
      ["price_change", "focus_lifetime", "USA", 99_990_000, 119_990_000, "pending"],
      ["new_product", "focus_pro_weekly_v2", "USA", null, 2_990_000, "pending"],
      ["new_product", "focus_pro_weekly_v2", "GBR", null, 2_990_000, "pending"],
    ]);
    expect(up.body.rows[0].change_percent).toBe(10);
    expect(s.asc.calls.filter((c) => c.method !== "GET")).toEqual([]);

    // Keep existing subscribers off: Apple's preserveCurrentPrice follows the option.
    expect((await s.api("POST", `${s.P}/product_edits/${up.body.id}`, { preserve_current_price: false })).body.options).toEqual({ preserve_current_price: false });
    const done = await commit(s, up.body.id);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: "committed", results: { pending: 0, succeeded: 5, failed: 0 } });
    expect(s.asc.currentSubPrice(s.ids.proMonthly, "USA")).toBe("10.99");
    expect(s.asc.currentSubPrice(s.ids.proMonthly, "GBR")).toBe(s.asc.customerPrice("GBR", s.asc.tierOf(10.99)));
    expect(s.asc.currentSubPrice(s.ids.proMonthly, "DEU")).toBe(s.asc.customerPrice("DEU", s.asc.tierOf(9.99)));
    const posts = s.asc.calls.filter((c) => c.method === "POST");
    expect(posts.filter((c) => c.path === "/v1/subscriptionPrices").map((c) => (c.body as any).data.attributes.preserveCurrentPrice)).toEqual([false, false, false, false]);
    // The lifetime schedule kept Japan's manual price and moved the base price; other territories follow the base.
    expect(s.asc.currentIapPrice(s.ids.lifetime, "USA")).toBe("119.99");
    expect(s.asc.currentIapPrice(s.ids.lifetime, "JPN")).toBe(jpManual);
    expect(s.asc.currentIapPrice(s.ids.lifetime, "GBR")).toBe(s.asc.customerPrice("GBR", s.asc.tierOf(119.99)));
    // The new subscription exists in its group with its two prices, and in the catalog.
    const created = s.asc.subs.find((x) => x.productId === "focus_pro_weekly_v2")!;
    expect(created).toMatchObject({ subscriptionPeriod: "ONE_WEEK", name: "Focus Pro Weekly v2" });
    expect(s.asc.groups.find((g) => g.id === created.groupId)!.referenceName).toBe("Focus Pro");
    expect(s.asc.currentSubPrice(created.id, "GBR")).toBe("2.99");
    const [catalog] = await s.db.select().from(schema.products).where(and(eq(schema.products.appId, "app_ios"), eq(schema.products.storeIdentifier, "focus_pro_weekly_v2")));
    expect(catalog).toMatchObject({ type: "subscription", duration: "P1W", displayName: "Focus Pro Weekly v2" });
    // The cache shows the new prices.
    const p = await s.api("GET", `${s.P}/products/prod_ios_m?expand=indicative_price`);
    expect(p.body.indicative_price.amount_micros).toBe(10_990_000);

    const audit = await s.db.select().from(schema.auditLogs).where(eq(schema.auditLogs.projectId, s.pid));
    const types = audit.map((a) => a.actionType);
    expect(types.filter((t) => t === "store_price_changed")).toHaveLength(5);
    expect(types).toEqual(expect.arrayContaining(["product_edit_created", "product_edit_updated", "product_edit_commit", "store_product_created"]));
    const usa = audit.find((a) => a.actionType === "store_price_changed" && (a.additionalData as any).territory === "USA" && a.targetIdentifier === "focus_pro_monthly")!;
    expect(usa).toMatchObject({ actorType: "user", actorIdentifier: s.admin.userId, targetType: "product", additionalData: { app_id: "app_ios", old_amount_micros: 9_990_000, new_amount_micros: 10_990_000, result: "succeeded", edit_id: up.body.id } });

    // Committing twice is refused, and so is a retry with nothing failed.
    expect(await commit(s, up.body.id)).toMatchObject({ status: 409, body: { type: "invalid_request", message: "This edit is already committed." } });
    expect((await commit(s, up.body.id, "retry")).status).toBe(409);
    expect((await s.api("DELETE", `${s.P}/product_edits/${up.body.id}`)).status).toBe(409);
  });

  it("partial failure: a price with no App Store price point and an outage fail their rows; retry commits the rest", async () => {
    s = await storeCatalogServer();
    const csv = (await download(s, "app_ios", "store_identifiers=focus_pro_annual")).text;
    const file = edit(csv, [["focus_pro_annual", "USA", "64.50"], ["focus_pro_annual", "DEU", s.asc.customerPrice("DEU", s.asc.tierOf(69.99))], ["focus_pro_annual", "JPN", s.asc.customerPrice("JPN", s.asc.tierOf(69.99))]]);
    const up = await upload(s, "app_ios", file);
    expect(up.body.status).toBe("ready");
    s.asc.fail((m, p, b) => m === "POST" && p === "/v1/subscriptionPrices" && b?.data?.relationships?.territory?.data?.id === "JPN", 500, "An unexpected error occurred on the server side.", "", 1, "UNEXPECTED_ERROR");
    const first = await commit(s, up.body.id);
    expect(first.body).toMatchObject({ status: "partially_committed", results: { succeeded: 1, failed: 2, pending: 0 } });
    const byT = Object.fromEntries(first.body.rows.map((r: any) => [r.territory, r]));
    expect(byT.USA).toMatchObject({ status: "failed", error: "The App Store has no price of 64.50 USD in USA. The nearest App Store prices are 59.99 and 69.99." });
    expect(byT.JPN).toMatchObject({ status: "failed", error: expect.stringMatching(/App Store Connect is not responding/) });
    expect(byT.DEU).toMatchObject({ status: "succeeded", attempts: 1 });
    const failedAudit = await s.db.select().from(schema.auditLogs).where(eq(schema.auditLogs.actionType, "store_price_changed"));
    expect(failedAudit.filter((a) => (a.additionalData as any).result === "failed")).toHaveLength(2);

    const again = await commit(s, up.body.id, "retry");
    expect(again.body).toMatchObject({ status: "partially_committed", results: { succeeded: 2, failed: 1 } });
    expect(again.body.rows.find((r: any) => r.territory === "JPN")).toMatchObject({ status: "succeeded", attempts: 2 });
    expect(again.body.rows.find((r: any) => r.territory === "DEU")).toMatchObject({ status: "succeeded", attempts: 1 });
    expect(s.asc.currentSubPrice(s.ids.proAnnual, "JPN")).toBe(s.asc.customerPrice("JPN", s.asc.tierOf(69.99)));
    expect(s.asc.currentSubPrice(s.ids.proAnnual, "USA")).toBe("59.99");
    // The file lists in the Files tab with its results.
    const files = await s.api("GET", `${s.P}/product_edits?app_id=app_ios`);
    expect(files.body.items[0]).toMatchObject({ id: up.body.id, status: "partially_committed", results: { succeeded: 2, failed: 1, pending: 0 }, created_by_email: "kai@example.com", file_name: "prices.csv" });
    expect(files.body.items[0]).not.toHaveProperty("rows");
  });

  it("a refused key stops the commit and fails every row; the In-App Purchase key cannot upload", async () => {
    s = await storeCatalogServer();
    const csv = (await download(s, "app_ios", "store_identifiers=focus_pro_monthly,focus_coins_100")).text;
    const up = await upload(s, "app_ios", edit(csv, [["focus_pro_monthly", "USA", "10.99"], ["focus_coins_100", "USA", "1.99"]]));
    s.asc.keyIds.clear();
    const r = await commit(s, up.body.id);
    expect(r.body).toMatchObject({ status: "failed", results: { failed: 2 } });
    expect(r.body.rows.every((x: any) => /refused the API key \(401\).*App Manager role/.test(x.error))).toBe(true);
    const iap = await upload(s, "app_iap_only", `${HEADER}\nx,,,,,USA,USD,1,`);
    expect(iap).toMatchObject({ status: 422, body: { type: "unprocessable_entity_error" } });
    expect(iap.body.message).toMatch(/In-App Purchase key cannot list or change prices/);
  });
});

describe("Google Play commits", () => {
  it("changes base plan prices in one patch per subscription, adds a base plan and a new subscription, and activates them", async () => {
    s = await storeCatalogServer();
    const csv = (await download(s, "app_play", "all=true")).text;
    expect(csvRows(csv).some((r) => r[0] === "focus_unlock")).toBe(false);
    const file = edit(csv, [["premium:monthly", "US", "10.99"], ["premium:monthly", "GB", "8.49"], ["premium:annual", "US", "64.99"]], [
      "premium:weekly,Focus Premium,subscription,P1W,,US,USD,2.99,create",
      "focus.plus:monthly,Focus Plus,subscription,P1M,,US,USD,4.99,create",
      "focus.plus:monthly,,,,,DE,EUR,4.99,create",
    ]);
    const deBefore = s.play.price("premium", "monthly", "DE");
    const up = await upload(s, "app_play", file);
    expect(up.body).toMatchObject({ status: "ready", options: {}, summary: { price_changes: 3, new_products: 2 } });
    const done = await commit(s, up.body.id);
    expect(done.body).toMatchObject({ status: "committed", results: { succeeded: 6, failed: 0 } });
    expect(s.play.price("premium", "monthly", "US")).toBe(10_990_000);
    expect(s.play.price("premium", "monthly", "GB")).toBe(8_490_000);
    expect(s.play.price("premium", "monthly", "DE")).toBe(deBefore);
    expect(s.play.price("premium", "annual", "US")).toBe(64_990_000);
    const patches = s.play.calls.filter((c) => c.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0]!.path).toBe("/subscriptions/premium?updateMask=basePlans&regionsVersion.version=2022%2F02");
    // The whole subscription went back: both existing base plans (all 12 regions each) and the new weekly plan.
    expect(patches[0]!.body.basePlans.map((b: any) => [b.basePlanId, b.regionalConfigs.length])).toEqual([["monthly", 12], ["annual", 12], ["weekly", 1]]);
    expect(patches[0]!.body.listings).toEqual([{ languageCode: "en-US", title: "Focus Premium" }]);
    const premium = s.play.subscriptions.find((x) => x.productId === "premium")!;
    expect(premium.basePlans.map((b: any) => [b.basePlanId, b.state])).toEqual([["monthly", "ACTIVE"], ["annual", "ACTIVE"], ["weekly", "ACTIVE"]]);
    const plus = s.play.subscriptions.find((x) => x.productId === "focus.plus")!;
    expect(plus).toMatchObject({ listings: [{ languageCode: "en-US", title: "Focus Plus" }], basePlans: [{ basePlanId: "monthly", state: "ACTIVE", autoRenewingBasePlanType: { billingPeriodDuration: "P1M" } }] });
    expect(plus.basePlans[0].regionalConfigs).toEqual([{ regionCode: "US", newSubscriberAvailability: true, price: { currencyCode: "USD", units: "4", nanos: 990000000 } }, { regionCode: "DE", newSubscriberAvailability: true, price: { currencyCode: "EUR", units: "4", nanos: 990000000 } }]);
    expect(s.play.calls.filter((c) => c.method === "POST" && c.path.startsWith("/subscriptions?")).map((c) => c.path)).toEqual(["/subscriptions?productId=focus.plus&regionsVersion.version=2022%2F02"]);
    const catalog = await s.db.select().from(schema.products).where(eq(schema.products.appId, "app_play"));
    expect(catalog.map((x) => x.storeIdentifier).sort()).toEqual(["focus.plus:monthly", "premium:monthly", "premium:weekly"]);
    const created = await s.db.select().from(schema.auditLogs).where(eq(schema.auditLogs.actionType, "store_product_created"));
    expect(created.map((a) => a.targetIdentifier).sort()).toEqual(["focus.plus:monthly", "premium:weekly"]);
  });

  it("Play's refusal fails the rows that shared the call; retry after the fix; a commit already running is locked; the time budget leaves rows pending", async () => {
    s = await storeCatalogServer();
    const csv = (await download(s, "app_play", "store_identifiers=premium:monthly,family:yearly")).text;
    // 0.10 USD is below Play's range: the premium patch fails; family's succeeds.
    const up = await upload(s, "app_play", edit(csv, [["premium:monthly", "US", "0.10"], ["premium:monthly", "GB", "8.49"], ["family:yearly", "US", "84.99"]]));
    const r = await commit(s, up.body.id);
    expect(r.body.status).toBe("partially_committed");
    const premiumRows = r.body.rows.filter((x: any) => x.store_identifier === "premium:monthly");
    expect(premiumRows.map((x: any) => x.status)).toEqual(["failed", "failed"]);
    expect(premiumRows[0].error).toBe("Google Play: Price for region US is out of the allowed range (0.49 to 999.99 USD).");
    expect(s.play.price("family", "yearly", "US")).toBe(84_990_000);
    expect(s.play.price("premium", "monthly", "GB")).not.toBe(8_490_000);
    // The store went down for a moment; the retry fails, then works.
    await s.db.update(schema.productEditRows).set({ newMicros: 11_990_000 }).where(and(eq(schema.productEditRows.editId, up.body.id), eq(schema.productEditRows.territory, "US"), eq(schema.productEditRows.storeIdentifier, "premium:monthly")));
    s.play.fail((m) => m === "PATCH", 503, "The service is currently unavailable.", 1);
    const down = await commit(s, up.body.id, "retry");
    expect(down.body.rows.find((x: any) => x.territory === "GB" && x.store_identifier === "premium:monthly").error).toMatch(/could not be reached.*Retry later/);
    const ok = await commit(s, up.body.id, "retry");
    expect(ok.body).toMatchObject({ status: "committed", results: { succeeded: 3, failed: 0 } });
    expect(s.play.price("premium", "monthly", "US")).toBe(11_990_000);

    // A second commit while one runs is refused; the time budget leaves rows for the next call.
    const csv2 = (await download(s, "app_play", "store_identifiers=premium:annual")).text;
    const up2 = await upload(s, "app_play", edit(csv2, [["premium:annual", "US", "69.99"]]));
    await s.db.update(schema.productEdits).set({ lockedUntil: new Date(s.now().getTime() + 60_000) }).where(eq(schema.productEdits.id, up2.body.id));
    expect(await commit(s, up2.body.id)).toMatchObject({ status: 409, body: { type: "resource_locked_error" } });
    await s.db.update(schema.productEdits).set({ lockedUntil: null }).where(eq(schema.productEdits.id, up2.body.id));
    const [e2] = await s.db.select().from(schema.productEdits).where(eq(schema.productEdits.id, up2.body.id));
    const partial = await commitEdit(s.deps, e2!, { actorType: "user", actorIdentifier: s.admin.userId, data: {} }, { budgetMs: -1 });
    expect(partial.status).toBe("committing");
    expect(s.play.price("premium", "annual", "US")).toBe(59_990_000);
    expect((await commit(s, up2.body.id)).body).toMatchObject({ status: "committed" });
    expect(s.play.price("premium", "annual", "US")).toBe(69_990_000);
  });
});

describe("files, roles and errors", () => {
  it("an invalid file is kept with its errors and cannot be committed; viewers read and download but cannot upload; developers can", async () => {
    s = await storeCatalogServer();
    const bad = await upload(s, "app_play", `${HEADER}\npremium:monthly,,,,,US,USD,abc,\npremium:monthly,,,,,US,USD,9.49,`);
    expect(bad.status).toBe(201);
    expect(bad.body).toMatchObject({ status: "invalid", rows: [], errors: [{ line: 2, message: 'price "abc" is not a number such as 9.99.' }, { line: 3, message: "premium:monthly in US is on lines 2 and 3. Keep one of them." }] });
    expect(await commit(s, bad.body.id)).toMatchObject({ status: 409, body: { message: "This file has errors. Fix them and upload it again." } });
    expect((await upload(s, "app_play", "")).status).toBe(400);
    expect((await upload(s, "app_ts", `${HEADER}\nx,,,,,US,USD,1,`)).status).toBe(422);
    expect((await upload(s, "app_nope", `${HEADER}\nx,,,,,US,USD,1,`)).body).toMatchObject({ param: "app_id" });

    const viewer = await s.member("vic@example.com", "viewer");
    expect((await viewer.browser.call("GET", `${s.P}/product_edits`)).body.items).toHaveLength(1);
    expect((await viewer.browser.call("GET", `${s.P}/product_edits/${bad.body.id}`)).body.errors).toHaveLength(2);
    expect((await download(s, "app_play", "all=true", viewer.browser.cookie!)).status).toBe(200);
    expect((await upload(s, "app_play", `${HEADER}\npremium:monthly,,,,,US,USD,10.99,`, {}, viewer.browser)).status).toBe(403);
    expect((await viewer.browser.call("DELETE", `${s.P}/product_edits/${bad.body.id}`)).status).toBe(403);
    const dev = await s.member("dev@example.com", "developer");
    const mine = await upload(s, "app_play", `${HEADER}\npremium:monthly,,,,,US,USD,10.99,`, {}, dev.browser);
    expect(mine.body.status).toBe("ready");
    expect((await commit(s, mine.body.id, "commit", viewer.browser)).status).toBe(403);
    expect((await commit(s, mine.body.id, "commit", dev.browser)).body.status).toBe("committed");
    // A discarded file is gone; another project's edit is not found.
    expect((await s.api("DELETE", `${s.P}/product_edits/${bad.body.id}`)).status).toBe(200);
    expect((await s.api("GET", `${s.P}/product_edits/${bad.body.id}`)).status).toBe(404);
    const other = await s.signup("eve@example.com");
    expect((await other.browser.call("GET", `/v2/projects/${other.projectId}/product_edits/${mine.body.id}`)).status).toBe(404);
  });
});

describe("review fixes: no lost store prices, one commit per app", () => {
  it("an in-app purchase with a price scheduled for later is left alone; price points come in one call for many territories", async () => {
    s = await storeCatalogServer();
    s.asc.schedules.get(s.ids.lifetime)!.future = [{ territory: "USA", tier: s.asc.tierOf(149.99), startDate: "2026-12-01" }];
    const csv = (await download(s, "app_ios", "store_identifiers=focus_lifetime,focus_pro_monthly")).text;
    const up = await upload(s, "app_ios", edit(csv, [["focus_lifetime", "GBR", s.asc.customerPrice("GBR", s.asc.tierOf(89.99))], ["focus_pro_monthly", "USA", "10.99"], ["focus_pro_monthly", "GBR", s.asc.customerPrice("GBR", s.asc.tierOf(10.99))], ["focus_pro_monthly", "DEU", s.asc.customerPrice("DEU", s.asc.tierOf(10.99))]]));
    expect(up.body.status).toBe("ready");
    const r = await commit(s, up.body.id);
    const life = r.body.rows.find((x: any) => x.store_identifier === "focus_lifetime");
    expect(life).toMatchObject({ status: "failed", error: expect.stringMatching(/has a price change scheduled in App Store Connect \(USA\)/) });
    // The schedule was not written, so the scheduled price is still there.
    expect(s.asc.calls.filter((c) => c.method === "POST" && c.path === "/v1/inAppPurchasePriceSchedules")).toHaveLength(0);
    expect(s.asc.schedules.get(s.ids.lifetime)!.future).toHaveLength(1);
    // The subscription's three territories: one price point call, three price writes.
    const pointCalls = s.asc.calls.filter((c) => c.path.startsWith(`/v1/subscriptions/${s!.ids.proMonthly}/pricePoints`));
    expect(pointCalls).toHaveLength(1);
    expect(new URL(`https://x${pointCalls[0]!.path}`).searchParams.get("filter[territory]")!.split(",").sort()).toEqual(["DEU", "GBR", "USA"]);
    expect(r.body.rows.filter((x: any) => x.store_identifier === "focus_pro_monthly").every((x: any) => x.status === "succeeded")).toBe(true);
  });

  it("a second file of the same app waits for the first; a file being committed cannot be discarded", async () => {
    s = await storeCatalogServer();
    const csv = (await download(s, "app_play", "store_identifiers=premium:monthly,premium:annual")).text;
    const a = await upload(s, "app_play", edit(csv, [["premium:monthly", "US", "10.99"]]));
    const b = await upload(s, "app_play", edit(csv, [["premium:annual", "US", "64.99"]]));
    await s.db.update(schema.productEdits).set({ lockedUntil: new Date(s.now().getTime() + 60_000), status: "committing" }).where(eq(schema.productEdits.id, a.body.id));
    expect(await commit(s, b.body.id)).toMatchObject({ status: 409, body: { type: "resource_locked_error", message: "Another product file of this app is being committed right now. Wait for it to finish." } });
    expect((await s.api("DELETE", `${s.P}/product_edits/${a.body.id}`)).status).toBe(409);
    await s.db.update(schema.productEdits).set({ lockedUntil: null }).where(eq(schema.productEdits.id, a.body.id));
    expect((await commit(s, a.body.id)).body.status).toBe("committed");
    expect((await commit(s, b.body.id)).body.status).toBe("committed");
    expect([s.play.price("premium", "monthly", "US"), s.play.price("premium", "annual", "US")]).toEqual([10_990_000, 64_990_000]);
  });

  it("Play: a row already at its price keeps its success when the patch fails; a base plan Play does not activate fails its rows", async () => {
    s = await storeCatalogServer();
    const csv = (await download(s, "app_play", "store_identifiers=premium:monthly")).text;
    const up = await upload(s, "app_play", edit(csv, [["premium:monthly", "US", "10.99"], ["premium:monthly", "GB", "8.49"]]));
    // Someone set the US price in Play Console meanwhile; then Play refuses the patch once.
    const us = s.play.subscriptions[0]!.basePlans[0].regionalConfigs.find((r: any) => r.regionCode === "US");
    us.price = { currencyCode: "USD", units: "10", nanos: 990000000 };
    s.play.fail((m) => m === "PATCH", 400, "Request contains an invalid argument.", 1);
    const r = await commit(s, up.body.id);
    expect(r.body.rows.map((x: any) => [x.territory, x.status, x.error])).toEqual([
      ["US", "succeeded", "Already at this price."], ["GB", "failed", "Google Play: Request contains an invalid argument."],
    ]);
    const plan = await upload(s, "app_play", `${HEADER}\npremium:biweekly,Focus Premium,subscription,P1W,,US,USD,4.99,create`);
    s.play.fail((m, p) => m === "POST" && p.includes(":activate"), 500, "Backend Error", 1);
    const made = await commit(s, plan.body.id);
    expect(made.body.rows[0]).toMatchObject({ status: "failed", error: expect.stringMatching(/^The base plan was created but not activated: Google Play could not be reached/) });
    expect(s.play.subscriptions[0]!.basePlans.find((b: any) => b.basePlanId === "biweekly").state).toBe("DRAFT");
    // Retry: Play activates it now.
    expect((await commit(s, plan.body.id, "retry")).body.status).toBe("committed");
    expect(s.play.subscriptions[0]!.basePlans.find((b: any) => b.basePlanId === "biweekly").state).toBe("ACTIVE");
  });
});
