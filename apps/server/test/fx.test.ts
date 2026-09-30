import { afterEach, describe, expect, it } from "vitest";
import { openDb, schema, type DB } from "@revenuedot/db";
import { createApp } from "../src/app.js";
import { defaultStores } from "../src/stores/index.js";
import { BUNDLED_ECB, BUNDLED_USD, USD_SOURCE_FIRST_DAY, parseEcbCsv, parseUsdJson, usdValue, type FxFetch } from "../src/services/fx.js";

/**
 * Non-USD prices convert to USD at the rate of the purchase date (or the last day before it with rates): ECB first, the
 * currency-api (every ISO currency) for currencies the ECB does not publish.
 */

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

/** ECB data API answer (csvdata, detail=dataonly) for the given days: currency -> units per EUR. */
const ecbCsv = (days: Record<string, Record<string, number>>) => [
  "KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE",
  ...Object.entries(days).flatMap(([date, rates]) => Object.entries(rates).map(([c, v]) => `EXR.D.${c}.EUR.SP00.A,D,${c},EUR,SP00,A,${date},${v}`)),
].join("\n");

// Friday 28 August and Monday 31 August 2026; nothing on the weekend, like the ECB.
const DAYS = { "2026-08-28": { USD: 1.1, GBP: 0.85, JPY: 160 }, "2026-08-31": { USD: 1.2, GBP: 0.8, JPY: 165 } };

// currency-api files (units per 1 USD), one per day including weekends.
const USD_DAYS: Record<string, Record<string, number>> = { "2026-08-30": { sar: 3.75, aed: 3.6725, eur: 0.9 }, "2024-03-02": { sar: 3.7502 } };

/** Answers the ECB CSV and the currency-api JSON; `jsdelivrDown` makes the first currency-api host fail. */
function mockEcb(opts: { fail?: boolean; jsdelivrDown?: boolean } = {}) {
  const calls: string[] = [];
  const fetch: FxFetch = async (url) => {
    calls.push(url);
    if (opts.fail) return new Response("unavailable", { status: 503 });
    if (url.includes("data-api.ecb.europa.eu")) return new Response(ecbCsv(DAYS), { headers: { "content-type": "text/csv" } });
    if (opts.jsdelivrDown && url.includes("cdn.jsdelivr.net")) return new Response("bad gateway", { status: 502 });
    const date = /(\d{4}-\d{2}-\d{2})/.exec(url)?.[1] ?? "";
    const usd = USD_DAYS[date];
    return usd ? Response.json({ date, usd }) : new Response("not found", { status: 404 });
  };
  return { fetch, calls };
}

async function setup(fetch: FxFetch) {
  const opened = await openDb("pglite://memory");
  close = opened.close;
  const db: DB = opened.db;
  const app = createApp({ db, now: () => new Date("2026-09-01T12:00:00Z"), stores: defaultStores(), signingKey: "", fetch: fetch as typeof globalThis.fetch });
  await db.insert(schema.projects).values({ id: "proj1", name: "Scanner" });
  await db.insert(schema.apps).values({ id: "app_test", projectId: "proj1", name: "Test Store", type: "test_store", publicKey: "test_key123" });
  await db.insert(schema.products).values([
    { id: "p1", projectId: "proj1", appId: "app_test", storeIdentifier: "pro_monthly", type: "subscription", duration: "P1M" },
    { id: "p2", projectId: "proj1", appId: "app_test", storeIdentifier: "lifetime", type: "non_consumable" },
  ]);
  const receipt = (at: string, json: Record<string, unknown>) => app.fetch(new Request("http://localhost/v1/receipts", {
    method: "POST", headers: { authorization: "Bearer test_key123", "content-type": "application/json" },
    body: JSON.stringify({ app_user_id: "buyer", fetch_token: `test_${Date.parse(at)}_${crypto.randomUUID()}`, ...json }),
  }));
  return { db, receipt };
}

describe("exchange rates", () => {
  it("parses the ECB CSV into rates per day with EUR as 1", () => {
    expect(parseEcbCsv(ecbCsv(DAYS))).toEqual([
      { date: "2026-08-28", rates: { EUR: 1, USD: 1.1, GBP: 0.85, JPY: 160 } },
      { date: "2026-08-31", rates: { EUR: 1, USD: 1.2, GBP: 0.8, JPY: 165 } },
    ]);
    expect(parseEcbCsv("<html>not csv</html>")).toEqual([]);
  });

  it("converts subscriptions, one-time purchases, revenue and webhook prices at the purchase date's rate", async () => {
    const ecb = mockEcb();
    const { db, receipt } = await setup(ecb.fetch);
    // Monday: EUR 9.99 at 1.2 USD per EUR.
    expect((await receipt("2026-08-31T10:00:00Z", { product_id: "pro_monthly", price: 9.99, currency: "EUR" })).status).toBe(200);
    // Sunday: no ECB rate, so Friday's (GBP 0.85 per EUR, USD 1.1): GBP 17 = EUR 20 = USD 22.
    expect((await receipt("2026-08-30T10:00:00Z", { product_id: "lifetime", price: 17, currency: "GBP" })).status).toBe(200);

    const [sub] = await db.select().from(schema.subscriptions);
    expect(sub!.priceUsd).toBeCloseTo(11.988, 4);
    const [one] = await db.select().from(schema.nonSubscriptions);
    expect(one!.priceUsd).toBeCloseTo(22, 4);
    const txns = await db.select().from(schema.transactions);
    expect(txns.map((t) => Math.round(t.revenueUsd * 1000) / 1000).sort()).toEqual([11.988, 22]);
    const events = (await db.select().from(schema.events)).map((e) => (e.payload as Record<string, any>).event);
    const initial = events.find((e) => e.type === "INITIAL_PURCHASE")!;
    expect(initial.price).toBeCloseTo(11.988, 4);
    expect(initial.price_in_purchased_currency).toBe(9.99);
    expect(initial.currency).toBe("EUR");
    // One ECB call filled both dates; the rates are cached in the database.
    expect(ecb.calls).toHaveLength(1);
    expect(ecb.calls[0]).toContain("data-api.ecb.europa.eu");
    expect((await db.select().from(schema.fxRates)).map((r) => r.date).sort()).toEqual(["2026-08-28", "2026-08-31"]);
  });

  it("a currency the ECB does not publish converts with the currency-api at the purchase date's rate", async () => {
    const ecb = mockEcb({ jsdelivrDown: true });
    const { db, receipt } = await setup(ecb.fetch);
    // SAR 37.50 at 3.75 per USD on Sunday 30 August (the currency-api has weekends).
    expect((await receipt("2026-08-30T10:00:00Z", { product_id: "lifetime", price: 37.5, currency: "SAR" })).status).toBe(200);
    const [one] = await db.select().from(schema.nonSubscriptions);
    expect(one!.priceUsd).toBeCloseTo(10, 4);
    expect((await db.select().from(schema.transactions))[0]!.revenueUsd).toBeCloseTo(10, 4);
    const ev = (await db.select().from(schema.events)).map((e) => (e.payload as Record<string, any>).event)[0]!;
    expect(ev.price).toBeCloseTo(10, 4);
    expect(ev.price_in_purchased_currency).toBe(37.5);
    // jsDelivr failed, so the Cloudflare Pages mirror answered; the day is cached under source "usd".
    expect(ecb.calls.some((u) => u.startsWith("https://2026-08-30.currency-api.pages.dev/"))).toBe(true);
    const cached = (await db.select().from(schema.fxRates)).filter((r) => r.source === "usd");
    expect(cached.map((r) => r.date)).toEqual(["2026-08-30"]);
    // EUR still comes from the ECB (Friday's 1.1), not from the currency-api's 0.9.
    expect(await usdValue(db, { amount: 10, currency: "EUR" }, new Date("2026-08-30T10:00:00Z"), ecb.fetch)).toBeCloseTo(11, 4);
    // AED from the cached day, no new call; a code neither source knows has no USD value.
    const n = ecb.calls.length;
    expect(await usdValue(db, { amount: 36.725, currency: "AED" }, new Date("2026-08-30T18:00:00Z"), ecb.fetch)).toBeCloseTo(10, 4);
    expect(ecb.calls.length).toBe(n);
    expect(await usdValue(db, { amount: 5, currency: "XYZ" }, new Date("2026-08-30T18:00:00Z"), null)).toBeNull();
  });

  it("purchases before the currency-api's first day use that first day", async () => {
    const ecb = mockEcb();
    const { db } = await setup(ecb.fetch);
    expect(USD_SOURCE_FIRST_DAY).toBe("2024-03-02");
    expect(await usdValue(db, { amount: 37.502, currency: "SAR" }, new Date("2023-05-01T00:00:00Z"), ecb.fetch)).toBeCloseTo(10, 4);
    expect(ecb.calls.some((u) => u.includes("@2024-03-02/"))).toBe(true);
  });

  it("parses currency-api files: ISO codes upper-cased, crypto-length keys and bad values dropped", () => {
    expect(parseUsdJson({ date: "2026-08-30", usd: { sar: 3.75, btc: 0.00001, usdt: 1, bad: -1 } })).toEqual({ date: "2026-08-30", rates: { USD: 1, SAR: 3.75, BTC: 0.00001 } });
    expect(parseUsdJson({ nope: true })).toBeNull();
  });

  it("falls back to the bundled rates when the ECB is unreachable, and does not retry at once", async () => {
    const ecb = mockEcb({ fail: true });
    const { db } = await setup(ecb.fetch);
    const at = new Date("2026-08-31T10:00:00Z");
    const expected = (10 / BUNDLED_ECB.rates.EUR!) * BUNDLED_ECB.rates.USD!;
    expect(await usdValue(db, { amount: 10, currency: "EUR" }, at, ecb.fetch)).toBeCloseTo(expected, 4);
    expect(await usdValue(db, { amount: 10, currency: "EUR" }, at, ecb.fetch)).toBeCloseTo(expected, 4);
    expect(ecb.calls).toHaveLength(1);
    // Without network access (null) only the cache and the bundled rates are used.
    expect(await usdValue(db, { amount: 1000, currency: "JPY" }, at, null)).toBeCloseTo((1000 / BUNDLED_ECB.rates.JPY!) * BUNDLED_ECB.rates.USD!, 4);
    // Every store currency is bundled: a Saudi riyal price without network uses the bundled currency-api rates.
    expect(await usdValue(db, { amount: 100, currency: "SAR" }, at, null)).toBeCloseTo(100 / BUNDLED_USD.rates.SAR!, 4);
    for (const c of ["AED", "EGP", "NGN", "PKR", "VND", "KZT", "QAR", "TWD", "SAR", "COP", "CLP", "PEN", "TZS", "UAH"]) expect(BUNDLED_USD.rates[c], c).toBeGreaterThan(0);
    expect(await usdValue(db, { amount: 4.99, currency: "USD" }, at, null)).toBe(4.99);
    expect(await usdValue(db, null, at, null)).toBeNull();
  });
});

describe("USD backfill", () => {
  it("fixes rows saved with the raw amount or no USD value, keeps imported values, dry-runs by default and is idempotent", async () => {
    const { backfillUsd } = await import("../src/services/fx-backfill.js");
    const ecb = mockEcb();
    const { db } = await setup(ecb.fetch);
    await db.insert(schema.customers).values({ id: "c1", projectId: "proj1", originalAppUserId: "u1" } as typeof schema.customers.$inferInsert);
    const base = { projectId: "proj1", customerId: "c1", appId: "app_test", store: "app_store", productIdentifier: "pro_monthly" };
    const at = new Date("2026-08-31T10:00:00Z");
    // Old behaviour: EUR 10 saved as USD 10; SAR with no USD; an imported GBP value from RevenueCat; a USD row.
    await db.insert(schema.subscriptions).values([
      { ...base, id: "s_old", storeKey: "k1", purchaseDate: at, originalPurchaseDate: at, priceAmount: 10, priceCurrency: "EUR", priceUsd: 10 },
      { ...base, id: "s_imp", storeKey: "k2", purchaseDate: at, originalPurchaseDate: at, priceAmount: 10, priceCurrency: "GBP", priceUsd: 12.34 },
      { ...base, id: "s_usd", storeKey: "k3", purchaseDate: at, originalPurchaseDate: at, priceAmount: 10, priceCurrency: "USD", priceUsd: 10 },
    ] as typeof schema.subscriptions.$inferInsert[]);
    await db.insert(schema.nonSubscriptions).values({ ...base, id: "n_sar", storeTransactionId: "t9", purchaseDate: new Date("2026-08-30T10:00:00Z"), priceAmount: 37.5, priceCurrency: "SAR", priceUsd: null } as typeof schema.nonSubscriptions.$inferInsert);
    const refundAt = new Date("2026-09-10T10:00:00Z");
    await db.insert(schema.transactions).values([
      { ...base, id: "x_buy", storeTransactionId: "t1", kind: "purchase", purchasedAt: at, revenueUsd: 10, priceAmount: 10, priceCurrency: "EUR" },
      { ...base, id: "x_ref", storeTransactionId: "t1", kind: "refund", purchasedAt: refundAt, revenueUsd: -10, priceAmount: 10, priceCurrency: "EUR" },
      { ...base, id: "x_trial", storeTransactionId: "t2", kind: "trial", purchasedAt: at, revenueUsd: 0, priceAmount: 0, priceCurrency: "EUR" },
    ]);

    const dry = await backfillUsd(db, { apply: false, fetch: ecb.fetch });
    expect(dry.map((t) => [t.table, t.changed])).toEqual([["subscriptions", 1], ["non_subscriptions", 1], ["transactions", 2]]);
    expect((await db.select().from(schema.subscriptions)).find((s) => s.id === "s_old")!.priceUsd).toBe(10);

    await backfillUsd(db, { apply: true, fetch: ecb.fetch });
    const subs = await db.select().from(schema.subscriptions);
    expect(subs.find((s) => s.id === "s_old")!.priceUsd).toBeCloseTo(12, 4); // Monday's 1.2 USD per EUR
    expect(subs.find((s) => s.id === "s_imp")!.priceUsd).toBe(12.34);
    expect(subs.find((s) => s.id === "s_usd")!.priceUsd).toBe(10);
    expect((await db.select().from(schema.nonSubscriptions))[0]!.priceUsd).toBeCloseTo(10, 4);
    const txns = await db.select().from(schema.transactions);
    expect(txns.find((x) => x.id === "x_buy")!.revenueUsd).toBeCloseTo(12, 4);
    // The refund reverses the purchase at the purchase date's rate.
    expect(txns.find((x) => x.id === "x_ref")!.revenueUsd).toBeCloseTo(-12, 4);
    expect(txns.find((x) => x.id === "x_trial")!.revenueUsd).toBe(0);

    const again = await backfillUsd(db, { apply: true, fetch: ecb.fetch });
    expect(again.every((t) => t.changed === 0 && t.candidates === 0)).toBe(true);
  });
});
