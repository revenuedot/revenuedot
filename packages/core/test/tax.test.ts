import { describe, expect, it } from "vitest";
import { chartDef, estimatedTaxShare, revenueFactor, runChart, splitGross, taxShare, taxSourceOf, VAT_RATES, type ChartInput, type ChartTx } from "../src/index.js";

// Tax inside a transaction's price (core tax.ts; prd/charts/PRD.md "Taxes").
describe("tax share of a price", () => {
  it("uses the tax the store reported", () => {
    expect(taxSourceOf({ taxAmount: 2 })).toBe("store");
    expect(taxShare({ store: "stripe", country: "DE", taxAmount: 2, priceAmount: 12 })).toBeCloseTo(2 / 12);
    expect(taxShare({ store: "stripe", country: "DE", taxAmount: 0, priceAmount: 12 })).toBe(0);
    expect(taxShare({ store: "paddle", country: "DE", taxAmount: 50, priceAmount: 12 })).toBe(1);
  });
  it("estimates VAT and GST inside store prices from the country", () => {
    expect(taxSourceOf({ taxAmount: null })).toBe("estimated");
    expect(taxShare({ store: "app_store", country: "DE" })).toBeCloseTo(19 / 119);
    expect(taxShare({ store: "play_store", country: "gb" })).toBeCloseTo(20 / 120);
    expect(estimatedTaxShare("app_store", "UK")).toBeCloseTo(20 / 120);
    expect(estimatedTaxShare("app_store", "JP")).toBeCloseTo(10 / 110);
  });
  it("adds no tax where prices exclude it, for web purchases without a reported tax, and for unknown countries", () => {
    for (const c of ["US", "CA", "PR"]) expect(estimatedTaxShare("app_store", c)).toBe(0);
    expect(estimatedTaxShare("stripe", "DE")).toBe(0);
    expect(estimatedTaxShare("app_store", null)).toBe(0);
    expect(estimatedTaxShare("app_store", "HK")).toBe(0);
  });
  it("covers the EU and the large app markets", () => {
    for (const c of ["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE", "GB", "NO", "CH", "AU", "NZ", "JP", "KR", "IN", "MX", "TR", "SA", "AE", "ZA"]) {
      expect(VAT_RATES[c], c).toBeGreaterThan(0);
    }
    expect(Object.keys(VAT_RATES).length).toBeGreaterThan(110);
  });
  it("splits gross into tax, commission and proceeds", () => {
    expect(revenueFactor("revenue", 0.2, 0.3)).toBe(1);
    expect(revenueFactor("revenue_net_of_taxes", 0.2, 0.3)).toBeCloseTo(0.8);
    expect(revenueFactor("proceeds", 0.2, 0.3)).toBeCloseTo(0.56);
    const s = splitGross(12, 1 / 6, 0.3);
    expect(s.tax).toBeCloseTo(2);
    expect(s.commission).toBeCloseTo(3);
    expect(s.proceeds).toBeCloseTo(7);
    expect(s.taxPercentage + s.commissionPercentage + s.proceeds / 12).toBeCloseTo(1);
  });
});

describe("Revenue and Cohort Explorer net of taxes", () => {
  const T = (s: string) => Date.parse(`${s}T00:00:00Z`);
  const tx = (id: string, store: string, country: string, usd: number, tax: number, commission: number): ChartTx => ({
    id, customerId: id, appId: "a", store, storeTransactionId: id, productId: "lifetime", kind: "one_time", at: T("2026-03-10"), expiresAt: null, usd, country, tax, commission,
  });
  const input: ChartInput = {
    now: T("2026-04-30"), fx: () => 1, lifecycle: [], subStates: [], sdkEvents: [], refundEvents: [], activity: [],
    txs: [tx("de", "app_store", "DE", 11.9, 19 / 119, 0.3), tx("us", "app_store", "US", 10, 0, 0.3), tx("web", "stripe", "FR", 12, 2 / 12, 0.029)],
    customers: ["de", "us", "web"].map((id) => ({ id, firstSeen: T("2026-03-10"), country: null, platform: null, appVersion: null })),
    products: [{ appId: "a", storeIdentifier: "lifetime", type: "non_consumable", duration: null }],
  };
  const req = (selectors: Record<string, string>) => ({ resolution: "month" as const, rangeStart: T("2026-03-01"), rangeEnd: T("2026-04-01"), expand: false, selectors });
  const revenue = (type: string) => { const o = runChart(chartDef("revenue")!, input, req({ revenue_type: type })).output; return o.kind === "series" ? o.points[0]!.values[0]! : NaN; };
  it("takes each row's tax out before the store commission", () => {
    expect(revenue("revenue")).toBeCloseTo(33.9);
    expect(revenue("revenue_net_of_taxes")).toBeCloseTo(10 + 10 + 10);
    expect(revenue("proceeds")).toBeCloseTo(10 * 0.7 + 10 * 0.7 + 10 * 0.971);
  });
  it("applies to the Cohort Explorer", () => {
    const o = runChart(chartDef("cohort_explorer")!, input, { ...req({ cohort_measure: "revenue_net_of_taxes" }), rangeEnd: T("2026-04-01") }).output;
    expect(o.kind === "cohort" ? o.rows[0]!.cells[1]!.value : null).toBeCloseTo(30);
  });
});
