/**
 * `{{ product.* }}` values for the paywall preview (editor and template gallery). Each package uses its real product
 * when one is known: the Test Store price and currency, the store duration, the product's name and its trial length.
 * Packages with no known price fall back to sample prices by package identifier ($6.99 a month, $39.99 a year …), as
 * devices show the store's local price anyway. Pure, so it is unit-tested (apps/dashboard/test/preview-values.test.ts).
 * Prices, periods and discounts follow the SDKs' own rules (purchases-ios VariableHandlerV2, SubscriptionPeriod).
 */
import { variableWords } from "@revenuedot/core";

/** What the preview knows about a package's product. Any field may be missing; missing ones fall back to samples. */
export interface PreviewProduct {
  /** Price in major units (9.99) and its ISO 4217 currency, from the Test Store price. */
  price?: { amount: number; currency: string } | null;
  /** ISO 8601 period (P1M); null for a one-time (lifetime) product. Undefined when unknown. */
  duration?: string | null;
  /** The product's display name. */
  name?: string | null;
  /** Free trial length (ISO 8601) when the store reports one. */
  trial?: string | null;
}

type Unit = "day" | "week" | "month" | "year";
interface Period { n: number; unit: Unit; days: number }

/** P1W, P1M, P3M, P6M, P1Y, P3D (one unit only; a mixed period reads as days). */
export function parsePeriod(iso: string | null | undefined): Period | null {
  const m = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?$/.exec(iso ?? "");
  if (!m || !iso || iso === "P") return null;
  const [y, mo, w, d] = [m[1], m[2], m[3], m[4]].map((x) => Number(x ?? 0)) as [number, number, number, number];
  const days = y * 365 + mo * 30 + w * 7 + d;
  if (!days) return null;
  const units = [y, mo, w, d].filter(Boolean).length;
  if (units > 1) return { n: days, unit: "day", days };
  if (y) return { n: y, unit: "year", days };
  if (mo) return mo % 12 === 0 ? { n: mo / 12, unit: "year", days: (mo / 12) * 365 } : { n: mo, unit: "month", days };
  if (w) return { n: w, unit: "week", days };
  return { n: d, unit: "day", days };
}

/**
 * How many of `to` one `from` is, as the SDKs convert periods (purchases-ios SubscriptionPeriod.swift, purchases-android
 * Period.kt): 7 days a week, 30 a month, 365 a year, 12 months a year, 365 / 12 / 7 weeks a month.
 */
const IN: Record<Unit, Record<Unit, number>> = {
  day: { day: 1, week: 1 / 7, month: 1 / 30, year: 1 / 365 },
  week: { day: 7, week: 1, month: (7 * 12) / 365, year: 7 / 365 },
  month: { day: 30, week: 365 / 12 / 7, month: 1, year: 1 / 12 },
  year: { day: 365, week: 365 / 7, month: 12, year: 1 },
};
const unitsIn = (p: Period, u: Unit) => p.n * IN[p.unit][u];

/** The sample product for a package identifier (the preview's prices before any real price is known). */
function sample(id: string): { price: number; period: Period | null; name: string } {
  const annual = /annual|year/i.test(id), weekly = /week/i.test(id), life = /life/i.test(id), six = /six/i.test(id), three = /three/i.test(id), two = /two/i.test(id);
  if (life) return { price: 99.99, period: null, name: "Pro Lifetime" };
  if (annual) return { price: 39.99, period: { n: 1, unit: "year", days: 365 }, name: "Pro Yearly" };
  if (weekly) return { price: 2.99, period: { n: 1, unit: "week", days: 7 }, name: "Pro Weekly" };
  if (six) return { price: 24.99, period: { n: 6, unit: "month", days: 180 }, name: "Pro 6 Months" };
  if (three) return { price: 14.99, period: { n: 3, unit: "month", days: 90 }, name: "Pro 3 Months" };
  if (two) return { price: 11.99, period: { n: 2, unit: "month", days: 60 }, name: "Pro 2 Months" };
  return { price: 6.99, period: { n: 1, unit: "month", days: 30 }, name: "Pro Monthly" };
}

const formatters = new Map<string, Intl.NumberFormat | null>();
function formatter(currency: string): Intl.NumberFormat | null {
  if (!formatters.has(currency)) {
    let f: Intl.NumberFormat | null = null;
    try { f = new Intl.NumberFormat("en-US", { style: "currency", currency }); } catch { /* a malformed code: shown as "XX 1.50" */ }
    formatters.set(currency, f);
  }
  return formatters.get(currency)!;
}
export function moneyIn(amount: number, currency: string): string {
  const f = formatter(currency);
  return f ? f.format(amount) : `${currency} ${amount.toFixed(2)}`;
}
function symbolOf(currency: string): string {
  return formatter(currency)?.formatToParts(0).find((p) => p.type === "currency")?.value ?? currency;
}
/** Per-period prices are rounded down to the currency's decimals, as both SDKs do ($59.99 a year is $4.99 a month). */
function floorTo(v: number, currency: string): number {
  const d = formatter(currency)?.resolvedOptions().maximumFractionDigits ?? 2;
  return Math.floor(v * 10 ** d + 1e-6) / 10 ** d;
}

/** The resolved price, period and name of a package: real where known, sample otherwise. */
export function resolveProduct(id: string, real?: PreviewProduct | null): { price: number; currency: string; period: Period | null; name: string; sample: boolean; trial: Period | null } {
  const s = sample(id);
  // A known duration (or a one-time product, null) wins over the identifier's guess.
  const period = real && real.duration !== undefined ? (real.duration === null ? null : parsePeriod(real.duration) ?? s.period) : s.period;
  const has = !!real?.price && Number.isFinite(real.price.amount);
  return {
    price: has ? real!.price!.amount : s.price, currency: has ? real!.price!.currency.toUpperCase() : "USD", period,
    name: real?.name || s.name, sample: !has, trial: parsePeriod(real?.trial ?? null),
  };
}

const perMonth = (r: ReturnType<typeof resolveProduct>) => (r.period ? floorTo(r.price / unitsIn(r.period, "month"), r.currency) : null);

/**
 * Every `product.*` variable for one package, in the words the SDK uses for `locale` (`ui_config.localizations`, from
 * variableWords). `all` (every package of the paywall) feeds `relative_discount`, which, like the SDK, compares the
 * package's price per month with the highest one; real prices are only compared with real prices in the same currency,
 * samples with samples.
 */
export function productValues(id: string | null, real?: Record<string, PreviewProduct>, all?: string[], locale = "en_US"): Record<string, string> {
  const key = id ?? "";
  const r = resolveProduct(key, real?.[key]);
  const w = variableWords(locale);
  const money = (v: number) => moneyIn(v, r.currency);
  const p = r.period;
  const count = (x: Period) => (w[`num_${x.unit}_${x.n === 1 ? "one" : "other"}`] ?? `%d ${x.unit}s`).replace("%d", String(x.n));
  const word = (x: Period) => (x.n > 1 ? count(x) : w[x.unit] ?? x.unit);
  const short = (x: Period) => (x.n > 1 ? (w[`num_${x.unit}s_short`] ?? "%d").replace("%d", String(x.n)) : w[`${x.unit}_short`] ?? x.unit);
  const periodly = (x: Period) => (x.n > 1 ? count(x) : w[{ day: "daily", week: "weekly", month: "monthly", year: "yearly" }[x.unit]] ?? "");
  const per = (u: Unit) => (p ? money(floorTo(r.price / unitsIn(p, u), r.currency)) : money(r.price));
  const inUnits = (u: Unit) => (p ? String(Math.round(unitsIn(p, u))) : "");
  let discount = "";
  const mine = perMonth(r);
  if (mine !== null && all?.length) {
    const peers = all.map((k) => resolveProduct(k, real?.[k])).filter((x) => x.currency === r.currency && x.sample === r.sample);
    const top = Math.max(...peers.map(perMonth).filter((x): x is number => x !== null));
    if (Number.isFinite(top) && top > 0 && mine < top) {
      const pct = Math.round((1 - mine / top) * 100);
      if (pct > 0) discount = (w.percent ?? "%d%%").replace("%d", String(pct)).replace("%%", "%");
    }
  }
  // The intro offer: a free trial of the product's trial length, or a sample one-week trial. One-time products have none,
  // so the SDK shows their price and no offer period.
  const t = r.trial ?? { n: 1, unit: "week" as Unit, days: 7 };
  const free = w.free_price ?? "free";
  const offer = (v: string) => (p ? v : "");
  return {
    "product.price": money(r.price),
    "product.price_per_period": p ? `${money(r.price)}/${word(p)}` : money(r.price),
    "product.price_per_period_abbreviated": p ? `${money(r.price)}/${short(p)}` : money(r.price),
    "product.price_per_day": per("day"), "product.price_per_week": per("week"), "product.price_per_month": per("month"), "product.price_per_year": per("year"),
    "product.period": p ? word(p) : "", "product.period_abbreviated": p ? short(p) : "",
    "product.periodly": p ? periodly(p) : "", "product.period_with_unit": p ? count(p) : "",
    "product.period_in_days": inUnits("day"), "product.period_in_weeks": inUnits("week"), "product.period_in_months": inUnits("month"), "product.period_in_years": inUnits("year"),
    "product.offer_price": p ? free : money(r.price), "product.offer_price_per_day": p ? free : money(r.price), "product.offer_price_per_week": p ? free : money(r.price),
    "product.offer_price_per_month": p ? free : money(r.price), "product.offer_price_per_year": p ? free : money(r.price),
    "product.offer_price_with_zero": p ? money(0) : money(r.price), "product.offer_period": offer(word({ ...t, n: 1 })), "product.offer_period_abbreviated": offer(short({ ...t, n: 1 })),
    "product.offer_period_with_unit": offer(count(t)), "product.offer_period_in_days": offer(String(Math.round(unitsIn(t, "day")))),
    "product.offer_period_in_weeks": offer(String(Math.round(unitsIn(t, "week")))), "product.offer_period_in_months": offer(String(Math.round(unitsIn(t, "month")))),
    "product.offer_period_in_years": offer(String(Math.round(unitsIn(t, "year")))),
    "product.offer_end_date": offer(`in ${t.days} day${t.days === 1 ? "" : "s"}`),
    "product.relative_discount": discount, "product.store_product_name": r.name,
    "product.currency_code": r.currency, "product.currency_symbol": symbolOf(r.currency),
    "product.secondary_offer_price": "", "product.secondary_offer_period": "", "product.secondary_offer_period_abbreviated": "",
  };
}

/** Catalog shapes the preview reads (RevenueCat API v2 offering → packages → products, products with indicative_price). */
interface CatalogProduct { id: string; type: string; store_identifier: string; display_name: string | null; subscription?: { duration: string | null; trial_duration?: string | null }; indicative_price?: { amount_micros: number; currency: string } | null }
interface CatalogOffering { packages?: { items: { lookup_key: string; products?: { items: { product: { id: string } }[] } }[] } }

/**
 * The preview products of an offering's packages, by package identifier. A package's price comes from its first product
 * with a Test Store price (`priced`, looked up by id because offering expansions carry no price); its duration and name
 * from that product, or else the package's first product.
 */
export function previewProducts(offering: CatalogOffering | null | undefined, priced: CatalogProduct[] | undefined): Record<string, PreviewProduct> {
  const byId = new Map((priced ?? []).map((p) => [p.id, p]));
  const out: Record<string, PreviewProduct> = {};
  for (const pkg of offering?.packages?.items ?? []) {
    const prods = (pkg.products?.items ?? []).map((x) => byId.get(x.product.id)).filter((p): p is CatalogProduct => !!p);
    if (!prods.length) continue;
    const p = prods.find((x) => x.indicative_price) ?? prods[0]!;
    const sub = p.type === "subscription";
    // A Test Store product reaches the SDK as the server sends it (routes/sdk.ts rcbilling products): a subscription with
    // no stored duration is monthly, one-time products have no period, and a missing display name is the identifier.
    const ts = !!p.indicative_price;
    out[pkg.lookup_key] = {
      price: p.indicative_price ? { amount: p.indicative_price.amount_micros / 1_000_000, currency: p.indicative_price.currency } : null,
      duration: sub ? p.subscription?.duration ?? (ts ? "P1M" : undefined) : null,
      name: p.display_name ?? (ts ? p.store_identifier : null), trial: sub ? p.subscription?.trial_duration ?? null : null,
    };
  }
  return out;
}
