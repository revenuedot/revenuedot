/**
 * Tax inside a transaction's price, for "Revenue (net of taxes)" and proceeds (prd/charts/PRD.md, "Taxes").
 *
 * A ledger row keeps the tax the store reported (`transactions.tax_amount`, in the row's currency, `tax_source` 'store'):
 *   Stripe     the invoice's tax (`total_taxes`, `tax`, or `total` − `total_excluding_tax`); Checkout line items' `amount_tax`.
 *   Paddle     `details.totals.tax` of the transaction (line item totals for multi-item one-time purchases).
 *   Google     the order's `tax` (orders API), when a purchase is verified from its order id.
 * Rows without it (App Store, Amazon, Galaxy, Roku and Google receipts, which report no tax, and rows recorded before
 * tax amounts were stored) are estimated when they are read, never stored, so a corrected rate applies to past rows too:
 *   - the price is taken as tax-inclusive (App Store, Mac App Store, Google Play, Amazon, Galaxy Store, Roku, Paddle),
 *     and the tax is price × rate ÷ (1 + rate) with the standard VAT/GST rate of the customer's country;
 *   - prices in the US, Canada and Puerto Rico exclude sales tax (the store adds it at checkout): no tax;
 *   - Stripe and other web or granted purchases without a reported tax: no tax (Stripe only charges tax through Stripe
 *     Tax, which reports it); an unknown country: no tax.
 * Store commission is then taken from the price net of tax (commission.ts), so proceeds = (price − tax) × (1 − commission).
 */

/**
 * Standard VAT/GST rates (percent) by ISO country code. Source: PwC Worldwide Tax Summaries, "Value-added tax (VAT)
 * rates", https://taxsummaries.pwc.com/quick-charts/value-added-tax-vat-rates, read 2026-10-03. Where PwC gives a range,
 * the rate for electronically supplied services is used: China 6, India 18, Malaysia 8, Pakistan 15 (Islamabad
 * services), Paraguay 10, Tanzania 18, Uruguay 22. Countries PwC lists as having no VAT (Hong Kong, Kuwait, Qatar …)
 * and Brazil (several federal and municipal taxes) are left out, which means no tax.
 */
export const VAT_RATES: Readonly<Record<string, number>> = {
  // European Union
  AT: 20, BE: 21, BG: 20, HR: 25, CY: 19, CZ: 21, DK: 25, EE: 24, FI: 25.5, FR: 20, DE: 19, GR: 24, HU: 27, IE: 23, IT: 22,
  LV: 21, LT: 21, LU: 17, MT: 18, NL: 21, PL: 23, PT: 23, RO: 21, SK: 23, SI: 22, ES: 21, SE: 25,
  // Rest of Europe
  GB: 20, IM: 20, JE: 5, NO: 25, IS: 24, CH: 8.1, LI: 8.1, AL: 20, BA: 17, ME: 21, MK: 18, RS: 20, XK: 18, MD: 20, UA: 20,
  TR: 20, GE: 18, AM: 20, AZ: 18,
  // Asia and Pacific
  AU: 10, NZ: 15, JP: 10, KR: 10, CN: 6, TW: 5, SG: 9, MY: 8, TH: 7, ID: 12, PH: 12, VN: 10, KH: 10, LA: 10, MM: 5, MN: 10,
  IN: 18, BD: 15, PK: 15, KZ: 16, UZ: 12, PG: 10, NC: 11,
  // Middle East and Africa
  AE: 5, SA: 15, BH: 10, OM: 5, IL: 18, JO: 16, LB: 11, PS: 16, EG: 14, MA: 20, TN: 19, ZA: 15, NG: 7.5, KE: 16, GH: 15,
  TZ: 18, UG: 18, RW: 18, ZM: 16, MZ: 16, AO: 14, NA: 15, BW: 14, SZ: 15, ET: 15, MU: 15, MG: 20, MR: 16, SN: 18, CI: 18,
  CM: 19.25, TD: 18, GA: 18, GQ: 15, CG: 18.9, CD: 16, CV: 15,
  // Americas
  MX: 16, AR: 21, CL: 19, CO: 19, PE: 18, EC: 15, BO: 13, PY: 10, UY: 22, VE: 16, CR: 13, DO: 18, GT: 12, SV: 13, HN: 15,
  NI: 15, PA: 7, JM: 15, TT: 12.5, BB: 17.5, BS: 10, LC: 12.5, GY: 14,
};

/** Storefronts whose prices exclude sales tax: the store adds it at checkout, so the price we record holds none. */
export const TAX_EXCLUSIVE_COUNTRIES: ReadonlySet<string> = new Set(["US", "CA", "PR"]);

/** Stores whose prices include the tax they collect as merchant of record. */
const TAX_INCLUSIVE_STORES: ReadonlySet<string> = new Set(["app_store", "mac_app_store", "play_store", "amazon", "galaxy", "roku", "paddle"]);

export type TaxSource = "store" | "estimated";

/** The estimated share of a tax-inclusive price that is tax (0 … 1), from the store and the customer's country. */
export function estimatedTaxShare(store: string, country: string | null | undefined): number {
  if (!TAX_INCLUSIVE_STORES.has(store)) return 0;
  const c = (country ?? "").toUpperCase();
  if (!c || TAX_EXCLUSIVE_COUNTRIES.has(c)) return 0;
  const rate = VAT_RATES[c === "UK" ? "GB" : c];
  return rate ? rate / (100 + rate) : 0;
}

export interface TaxedRow {
  store: string;
  country?: string | null;
  /** Tax the store reported, inside `priceAmount` (same currency); null or undefined when it reported none. */
  taxAmount?: number | null;
  priceAmount?: number | null;
}

/** Where a row's tax comes from: the store, or the estimate above. */
export const taxSourceOf = (t: Pick<TaxedRow, "taxAmount">): TaxSource => (t.taxAmount === null || t.taxAmount === undefined ? "estimated" : "store");

/** The share of a row's gross price that is tax (0 … 1): the store's figure when it gave one, else the estimate. */
export function taxShare(t: TaxedRow): number {
  if (taxSourceOf(t) === "store") {
    const price = Math.abs(t.priceAmount ?? 0);
    if (!(price > 0)) return 0;
    return Math.min(1, Math.max(0, Math.abs(t.taxAmount!) / price));
  }
  return estimatedTaxShare(t.store, t.country);
}

/** The three revenue measures RevenueCat offers: gross, net of taxes, and proceeds (net of taxes and commission). */
export type RevenueType = "revenue" | "revenue_net_of_taxes" | "proceeds";
export const REVENUE_TYPES: readonly RevenueType[] = ["revenue", "revenue_net_of_taxes", "proceeds"];

/** What share of a row's gross revenue counts for a revenue type. */
export function revenueFactor(type: string | undefined, taxShareOf: number, commissionRate: number): number {
  if (type === "revenue_net_of_taxes") return 1 - taxShareOf;
  if (type === "proceeds") return (1 - taxShareOf) * (1 - commissionRate);
  return 1;
}

/**
 * A gross amount split the way RevenueCat's MonetaryAmount and webhook percentages split it: tax out of the gross,
 * commission out of what is left, proceeds the rest. Percentages are shares of the gross and add up to 1.
 */
export function splitGross(gross: number, taxShareOf: number, commissionRate: number) {
  const tax = gross * taxShareOf;
  const commission = (gross - tax) * commissionRate;
  return { tax, commission, proceeds: gross - tax - commission, taxPercentage: taxShareOf, commissionPercentage: (1 - taxShareOf) * commissionRate };
}
