import { describe, expect, it } from "vitest";
import {
  APPLE_SEARCH_ADS, attributionFromAttributes, attributionReport, chartDef, dimValues, isAttributionKey, runChart,
  type ChartInput, type ChartTx,
} from "../src/index.js";

const DAY = 86_400_000;
const T = (s: string) => Date.parse(s.length === 10 ? `${s}T00:00:00Z` : s);

describe("attributionFromAttributes", () => {
  it("reads the reserved attributes an attribution partner sets", () => {
    const row = attributionFromAttributes({ $mediaSource: "Facebook Ads", $campaign: "Spring sale", $adGroup: "US 25-34", $ad: "Video 3", $keyword: null, $creative: "blue", $appsflyerId: "af-1", $adjustId: "adj-9" });
    expect(row).toEqual({
      mediaSource: "Facebook Ads", campaign: "Spring sale", campaignId: null, adGroup: "US 25-34", adGroupId: null, ad: "Video 3", adId: null,
      keyword: null, keywordId: null, creative: "blue", claimType: null, conversionType: null, attributionCountry: null,
      partnerIds: { appsflyer_id: "af-1", adjust_id: "adj-9" },
    });
  });

  it("treats Apple Search Ads ids as Apple Search Ads, and shows ids until names are loaded", () => {
    // What resolveAdServicesToken stores: $mediaSource plus $campaign = the campaign id.
    const attrs = { $mediaSource: APPLE_SEARCH_ADS, $campaign: "542370539", $adGroup: "542317095", $keyword: "87675432", $ad: "542317136",
      $appleAdsCampaignId: "542370539", $appleAdsAdGroupId: "542317095", $appleAdsKeywordId: "87675432", $appleAdsAdId: "542317136",
      $appleAdsCountryOrRegion: "us", $claimType: "Click", $conversionType: "Download" };
    const raw = attributionFromAttributes(attrs)!;
    expect(raw).toMatchObject({ mediaSource: APPLE_SEARCH_ADS, campaign: "542370539", campaignId: "542370539", adGroup: "542317095", keyword: "87675432", ad: "542317136", attributionCountry: "US", claimType: "Click" });
    const named = attributionFromAttributes(attrs, { campaigns: { 542370539: "Brand US" }, ad_groups: { 542317095: "Exact" } })!;
    expect(named).toMatchObject({ campaign: "Brand US", campaignId: "542370539", adGroup: "Exact", adGroupId: "542317095", keyword: "87675432" });
  });

  it("keeps a name the app set over the Apple name, and names Apple Search Ads without a media source", () => {
    const row = attributionFromAttributes({ $campaign: "My own name", $appleAdsCampaignId: "1" }, { campaigns: { 1: "Apple's name" } })!;
    expect(row.campaign).toBe("My own name");
    expect(row.mediaSource).toBe(APPLE_SEARCH_ADS);
    expect(attributionFromAttributes({ $appleAdsCampaignId: "1" }, { campaigns: { 1: "Apple's name" } })!.campaign).toBe("Apple's name");
  });

  it("has no row without attribution, ignores empty values and caps long ones", () => {
    expect(attributionFromAttributes({})).toBeNull();
    expect(attributionFromAttributes({ $email: "a@b.c", $idfa: "x", $mediaSource: "  ", $campaign: "" })).toBeNull();
    expect(attributionFromAttributes({ $mediaSource: "x".repeat(500) })!.mediaSource).toHaveLength(200);
    expect(attributionFromAttributes({ $branchId: "br-1" })).toMatchObject({ mediaSource: null, partnerIds: { branch_id: "br-1" } });
  });

  it("knows which keys are attribution", () => {
    expect(isAttributionKey("$mediaSource")).toBe(true);
    expect(isAttributionKey("$appleAdsCampaignId")).toBe(true);
    expect(isAttributionKey("$appsflyerId")).toBe(true);
    expect(isAttributionKey("$email")).toBe(false);
    expect(isAttributionKey("$idfa")).toBe(false);
  });
});

/**
 * Six new customers in June:
 *   a1, a2: Meta "Spring" (a1 pays $10 on day 0 and renews on day 31; a2 starts a trial and converts on day 7)
 *   b1:     Meta "Summer", buys $20 on day 3, refunded on day 5
 *   c1:     Apple Search Ads "Brand", buys $50 on day 10
 *   n1, n2: no attribution; n1 buys $5 on day 40
 * Plus o1, first seen in April, outside the range.
 */
let n = 0;
const tx = (customerId: string, kind: ChartTx["kind"], at: number, usd: number, o: Partial<ChartTx> = {}): ChartTx =>
  ({ id: `t${n++}`, customerId, appId: "ios", store: "app_store", storeTransactionId: o.storeTransactionId ?? `${customerId}-${at}`, productId: "monthly", kind, at, expiresAt: kind === "one_time" || kind === "refund" ? null : at + 30 * DAY, usd, country: "US", ...o });
const JUNE = T("2026-06-01");
const NOW = T("2026-08-15T12:00:00Z");
function input(): ChartInput {
  const cust = (id: string, firstSeen: number, media: string | null, campaign: string | null) =>
    ({ id, firstSeen, country: "US", platform: "iOS", appVersion: "1.0", attribution: { media_source: media, campaign, ad_group: null, keyword: null, ad: null, creative: null } });
  return {
    now: NOW, fx: () => 1, products: [{ appId: "ios", storeIdentifier: "monthly", type: "subscription", duration: "P1M" }], subStates: [], lifecycle: [], sdkEvents: [], refundEvents: [], activity: [],
    customers: [
      cust("a1", JUNE + 3600_000, "Meta", "Spring"), cust("a2", JUNE + 2 * DAY, "Meta", "Spring"), cust("b1", JUNE + 4 * DAY, "Meta", "Summer"),
      cust("c1", JUNE + 5 * DAY, APPLE_SEARCH_ADS, "Brand"), cust("n1", JUNE + 6 * DAY, null, null), cust("n2", JUNE + 7 * DAY, null, null),
      cust("o1", T("2026-04-01"), "Meta", "Spring"),
    ],
    txs: [
      tx("a1", "purchase", JUNE + 2 * 3600_000, 10), tx("a1", "renewal", JUNE + 31 * DAY + 3600_000, 10),
      tx("a2", "trial", JUNE + 2 * DAY, 0), tx("a2", "renewal", JUNE + 9 * DAY, 10),
      tx("b1", "purchase", JUNE + 7 * DAY, 20, { storeTransactionId: "B1" }), tx("b1", "refund", JUNE + 9 * DAY, -20, { storeTransactionId: "B1" }),
      tx("c1", "purchase", JUNE + 15 * DAY, 50),
      tx("n1", "purchase", JUNE + 46 * DAY, 5),
      tx("o1", "purchase", T("2026-06-10"), 99),
    ],
  };
}

describe("attributionReport", () => {
  const range = { from: JUNE, to: T("2026-07-01") };

  it("groups June's new customers by campaign with day 0, 7, 30 and to-date revenue", () => {
    const r = attributionReport(input(), { ...range, groupBy: "campaign" });
    const by = Object.fromEntries(r.rows.map((x) => [x.key, x]));
    expect(r.rows.map((x) => x.key)).toEqual(["Brand", "Spring", "", "Summer"]);
    expect(by.Spring).toMatchObject({ customers: 2, trial_starts: 1, paying_customers: 2, conversion_to_paying: 100, revenue_day_0: 10, revenue_day_7: 20, revenue_day_30: 20, revenue_to_date: 30, revenue_per_customer: 15, revenue_per_paying_customer: 15 });
    // b1 bought on day 3 and was refunded on day 5: no paying customer, nothing left by day 7.
    expect(by.Summer).toMatchObject({ customers: 1, paying_customers: 0, conversion_to_paying: 0, revenue_day_0: 0, revenue_day_7: 0, revenue_to_date: 0, revenue_per_paying_customer: null });
    expect(by.Brand).toMatchObject({ revenue_day_7: 0, revenue_day_30: 50, revenue_to_date: 50 });
    expect(by[""]).toMatchObject({ customers: 2, paying_customers: 1, revenue_day_30: 0, revenue_to_date: 5 });
    expect(r.total).toMatchObject({ customers: 6, paying_customers: 4, revenue_to_date: 85 });
    expect(r.total.day_30_incomplete).toBe(false);
  });

  it("filters to one media source and groups by it", () => {
    const meta = attributionReport(input(), { ...range, groupBy: "campaign", mediaSource: "Meta" });
    expect(meta.rows.map((x) => x.key)).toEqual(["Spring", "Summer"]);
    const none = attributionReport(input(), { ...range, groupBy: "media_source", mediaSource: "" });
    expect(none.rows).toHaveLength(1);
    expect(none.rows[0]).toMatchObject({ key: "", customers: 2 });
    const sources = attributionReport(input(), { ...range, groupBy: "media_source" });
    expect(Object.fromEntries(sources.rows.map((x) => [x.key, x.customers]))).toEqual({ Meta: 3, [APPLE_SEARCH_ADS]: 1, "": 2 });
  });

  it("marks windows that have not closed", () => {
    const i = { ...input(), now: JUNE + 10 * DAY };
    const r = attributionReport(i, { ...range, groupBy: "campaign" });
    expect(r.total.day_7_incomplete).toBe(true);
    expect(r.total.day_30_incomplete).toBe(true);
    // Nothing after "now" counts.
    expect(r.rows.find((x) => x.key === "Brand")!.revenue_to_date).toBe(0);
  });
});

describe("attribution chart dimensions", () => {
  const req = { resolution: "month" as const, rangeStart: JUNE, rangeEnd: T("2026-07-01"), expand: true, selectors: {} };
  it("filters and segments a money chart by campaign", () => {
    const def = chartDef("revenue")!;
    expect(def.dims).toContain("campaign");
    const all = runChart(def, input(), req);
    const spring = runChart(def, input(), req, { filters: [{ name: "campaign", values: ["Spring"] }] });
    // June revenue: a1 10 + a2 10 + b1 20 - 20 + c1 50 + o1 99 = 169; Spring is a1, a2 and o1 (first seen in April).
    expect(all.output.kind === "series" && all.output.points[0]!.values[0]).toBe(169);
    expect(spring.output.kind === "series" && spring.output.points[0]!.values[0]).toBe(119);
    const seg = runChart(def, input(), req, { segment: "media_source" });
    const vals = Object.fromEntries(seg.segments!.map((s) => [s.id, s.output.kind === "series" ? s.output.points[0]!.values[0] : null]));
    expect(vals).toEqual({ Meta: 119, [APPLE_SEARCH_ADS]: 50, "": 0 });
  });
  it("filters new customers by attribution (a customer dimension)", () => {
    const def = chartDef("customers_new")!;
    const none = runChart(def, input(), req, { filters: [{ name: "media_source", values: [""] }] });
    expect(none.output.kind === "series" && none.output.points[0]!.values[0]).toBe(2);
    expect(dimValues(input(), "media_source")).toEqual(["Meta", "", APPLE_SEARCH_ADS]);
  });
});
