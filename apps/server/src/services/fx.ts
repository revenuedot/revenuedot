import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";
import { BUNDLED_ECB, BUNDLED_USD } from "./fx-bundled.js";

/**
 * USD values of store prices, converted at the exchange rate of the purchase date like RevenueCat
 * (company research semantics.md, "Currency conversion"). Two keyless sources, both cached in `fx_rates`:
 * - `ecb`: the ECB's daily reference rates (about 30 currencies), used whenever the ECB publishes the currency.
 * - `usd`: the fawazahmed0 currency-api (CC0-1.0, https://github.com/fawazahmed0/exchange-api), daily rates for every
 *   ISO currency, for the rest (SAR, AED, EGP, NGN, PKR, VND, KZT, QAR, TWD ...). jsDelivr first, its Cloudflare Pages
 *   mirror second. Its history starts on 2024-03-02; earlier purchases use that first day.
 * A date without rates (ECB weekends and holidays, today before publication) uses the last day before it that has them.
 * Without network access the bundled rates (fx-bundled.ts) are used. Works on Workers: `fetch` only, no Node APIs.
 */

export { BUNDLED_ECB, BUNDLED_USD };

export type FxFetch = (url: string, init?: RequestInit) => Promise<Response>;
type Rates = { date: string; rates: Record<string, number> };
type Source = "ecb" | "usd";

/** The ECB skips weekends and TARGET holidays; the longest gap (Easter) is 4 days. */
const MAX_GAP_DAYS = 4;
/** A failed or empty fetch for a date is not retried sooner than this. */
const RETRY_MS = 10 * 60 * 1000;
const DAY = 86_400_000;
const ECB = "https://data-api.ecb.europa.eu/service/data/EXR/D..EUR.SP00.A";
/** Days of ECB rates fetched before the date asked for, so one call also fills nearby purchases. */
const ECB_WINDOW_DAYS = 14;
export const USD_SOURCE_FIRST_DAY = "2024-03-02";
export const usdSourceUrls = (date: string) => [
  `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${date}/v1/currencies/usd.json`,
  `https://${date}.currency-api.pages.dev/v1/currencies/usd.json`,
];

const day = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (date: string, n: number) => day(new Date(Date.parse(date) + n * DAY));
const gapDays = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / DAY);

/** Parses the ECB data API's `csvdata` (detail=dataonly) into rates per day (units per EUR). */
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

/** Parses a currency-api `currencies/usd.json` file into ISO codes per 1 USD. */
export function parseUsdJson(body: unknown): Rates | null {
  const b = body as { date?: unknown; usd?: Record<string, unknown> } | null;
  if (!b || typeof b.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(b.date) || !b.usd || typeof b.usd !== "object") return null;
  const rates: Record<string, number> = { USD: 1 };
  for (const [k, v] of Object.entries(b.usd)) if (/^[a-z]{3}$/.test(k) && typeof v === "number" && v > 0) rates[k.toUpperCase()] = v;
  return Object.keys(rates).length > 1 ? { date: b.date, rates } : null;
}

async function cachedOnOrBefore(db: DB, source: Source, date: string): Promise<Rates | null> {
  const F = schema.fxRates;
  const [row] = await db.select({ date: F.date, rates: F.rates }).from(F).where(and(eq(F.source, source), lte(F.date, date))).orderBy(desc(F.date)).limit(1);
  return row ?? null;
}
async function cachedAfter(db: DB, source: Source, date: string): Promise<Rates | null> {
  const F = schema.fxRates;
  const [row] = await db.select({ date: F.date, rates: F.rates }).from(F).where(and(eq(F.source, source), gte(F.date, date))).orderBy(asc(F.date)).limit(1);
  return row ?? null;
}

async function save(db: DB, source: Source, days: Rates[]) {
  if (!days.length) return;
  await db.insert(schema.fxRates).values(days.map((d) => ({ source, date: d.date, rates: d.rates })))
    .onConflictDoUpdate({ target: [schema.fxRates.source, schema.fxRates.date], set: { rates: sql`excluded.rates`, fetchedAt: sql`now()` } });
}

async function get(fetchFn: FxFetch, url: string, accept: string): Promise<Response | null> {
  try { return await fetchFn(url, { headers: { accept }, signal: AbortSignal.timeout(5000) }); } catch { return null; }
}

const FETCHERS: Record<Source, (fetchFn: FxFetch, date: string) => Promise<Rates[]>> = {
  async ecb(fetchFn, date) {
    const res = await get(fetchFn, `${ECB}?startPeriod=${addDays(date, -ECB_WINDOW_DAYS)}&endPeriod=${date}&format=csvdata&detail=dataonly`, "text/csv");
    return res?.ok ? parseEcbCsv(await res.text().catch(() => "")) : [];
  },
  async usd(fetchFn, date) {
    // Today's file may not be published yet: then yesterday's.
    for (const d of date === day(new Date()) ? [date, addDays(date, -1)] : [date]) {
      for (const url of usdSourceUrls(d)) {
        const res = await get(fetchFn, url, "application/json");
        if (!res?.ok) continue;
        const parsed = parseUsdJson(await res.json().catch(() => null));
        if (parsed) return [parsed];
      }
    }
    return [];
  },
};

/** Per isolate and HTTP client: dates whose fetch failed recently, so a down source does not slow every purchase. */
const failures = new WeakMap<FxFetch, Map<string, number>>();
const globalFetch: FxFetch = (u, i) => globalThis.fetch(u, i);

async function refresh(db: DB, source: Source, date: string, fetchFn: FxFetch): Promise<void> {
  let failed = failures.get(fetchFn);
  if (!failed) failures.set(fetchFn, (failed = new Map()));
  const key = `${source}:${date}`;
  const last = failed.get(key);
  if (last !== undefined && Date.now() - last < RETRY_MS) return;
  try {
    const days = await FETCHERS[source](fetchFn, date);
    if (!days.length) { failed.set(key, Date.now()); return; }
    await save(db, source, days);
    failed.delete(key);
  } catch {
    failed.set(key, Date.now());
  }
}

const BUNDLED: Record<Source, Rates> = { ecb: BUNDLED_ECB, usd: BUNDLED_USD };

/** Rates of one source for a date: the cache, the source, or the closest of what is left (a cached day or the bundled rates). */
export async function ratesOn(db: DB, at: Date, fetchFn: FxFetch | null, source: Source = "ecb"): Promise<Rates> {
  // A future date (a clock ahead of the sources) asks for today; the usd source has no history before its first day.
  let date = day(at.getTime() > Date.now() ? new Date() : at);
  if (source === "usd" && date < USD_SOURCE_FIRST_DAY) date = USD_SOURCE_FIRST_DAY;
  let hit = await cachedOnOrBefore(db, source, date);
  if (hit && gapDays(hit.date, date) <= MAX_GAP_DAYS) return hit;
  if (fetchFn) {
    await refresh(db, source, date, fetchFn);
    hit = await cachedOnOrBefore(db, source, date);
    if (hit && gapDays(hit.date, date) <= MAX_GAP_DAYS) return hit;
  }
  const candidates = [hit, await cachedAfter(db, source, date), BUNDLED[source]].filter((x): x is Rates => !!x);
  return candidates.sort((a, b) => Math.abs(gapDays(a.date, date)) - Math.abs(gapDays(b.date, date)))[0]!;
}

/**
 * USD value of a price at `at` (the purchase date), rounded to 4 decimals. USD passes through. ECB rates first; the
 * `usd` source for currencies the ECB does not publish; null for a code neither knows. `fetchFn` null uses the cache
 * and the bundled rates only; undefined uses the global fetch.
 */
export async function usdValue(db: DB, price: { amount: number; currency: string } | null | undefined, at: Date, fetchFn?: FxFetch | null): Promise<number | null> {
  if (!price) return null;
  const cur = price.currency.toUpperCase();
  if (cur === "USD") return price.amount;
  if (price.amount === 0) return 0;
  const f = fetchFn === undefined ? globalFetch : fetchFn;
  const round = (n: number) => Math.round(n * 10_000) / 10_000;
  const ecb = await ratesOn(db, at, f, "ecb");
  if (ecb.rates[cur] && ecb.rates.USD) return round((price.amount / ecb.rates[cur]!) * ecb.rates.USD);
  const usd = await ratesOn(db, at, f, "usd");
  if (usd.rates[cur]) return round(price.amount / usd.rates[cur]!);
  return null;
}

/**
 * Makes sure the ECB rates for [from, to] are cached, with one request for the whole range when the cache has gaps
 * (charts in a display currency other than USD need a rate for every day). Failures are ignored: callers fall back to
 * the nearest cached or bundled rates.
 */
export async function ensureEcbRange(db: DB, from: Date, to: Date, fetchFn: FxFetch | null | undefined): Promise<void> {
  const f = fetchFn === undefined ? globalFetch : fetchFn;
  if (!f) return;
  const start = day(from), end = day(to.getTime() > Date.now() ? new Date() : to);
  if (start > end) return;
  const F = schema.fxRates;
  const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(F).where(and(eq(F.source, "ecb"), gte(F.date, start), lte(F.date, end)));
  // About 250 ECB publication days a year: fetch when fewer than 90% of them are cached.
  if (n >= Math.floor((gapDays(start, end) + 1) * (250 / 365) * 0.9)) return;
  const res = await get(f, `${ECB}?startPeriod=${start}&endPeriod=${end}&format=csvdata&detail=dataonly`, "text/csv");
  if (!res?.ok) return;
  try { await save(db, "ecb", parseEcbCsv(await res.text())); } catch { /* fall back to what is cached */ }
}

/**
 * Every cached rate in one lookup: `toUsd(amount, currency, at)` and `fromUsd(currency, at)` at the last day on or
 * before `at` that has rates (ECB first, the `usd` source for currencies the ECB does not publish), else the nearest
 * cached day, else the bundled rates. No network: call ensureEcbRange first when a range needs filling.
 */
export async function fxLookup(db: DB) {
  const F = schema.fxRates;
  const rows = await db.select({ source: F.source, date: F.date, rates: F.rates }).from(F).orderBy(asc(F.date));
  const bySource = (s: Source) => { const r = rows.filter((x) => x.source === s); return r.length ? r : [BUNDLED[s]]; };
  const tables = { ecb: bySource("ecb"), usd: bySource("usd") };
  const on = (s: Source, at: number): Rates => {
    const t = tables[s];
    const date = day(new Date(at));
    let lo = 0, hi = t.length - 1, best = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (t[mid]!.date <= date) { best = mid; lo = mid + 1; } else hi = mid - 1; }
    return t[best >= 0 ? best : 0]!;
  };
  /** Units of `currency` per 1 USD on a date, or null if unknown. */
  const perUsd = (currency: string, at: number): number | null => {
    const cur = currency.toUpperCase();
    if (cur === "USD") return 1;
    const e = on("ecb", at).rates;
    if (e[cur] && e.USD) return e[cur]! / e.USD;
    const u = on("usd", at).rates;
    return u[cur] ?? null;
  };
  return {
    perUsd,
    toUsd: (amount: number, currency: string, at: number) => { const r = perUsd(currency, at); return r ? amount / r : null; },
  };
}
