/**
 * `{{ product.* }}` values for the paywall preview (editor and template gallery). Each package uses its real product
 * when one is known: the Test Store price and currency, the store duration, the product's name and its trial length.
 * Packages with no known price fall back to sample prices by package identifier ($6.99 a month, $39.99 a year …), as
 * devices show the store's local price anyway. Pure, so it is unit-tested (apps/dashboard/test/preview-values.test.ts).
 */

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

const SHORT: Record<Unit, string> = { day: "day", week: "wk", month: "mo", year: "yr" };
const PERIODLY: Record<Unit, string> = { day: "daily", week: "weekly", month: "monthly", year: "yearly" };

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

function formatter(currency: string) {
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency }); } catch { return null; }
}
export function moneyIn(amount: number, currency: string): string {
  const f = formatter(currency);
  return f ? f.format(amount) : `${currency} ${amount.toFixed(2)}`;
}
function symbolOf(currency: string): string {
  return formatter(currency)?.formatToParts(0).find((p) => p.type === "currency")?.value ?? currency;
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

const perMonth = (r: ReturnType<typeof resolveProduct>) => (r.period ? r.price / (r.period.days / 30) : null);

/** Every `product.*` variable for one package. `all` (every package of the offering) feeds `relative_discount`. */
export function productValues(id: string | null, real?: Record<string, PreviewProduct>, all?: string[]): Record<string, string> {
  const key = id ?? "";
  const r = resolveProduct(key, real?.[key]);
  const money = (v: number) => moneyIn(v, r.currency);
  const p = r.period;
  const unitWord = (x: Period) => `${x.n > 1 ? `${x.n} ` : ""}${x.unit}${x.n > 1 ? "s" : ""}`;
  const per = (d: number) => (p ? money((r.price / p.days) * d) : money(r.price));
  // RevenueCat's relative discount: against the package with the highest monthly price in the same currency.
  let discount = "";
  const mine = perMonth(r);
  if (mine !== null && all?.length) {
    const top = Math.max(...all.map((k) => resolveProduct(k, real?.[k])).filter((x) => x.currency === r.currency).map(perMonth).filter((x): x is number => x !== null));
    if (Number.isFinite(top) && top > 0 && mine < top) {
      const pct = Math.round((1 - mine / top) * 100);
      if (pct > 0) discount = `${pct}%`;
    }
  }
  const t = r.trial ?? { n: 1, unit: "week" as Unit, days: 7 };
  const zero = money(0);
  return {
    "product.price": money(r.price),
    "product.price_per_period": p ? `${money(r.price)}/${unitWord(p)}` : money(r.price),
    "product.price_per_period_abbreviated": p ? `${money(r.price)}/${p.n > 1 ? p.n : ""}${SHORT[p.unit]}` : money(r.price),
    "product.price_per_day": per(1), "product.price_per_week": per(7), "product.price_per_month": per(30), "product.price_per_year": per(365),
    "product.period": p ? p.unit : "lifetime", "product.period_abbreviated": p ? SHORT[p.unit] : "",
    "product.periodly": p ? (p.n > 1 ? `every ${p.n} ${p.unit}s` : PERIODLY[p.unit]) : "lifetime",
    "product.period_with_unit": p ? `${p.n} ${p.unit}${p.n > 1 ? "s" : ""}` : "lifetime",
    "product.period_in_days": String(p ? p.days : 0), "product.period_in_weeks": String(p ? Math.round(p.days / 7) : 0),
    "product.period_in_months": String(p ? Math.round(p.days / 30) : 0), "product.period_in_years": String(p ? Math.round(p.days / 365) : 0),
    // The intro offer: a free trial of the product's trial length, or a sample one-week trial.
    "product.offer_price": "free", "product.offer_price_per_day": "free", "product.offer_price_per_week": "free", "product.offer_price_per_month": "free", "product.offer_price_per_year": "free",
    "product.offer_price_with_zero": zero, "product.offer_period": t.unit, "product.offer_period_abbreviated": SHORT[t.unit],
    "product.offer_period_with_unit": `${t.n} ${t.unit}${t.n > 1 ? "s" : ""}`, "product.offer_period_in_days": String(t.days),
    "product.offer_period_in_weeks": String(Math.floor(t.days / 7)), "product.offer_period_in_months": String(Math.floor(t.days / 30)), "product.offer_period_in_years": String(Math.floor(t.days / 365)),
    "product.offer_end_date": `in ${t.days} day${t.days === 1 ? "" : "s"}`,
    "product.relative_discount": discount, "product.store_product_name": r.name,
    "product.currency_code": r.currency, "product.currency_symbol": symbolOf(r.currency),
    "product.secondary_offer_price": "", "product.secondary_offer_period": "", "product.secondary_offer_period_abbreviated": "",
  };
}

/** Catalog shapes the preview reads (RevenueCat API v2 offering → packages → products, products with indicative_price). */
interface CatalogProduct { id: string; type: string; display_name: string | null; subscription?: { duration: string | null; trial_duration?: string | null }; indicative_price?: { amount_micros: number; currency: string } | null }
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
    out[pkg.lookup_key] = {
      price: p.indicative_price ? { amount: p.indicative_price.amount_micros / 1_000_000, currency: p.indicative_price.currency } : null,
      // A subscription without a stored duration keeps the identifier's guess; one-time products are lifetime.
      duration: sub ? p.subscription?.duration ?? undefined : p.type === "consumable" ? undefined : null,
      name: p.display_name, trial: sub ? p.subscription?.trial_duration ?? null : null,
    };
  }
  return out;
}
