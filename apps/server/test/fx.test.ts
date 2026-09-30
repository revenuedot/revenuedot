import { afterEach, describe, expect, it } from "vitest";
import { openDb, schema, type DB } from "@revenuedot/db";
import { createApp } from "../src/app.js";
import { defaultStores } from "../src/stores/index.js";
import { BUNDLED_RATES, parseEcbCsv, usdValue, type FxFetch } from "../src/services/fx.js";

/** Non-USD prices convert to USD at the ECB reference rate of the purchase date (or the last business day before it). */

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

/** ECB data API answer (csvdata, detail=dataonly) for the given days: currency -> units per EUR. */
const ecbCsv = (days: Record<string, Record<string, number>>) => [
  "KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE",
  ...Object.entries(days).flatMap(([date, rates]) => Object.entries(rates).map(([c, v]) => `EXR.D.${c}.EUR.SP00.A,D,${c},EUR,SP00,A,${date},${v}`)),
].join("\n");

// Friday 28 August and Monday 31 August 2026; nothing on the weekend, like the ECB.
const DAYS = { "2026-08-28": { USD: 1.1, GBP: 0.85, JPY: 160 }, "2026-08-31": { USD: 1.2, GBP: 0.8, JPY: 165 } };

function mockEcb(opts: { fail?: boolean } = {}) {
  const calls: string[] = [];
  const fetch: FxFetch = async (url) => {
    calls.push(url);
    if (opts.fail) return new Response("unavailable", { status: 503 });
    return new Response(ecbCsv(DAYS), { headers: { "content-type": "text/csv" } });
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

  it("a currency the ECB does not publish has no USD value, and revenue counts 0 instead of the raw amount", async () => {
    const { db, receipt } = await setup(mockEcb().fetch);
    expect((await receipt("2026-08-31T10:00:00Z", { product_id: "lifetime", price: 37.99, currency: "SAR" })).status).toBe(200);
    const [one] = await db.select().from(schema.nonSubscriptions);
    expect(one!.priceUsd).toBeNull();
    expect((await db.select().from(schema.transactions))[0]!.revenueUsd).toBe(0);
    const ev = (await db.select().from(schema.events)).map((e) => (e.payload as Record<string, any>).event)[0]!;
    expect(ev.price).toBeNull();
    expect(ev.price_in_purchased_currency).toBe(37.99);
  });

  it("falls back to the bundled rates when the ECB is unreachable, and does not retry at once", async () => {
    const ecb = mockEcb({ fail: true });
    const { db } = await setup(ecb.fetch);
    const at = new Date("2026-08-31T10:00:00Z");
    const expected = (10 / BUNDLED_RATES.rates.EUR!) * BUNDLED_RATES.rates.USD!;
    expect(await usdValue(db, { amount: 10, currency: "EUR" }, at, ecb.fetch)).toBeCloseTo(expected, 4);
    expect(await usdValue(db, { amount: 10, currency: "EUR" }, at, ecb.fetch)).toBeCloseTo(expected, 4);
    expect(ecb.calls).toHaveLength(1);
    // Without network access (null) only the cache and the bundled rates are used.
    expect(await usdValue(db, { amount: 1000, currency: "JPY" }, at, null)).toBeCloseTo((1000 / BUNDLED_RATES.rates.JPY!) * BUNDLED_RATES.rates.USD!, 4);
    expect(await usdValue(db, { amount: 4.99, currency: "USD" }, at, null)).toBe(4.99);
    expect(await usdValue(db, null, at, null)).toBeNull();
  });
});
