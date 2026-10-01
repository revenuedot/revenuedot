/**
 * StoreKit configuration files (`.storekit`, the JSON Xcode writes for local StoreKit testing) read into a plain product
 * list, so RevenueDot AI can show what a file holds and import its products into the catalog (prd/ai-assistant/PRD.md §4).
 * Pure: no I/O. Handles format versions 1 to 4: `products` (consumable, non-consumable), `subscriptionGroups[].subscriptions`
 * (auto-renewing, with introductory offers) and `nonRenewingSubscriptions`.
 */

export type StoreKitProductType = "consumable" | "non_consumable" | "subscription" | "non_renewing_subscription";

export interface StoreKitIntroOffer {
  /** "free_trial", "pay_as_you_go" or "pay_up_front". */
  mode: "free_trial" | "pay_as_you_go" | "pay_up_front";
  /** ISO 8601 period of one offer period, e.g. P1W. */
  period: string | null;
  periods: number;
  price: number | null;
}

export interface StoreKitProduct {
  /** The App Store product id (`productID`), the catalog's store identifier. */
  productId: string;
  referenceName: string;
  type: StoreKitProductType;
  /** Price as written in the file, in the file's storefront currency. */
  price: number | null;
  /** ISO 8601 period for auto-renewing subscriptions (`recurringSubscriptionPeriod`), else null. */
  duration: string | null;
  group: string | null;
  /** 1 is the highest level of service in the group. */
  groupLevel: number | null;
  familyShareable: boolean;
  displayName: string | null;
  description: string | null;
  locales: string[];
  introOffer: StoreKitIntroOffer | null;
  /** Number of promotional (ad hoc) and offer code offers declared. */
  promotionalOffers: number;
  offerCodes: number;
}

export interface StoreKitConfig {
  /** `version.major` (1 to 4 at the time of writing), or null when the file has no version. */
  formatVersion: number | null;
  storefront: string | null;
  locale: string | null;
  products: StoreKitProduct[];
  groups: { id: string | null; name: string; products: string[] }[];
  warnings: string[];
}

export class StoreKitParseError extends Error {}

const PERIOD = /^P(\d+)([DWMY])$/;
/** Limits for files from anywhere: products kept, warnings listed, characters per string. */
export const STOREKIT_MAX_PRODUCTS = 500;
const MAX_WARNINGS = 50;
const MAX_STR = 300;
type J = Record<string, unknown>;
const isObj = (v: unknown): v is J => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, MAX_STR) : null);
/** Own keys only, so "constructor" or "__proto__" in a file never reads Object.prototype. */
const lookup = <T>(table: Record<string, T>, key: string | null): T | undefined => (key !== null && Object.hasOwn(table, key) ? table[key] : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown) => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
};

const TYPES: Record<string, StoreKitProductType> = {
  Consumable: "consumable", NonConsumable: "non_consumable", RecurringSubscription: "subscription", NonRenewingSubscription: "non_renewing_subscription",
};
const MODES: Record<string, StoreKitIntroOffer["mode"]> = { free: "free_trial", payAsYouGo: "pay_as_you_go", payUpFront: "pay_up_front" };

/** Parses the text of a `.storekit` file. Throws StoreKitParseError when it is not one. */
export function parseStoreKitConfig(text: string): StoreKitConfig {
  let root: unknown;
  try { root = JSON.parse(text.replace(/^﻿/, "")); } catch { throw new StoreKitParseError("This is not a StoreKit configuration file: it is not JSON."); }
  if (!isObj(root) || !("products" in root || "subscriptionGroups" in root || "nonRenewingSubscriptions" in root)) {
    throw new StoreKitParseError("This is not a StoreKit configuration file: it has no products, subscriptionGroups or nonRenewingSubscriptions.");
  }
  const warnings: string[] = [];
  let unlisted = 0, overLimit = 0;
  const warn = (w: string) => { if (warnings.length < MAX_WARNINGS) warnings.push(w); else unlisted++; };
  const products: StoreKitProduct[] = [];
  const seen = new Set<string>();
  const settings = isObj(root.settings) ? root.settings : {};

  const read = (p: unknown, where: string, group: { id: string | null; name: string } | null): StoreKitProduct | null => {
    if (!isObj(p)) { warn(`${where}: skipped an entry that is not an object.`); return null; }
    const productId = str(p.productID);
    if (!productId) { warn(`${where}: skipped a product with no productID.`); return null; }
    if (seen.has(productId)) { warn(`${productId} appears twice; the second one is skipped.`); return null; }
    if (products.length >= STOREKIT_MAX_PRODUCTS) { overLimit++; return null; }
    const rawType = str(p.type);
    const type = lookup(TYPES, rawType) ?? (group ? "subscription" : null);
    if (!type) { warn(`${productId}: unknown type "${rawType ?? ""}", skipped.`); return null; }
    seen.add(productId);
    const locs = arr(p.localizations).filter(isObj);
    const first = locs.find((l) => str(l.locale) === str(settings._locale)) ?? locs[0];
    const duration = type === "subscription" ? str(p.recurringSubscriptionPeriod) : null;
    if (type === "subscription" && (!duration || !PERIOD.test(duration))) warn(`${productId}: no valid recurringSubscriptionPeriod.`);
    const intro = isObj(p.introductoryOffer) ? p.introductoryOffer : null;
    const mode = intro ? lookup(MODES, str(intro.paymentMode)) : undefined;
    return {
      productId, referenceName: str(p.referenceName) ?? productId, type, price: num(p.displayPrice), duration: duration && PERIOD.test(duration) ? duration : null,
      group: group?.name ?? null, groupLevel: group ? num(p.groupNumber) : null, familyShareable: p.familyShareable === true,
      displayName: first ? str(first.displayName) : null, description: first ? str(first.description) : null,
      locales: locs.map((l) => str(l.locale)).filter((x): x is string => !!x).slice(0, 100),
      introOffer: intro && mode ? { mode, period: str(intro.subscriptionPeriod)?.match(PERIOD)?.[0] ?? null, periods: num(intro.numberOfPeriods) ?? 1, price: mode === "free_trial" ? 0 : num(intro.displayPrice) } : null,
      promotionalOffers: arr(p.adHocOffers).length, offerCodes: arr(p.codeOffers).length,
    };
  };

  for (const [i, p] of arr(root.products).entries()) { const x = read(p, `products[${i}]`, null); if (x) products.push(x); }
  const groups: StoreKitConfig["groups"] = [];
  for (const [i, g] of arr(root.subscriptionGroups).slice(0, STOREKIT_MAX_PRODUCTS).entries()) {
    if (!isObj(g)) continue;
    const group = { id: str(g.id), name: str(g.name) ?? `Group ${i + 1}` };
    const ids: string[] = [];
    for (const [j, s] of arr(g.subscriptions).entries()) {
      const x = read(s, `subscriptionGroups[${i}].subscriptions[${j}]`, group);
      if (x) { products.push(x); ids.push(x.productId); }
    }
    groups.push({ ...group, products: ids });
  }
  for (const [i, p] of arr(root.nonRenewingSubscriptions).entries()) { const x = read(p, `nonRenewingSubscriptions[${i}]`, null); if (x) products.push({ ...x, type: "non_renewing_subscription" }); }
  const version = isObj(root.version) ? num(root.version.major) : null;
  if (unlisted) warnings.push(`${unlisted} more warnings are not listed.`);
  if (overLimit) warnings.push(`Only the first ${STOREKIT_MAX_PRODUCTS} products are read; ${overLimit} more are left out.`);
  return { formatVersion: version, storefront: str(settings._storefront), locale: str(settings._locale), products, groups, warnings };
}
