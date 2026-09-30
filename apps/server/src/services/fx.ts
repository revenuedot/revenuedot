import { desc, lte, sql } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";

/**
 * USD values of store prices, converted at the exchange rate of the purchase date like RevenueCat
 * (company research semantics.md, "Currency conversion"). The source is the ECB's daily reference rates:
 * free, keyless and published every TARGET business day around 16:00 CET. Rates are cached in `fx_rates`; a date
 * with no published rate (weekend, holiday, today before publication) uses the last business day before it.
 * Without network access the bundled rates below are used. Currencies the ECB does not publish (about 30 are covered)
 * have no USD value (null), as RevenueCat's REST API reports "null when no exchange rate exists".
 * Works on Workers: one `fetch` of a small CSV, no Node APIs.
 */

const ECB = "https://data-api.ecb.europa.eu/service/data/EXR/D..EUR.SP00.A";
/** The ECB skips weekends and TARGET holidays; the longest gap (Easter) is 4 days. */
const MAX_GAP_DAYS = 4;
/** Days of rates fetched before the date asked for, so one call also fills nearby purchases. */
const WINDOW_DAYS = 14;
/** A failed or empty fetch for a window is not retried sooner than this. */
const RETRY_MS = 10 * 60 * 1000;
const DAY = 86_400_000;

/** ECB reference rates of 2026-09-30 (units per EUR), used when the cache has nothing close and the ECB is unreachable. */
export const BUNDLED_RATES = {
  date: "2026-09-30",
  rates: {
    EUR: 1, USD: 1.1355, JPY: 178.27, CZK: 24.44, DKK: 7.4755, GBP: 0.85463, HUF: 366.2, PLN: 4.369, RON: 5.2788, SEK: 11.331,
    CHF: 0.9478, ISK: 137, NOK: 10.9015, TRY: 55.6596, AUD: 1.6297, BRL: 5.9077, CAD: 1.6105, CNY: 7.613, HKD: 8.9095,
    IDR: 20315.34, ILS: 3.4901, INR: 108.8205, KRW: 1539.06, MXN: 20.5816, MYR: 4.6306, NZD: 2.0115, PHP: 71.204,
    SGD: 1.4503, THB: 38.113, ZAR: 18.6123,
  } as Record<string, number>,
};

export type FxFetch = (url: string, init?: RequestInit) => Promise<Response>;
type Rates = { date: string; rates: Record<string, number> };

const day = (d: Date) => d.toISOString().slice(0, 10);
const gapDays = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / DAY);
/** Per isolate and HTTP client: windows whose fetch failed recently, so a down ECB does not slow every purchase. */
const failures = new WeakMap<FxFetch, Map<string, number>>();
const globalFetch: FxFetch = (u, i) => globalThis.fetch(u, i);

/** Parses the ECB data API's `csvdata` (detail=dataonly) into rates per day. */
export function parseEcbCsv(csv: string): Rates[] {
  const lines = csv.trim().split(/\r?\n/);
  const head = (lines.shift() ?? "").split(",");
  const [ci, ti, vi] = ["CURRENCY", "TIME_PERIOD", "OBS_VALUE"].map((k) => head.indexOf(k));
  if (ci! < 0 || ti! < 0 || vi! < 0) return [];
  const byDay = new Map<string, Record<string, number>>();
  for (const line of lines) {
    const f = line.split(",");
    const cur = f[ci!], date = f[ti!], v = Number(f[vi!]);
    if (!cur || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !(v > 0)) continue;
    const r = byDay.get(date) ?? { EUR: 1 };
    r[cur] = v;
    byDay.set(date, r);
  }
  return [...byDay].map(([date, rates]) => ({ date, rates })).filter((x) => x.rates.USD);
}

async function cached(db: DB, date: string): Promise<Rates | null> {
  const [row] = await db.select({ date: schema.fxRates.date, rates: schema.fxRates.rates }).from(schema.fxRates)
    .where(lte(schema.fxRates.date, date)).orderBy(desc(schema.fxRates.date)).limit(1);
  return row ?? null;
}

/** Fetches the ECB window ending at `date` into the cache. Never throws. */
async function refresh(db: DB, date: string, fetchFn: FxFetch): Promise<void> {
  let failedAt = failures.get(fetchFn);
  if (!failedAt) failures.set(fetchFn, (failedAt = new Map()));
  const last = failedAt.get(date);
  if (last !== undefined && Date.now() - last < RETRY_MS) return;
  const start = day(new Date(Date.parse(date) - WINDOW_DAYS * DAY));
  try {
    const res = await fetchFn(`${ECB}?startPeriod=${start}&endPeriod=${date}&format=csvdata&detail=dataonly`, {
      headers: { accept: "text/csv" }, signal: AbortSignal.timeout(5000),
    });
    const days = res.ok ? parseEcbCsv(await res.text()) : [];
    if (!days.length) { failedAt.set(date, Date.now()); return; }
    await db.insert(schema.fxRates).values(days.map((d) => ({ date: d.date, rates: d.rates })))
      .onConflictDoUpdate({ target: schema.fxRates.date, set: { rates: sql`excluded.rates`, fetchedAt: sql`now()` } });
    failedAt.delete(date);
  } catch {
    failedAt.set(date, Date.now());
  }
}

/** Rates for a date: the cache, the ECB, or the closest of what is left (a stale cached day or the bundled rates). */
export async function ratesOn(db: DB, at: Date, fetchFn: FxFetch | null): Promise<Rates> {
  // A future date (a clock ahead of the ECB) asks for today.
  const date = day(at.getTime() > Date.now() ? new Date() : at);
  let hit = await cached(db, date);
  if (hit && gapDays(hit.date, date) <= MAX_GAP_DAYS) return hit;
  if (fetchFn) {
    await refresh(db, date, fetchFn);
    hit = await cached(db, date);
    if (hit && gapDays(hit.date, date) <= MAX_GAP_DAYS) return hit;
  }
  if (hit && Math.abs(gapDays(hit.date, date)) < Math.abs(gapDays(BUNDLED_RATES.date, date))) return hit;
  return BUNDLED_RATES;
}

/**
 * USD value of a price at `at` (the purchase date), rounded to 4 decimals. USD passes through; a currency
 * without an ECB rate returns null. `fetchFn` null uses the cache and the bundled rates only; undefined uses the global fetch.
 */
export async function usdValue(db: DB, price: { amount: number; currency: string } | null | undefined, at: Date, fetchFn?: FxFetch | null): Promise<number | null> {
  if (!price) return null;
  const cur = price.currency.toUpperCase();
  if (cur === "USD") return price.amount;
  if (price.amount === 0) return 0;
  const { rates } = await ratesOn(db, at, fetchFn === undefined ? globalFetch : fetchFn);
  const perEur = rates[cur];
  if (!perEur || !rates.USD) return null;
  return Math.round((price.amount / perEur) * rates.USD * 10_000) / 10_000;
}
