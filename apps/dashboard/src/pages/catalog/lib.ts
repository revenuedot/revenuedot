import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type List } from "../../lib/api";

/** Product catalog data: RevenueCat API v2 shapes, read through the dashboard session. */

export interface App {
  object: "app"; id: string; name: string; type: string; created_at: number; project_id: string;
  app_store?: { bundle_id: string }; mac_app_store?: { bundle_id: string }; play_store?: { package_name: string }; amazon?: { package_name: string }; galaxy?: { package_name: string };
}
/** One Test Store price (`GET …/products/{id}/prices`). */
export interface ProductPrice { id: string | null; currency: string; amount_micros: number }

export interface Product {
  object: "product"; id: string; store_identifier: string; type: string; state: "active" | "inactive"; created_at: number; app_id: string;
  display_name: string | null; subscription?: { duration: string | null }; one_time?: { is_consumable: boolean | null };
  /**
   * With expand=items.indicative_price: the Test Store price, else the store's price in the United States (or the base
   * territory) from the last price refresh, else the Stripe web product's price; null when none is known.
   */
  indicative_price?: { amount_micros: number; currency: string; country?: string | null } | null;
  /** With expand=items.store_details: the store's status and base price from the last refresh; null when not read. */
  store_details?: StoreDetails | null;
}
export interface StoreDetails {
  status: string | null; store_state: string | null; price: { amount_micros: number; currency: string; territory: string | null } | null;
  territories: number; duration: string | null; display_name: string | null; editable: boolean; refreshed_at: number; refresh_status: string | null;
}
export interface StorePrice { territory: string; currency: string; amount_micros: number }
export interface StoreListing {
  object: "store_listing"; app_id: string; store_identifier: string; product_id: string | null; type: string; display_name: string | null; duration: string | null;
  store_state: string | null; status: string | null; group: { id: string; name: string | null } | null; store_id: string | null;
  price: { amount_micros: number; currency: string; territory: string | null } | null; prices: StorePrice[]; editable: boolean; note: string | null; refreshed_at: number;
}
export interface PriceSync { app_id: string; store: string; can_read_prices: boolean; reason: string | null; status: "ok" | "failing" | "never"; error: string | null; item_count: number; refreshed_at: number | null }
export interface Entitlement { object: "entitlement"; id: string; lookup_key: string; display_name: string; created_at: number; state: "active" | "inactive"; products?: List<Product> }
export interface PackageProduct { product: Product; eligibility_criteria: "all" | "google_sdk_lt_6" | "google_sdk_ge_6" }
export interface Package { object: "package"; id: string; lookup_key: string; display_name: string; position: number; created_at: number; products?: List<PackageProduct> }
export interface Offering {
  object: "offering"; id: string; lookup_key: string; display_name: string; is_current: boolean; created_at: number; state: "active" | "inactive";
  metadata: Record<string, unknown> | null; packages?: List<Package>;
  /** The offering's paywall (API v2 `paywall_id`), when it has one. */
  paywall_id?: string | null;
}

/** Reads every page of a v2 list (100 per page). */
export async function listAll<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  let url: string | null = `${path}${path.includes("?") ? "&" : "?"}limit=100`;
  while (url) {
    const page: List<T> = await api<List<T>>(url);
    out.push(...page.items);
    url = page.next_page;
  }
  return out;
}

export const v2 = (pid: string) => `/v2/projects/${encodeURIComponent(pid)}`;
export const catalogKey = (pid: string) => ["catalog", pid] as const;

export const useApps = (pid: string) => useQuery({ queryKey: [...catalogKey(pid), "apps"], queryFn: () => listAll<App>(`${v2(pid)}/apps`), enabled: !!pid });
export const useProducts = (pid: string) => useQuery({ queryKey: [...catalogKey(pid), "products"], queryFn: () => listAll<Product>(`${v2(pid)}/products?expand=items.indicative_price&expand=items.store_details`), enabled: !!pid });
/** Cached App Store and Google Play prices of the project (every territory), and each app's last price refresh. */
export const useStorePrices = (pid: string) => useQuery({
  queryKey: [...catalogKey(pid), "store-prices"], enabled: !!pid,
  queryFn: () => api<{ items: StoreListing[]; apps: PriceSync[] }>(`${v2(pid)}/store_prices`),
});
export const useEntitlements = (pid: string) => useQuery({ queryKey: [...catalogKey(pid), "entitlements"], queryFn: () => listAll<Entitlement>(`${v2(pid)}/entitlements?expand=items.product`), enabled: !!pid });
export const useOfferings = (pid: string) => useQuery({ queryKey: [...catalogKey(pid), "offerings"], queryFn: () => listAll<Offering>(`${v2(pid)}/offerings?expand=items.package.product`), enabled: !!pid });

/**
 * Every catalog mutation refreshes the whole catalog (products, entitlements and offerings reference each other) and the
 * product lists the app and customer pages keep under ["products", pid, …], so a changed Test Store price shows there too.
 */
export function useRefreshCatalog(pid: string) {
  const qc = useQueryClient();
  return () => Promise.all([qc.invalidateQueries({ queryKey: catalogKey(pid) }), qc.invalidateQueries({ queryKey: ["products", pid] })]);
}

/** RevenueCat's reserved package identifiers, in the order its New Offering form lists them. The SDK maps each to a package type. */
export const PACKAGE_TYPES: { key: string; label: string }[] = [
  { key: "$rc_monthly", label: "Monthly" }, { key: "$rc_annual", label: "Annual" }, { key: "$rc_six_month", label: "Six Months" },
  { key: "$rc_three_month", label: "Three Months" }, { key: "$rc_two_month", label: "Two Months" }, { key: "$rc_weekly", label: "Weekly" },
  { key: "$rc_lifetime", label: "Lifetime" },
];
export const packageLabel = (key: string) => PACKAGE_TYPES.find((p) => p.key === key)?.label ?? "Custom";

/** Custom package identifiers: letters, digits, `_ - .`; the `$rc_` prefix is reserved (the SDK reads unknown `$rc_` ids as UNKNOWN). */
export function customPackageError(v: string): string | null {
  if (!v.trim()) return "Enter an identifier for the custom package.";
  if (v.startsWith("$rc_")) return "Identifiers starting with $rc_ are reserved. Pick one of the preset identifiers or drop the prefix.";
  if (!/^[A-Za-z0-9_.\-]+$/.test(v)) return "Use letters, digits, underscores, dots or dashes only.";
  if (v.length > 200) return "Use 200 characters or fewer.";
  return null;
}

/** Offering and entitlement identifiers the SDK reads by key. */
export function lookupKeyError(v: string, what: string): string | null {
  if (!v.trim()) return `Enter an identifier for the ${what}.`;
  if (/\s/.test(v)) return "Identifiers cannot contain spaces. Use underscores instead, e.g. black_friday.";
  if (v.length > 200) return "Use 200 characters or fewer.";
  return null;
}

export const DURATIONS: { iso: string; label: string }[] = [
  { iso: "P1W", label: "Weekly" }, { iso: "P1M", label: "Monthly" }, { iso: "P2M", label: "2 months" },
  { iso: "P3M", label: "3 months" }, { iso: "P6M", label: "6 months" }, { iso: "P1Y", label: "Yearly" },
];
export const ISO_PERIOD = /^P(?=\d)(?:\d+Y)?(?:\d+M)?(?:\d+W)?(?:\d+D)?$/;

/** "P1M" -> "1 month", "P2W" -> "2 weeks", "P1Y6M" -> "1 year 6 months". */
export function durationLabel(iso: string | null | undefined): string {
  if (!iso) return "—";
  const m = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?$/.exec(iso);
  if (!m) return iso;
  const parts = [["year", m[1]], ["month", m[2]], ["week", m[3]], ["day", m[4]]].filter(([, n]) => n && Number(n) > 0)
    .map(([u, n]) => `${Number(n)} ${u}${Number(n) === 1 ? "" : "s"}`);
  return parts.join(" ") || iso;
}

/** "EUR 2.99" style label for a price in micros; "—" without one. */
export function priceLabel(p: { amount_micros: number; currency: string } | null | undefined): string {
  if (!p) return "—";
  const amount = p.amount_micros / 1_000_000;
  try { return amount.toLocaleString("en-US", { style: "currency", currency: p.currency }); } catch { return `${p.currency} ${amount}`; }
}
/**
 * "2.99" -> 2990000 micros; null for an empty field, NaN for anything that is not a non-negative amount. A comma with one
 * or two digits after it ("4,99", what an iPhone's decimal keypad types in a comma-decimal region) is a decimal comma;
 * "1,000" stays ambiguous and is refused.
 */
export function parseMicros(amount: string): number | null {
  const t = amount.trim().replace(/^(\d+),(\d{1,2})$/, "$1.$2");
  if (!t) return null;
  return /^\d+(\.\d{1,6})?$/.test(t) ? Math.round(Number(t) * 1_000_000) : NaN;
}

/** Currencies offered first in the Test Store price field; any ISO 4217 code is accepted. */
export const COMMON_CURRENCIES = ["USD", "EUR", "GBP", "JPY", "CAD", "AUD", "CHF", "CNY", "INR", "BRL", "MXN", "KRW", "SEK", "NOK", "DKK", "PLN", "TRY", "SGD", "HKD", "NZD"];

/** ISO 4217 codes the browser knows (null where it cannot list them); the server has the final say. */
const KNOWN_CURRENCIES = (() => {
  try { return new Set((Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf("currency")); } catch { return null; }
})();
/** Decimals a currency uses (2 for USD, 0 for JPY, 3 for KWD). */
function minorUnits(code: string): number {
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits ?? 2; } catch { return 2; }
}

/**
 * The `test_store_price` body field from the form's amount and currency, or an error message and the input it is about.
 * A required price (new Test Store products, like RevenueCat's form) must be above zero; an optional one may be left
 * empty for no price. Amounts up to the server's limit (1,000,000,000 units, for IDR and VND prices) and with no more
 * decimals than the currency has.
 */
export function testStorePrice(amount: string, currency: string, required = false): { value: { amount_micros: number; currency: string } | null } | { error: string; field: "amount" | "currency" } {
  const micros = parseMicros(amount);
  if (micros === null) return required ? { error: "Enter the price, such as 9.99. Test purchases record it as revenue.", field: "amount" } : { value: null };
  if (Number.isNaN(micros)) return { error: /^\s*-/.test(amount) ? "A price cannot be negative." : "Enter an amount such as 9.99, with a dot for decimals.", field: "amount" };
  if (required && micros === 0) return { error: "Enter a price above 0, such as 9.99.", field: "amount" };
  if (micros > 1e15) return { error: "Enter an amount of 1,000,000,000 or less.", field: "amount" };
  const code = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) return { error: "Enter a three-letter currency code such as USD or EUR.", field: "currency" };
  if (KNOWN_CURRENCIES && !KNOWN_CURRENCIES.has(code)) return { error: `${code} is not a currency code. Use an ISO 4217 code such as USD or EUR.`, field: "currency" };
  const d = minorUnits(code);
  if (micros % 10 ** (6 - Math.min(d, 6))) return { error: d ? `Use at most ${d} decimals for ${code}.` : `${code} has no decimals. Enter a whole amount.`, field: "amount" };
  return { value: { amount_micros: micros, currency: code } };
}

export const PRODUCT_TYPES: { value: string; label: string; help: string }[] = [
  { value: "subscription", label: "Subscription", help: "Renews automatically every period." },
  { value: "consumable", label: "Consumable", help: "Bought again and again, e.g. coins." },
  { value: "non_consumable", label: "Non-consumable", help: "Bought once, owned forever, e.g. lifetime access." },
];
const TYPE_LABEL: Record<string, string> = { subscription: "Subscription", consumable: "Consumable", non_consumable: "Non-consumable", one_time: "One-time", non_renewing_subscription: "Non-renewing" };
export const typeLabel = (t: string) => TYPE_LABEL[t] ?? t;

/** Two-letter store codes for the square store mark (brand logos are not ours to use). */
export const STORE_CODE: Record<string, string> = { app_store: "AS", mac_app_store: "MA", play_store: "GP", amazon: "AZ", stripe: "ST", rc_billing: "WB", roku: "RK", paddle: "PD", test_store: "TS", galaxy: "GX" };

export const appIdentifier = (a: App) => a.app_store?.bundle_id ?? a.mac_app_store?.bundle_id ?? a.play_store?.package_name ?? a.amazon?.package_name ?? a.galaxy?.package_name ?? null;

/** Placeholder and help for the store identifier field, per store. */
export function storeIdHelp(type: string | undefined): { placeholder: string; hint: string } {
  switch (type) {
    case "app_store": case "mac_app_store": return { placeholder: "com.example.pro.monthly", hint: "The product ID from App Store Connect." };
    case "play_store": return { placeholder: "pro_monthly:monthly-base", hint: "Subscriptions: productId:basePlanId. One-time products: the SKU." };
    case "amazon": return { placeholder: "com.example.pro.monthly", hint: "The term SKU for subscriptions, the SKU for one-time products." };
    case "stripe": case "rc_billing": return { placeholder: "prod_1234", hint: "The Stripe product ID, starting with prod_." };
    case "paddle": return { placeholder: "pri_01h…", hint: "The Paddle price ID, starting with pri_. Each price is its own product." };
    case "roku": return { placeholder: "monthly_sub", hint: "The product code from the Roku developer dashboard." };
    case "galaxy": return { placeholder: "premium_monthly", hint: "The item ID from Samsung Seller Portal." };
    case "test_store": return { placeholder: "pro_monthly", hint: "Any identifier. Test Store purchases need no store setup." };
    default: return { placeholder: "pro_monthly", hint: "The product identifier in the store." };
  }
}

export const productName = (p: Product) => p.display_name || p.store_identifier;

/** "/year", "/3 months", "" for one-time products. */
export function perPeriod(iso: string | null | undefined): string {
  const m = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?$/.exec(iso ?? "");
  if (!m || !iso) return "";
  const parts = [["year", m[1]], ["month", m[2]], ["week", m[3]], ["day", m[4]]].filter(([, n]) => n && Number(n) > 0);
  if (parts.length !== 1) return `/${durationLabel(iso)}`;
  const [unit, n] = parts[0] as [string, string];
  return Number(n) === 1 ? `/${unit}` : `/${n} ${unit}s`;
}
/** RevenueCat's list label: "$89.99/year", "$3.99/week", "$99.99" for one-time products; null without a price. */
export function priceAndPeriod(p: Product): string | null {
  if (!p.indicative_price) return null;
  return `${priceLabel(p.indicative_price)}${p.type === "subscription" ? perPeriod(p.subscription?.duration ?? p.store_details?.duration) : ""}`;
}

/** The store's state in words, and the tag tone (App Store review states, Google Play base plan states). */
const STORE_STATUS: Record<string, [string, "up" | "down" | "info" | "gold" | "muted"]> = {
  approved: ["Approved", "up"], active: ["Active", "up"], ready_to_submit: ["Ready to submit", "info"], waiting_for_review: ["Waiting for review", "info"],
  in_review: ["In review", "info"], pending_binary_approval: ["Pending binary approval", "info"], missing_metadata: ["Missing metadata", "gold"],
  developer_action_needed: ["Developer action needed", "down"], rejected: ["Rejected", "down"], removed_from_sale: ["Removed from sale", "muted"],
  developer_removed_from_sale: ["Removed from sale", "muted"], draft: ["Draft", "muted"], inactive: ["Inactive", "muted"], inactive_published: ["Inactive", "muted"],
};
export function storeStatus(status: string | null | undefined): { label: string; tone: "up" | "down" | "info" | "gold" | "muted" } | null {
  if (!status) return null;
  const s = STORE_STATUS[status.toLowerCase()];
  return s ? { label: s[0], tone: s[1] } : { label: status.toLowerCase().replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()), tone: "muted" };
}

/** The stores whose prices RevenueDot reads and the product editor writes. */
export const PRICE_STORES = new Set(["app_store", "mac_app_store", "play_store"]);

/** The API's message, or a plain fallback. */
export const errMsg = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : "Something went wrong. Try again.");
export const errParam = (e: unknown) => (e instanceof ApiError && e.body && typeof e.body === "object" && "param" in e.body ? String((e.body as { param: unknown }).param) : null);
export const isConflict = (e: unknown) => e instanceof ApiError && e.status === 409;

/** A free identifier for a copy: `sale_copy`, `sale_copy_2` ... */
export function copyKey(base: string, taken: Set<string>) {
  let k = `${base}_copy`;
  for (let i = 2; taken.has(k); i++) k = `${base}_copy_${i}`;
  return k;
}

export const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
