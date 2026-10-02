import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { attributionFromAttributes, newId, type AppleAdsNames } from "@revenuedot/core";
import { schema } from "@revenuedot/db";
import { accountServer } from "./account-helpers.js";
import { getOrCreateCustomer, mergeCustomers, setAttributes } from "../src/repo/customers.js";
import { resyncAppleAdsNames, syncCustomerAttribution } from "../src/repo/attribution.js";
import { setAttributionOnce } from "../src/services/attribution.js";

/**
 * First-class attribution (prd/attribution-benchmarks-insights §1): every writer keeps `customer_attribution` in step,
 * Apple Search Ads names follow the connection, the migration's backfill reads attributes the same way as the code, and
 * audiences and the Customers lists filter on it.
 */
type S = Awaited<ReturnType<typeof accountServer>>;
let s: S;
let ada: Awaited<ReturnType<S["signup"]>>;
let P = "";
const row = async (customerId: string) => (await s.db.select().from(schema.customerAttribution).where(eq(schema.customerAttribution.customerId, customerId)))[0] ?? null;
const customer = async (appUserId: string) => (await getOrCreateCustomer(s.db, ada.projectId!, appUserId, s.now())).customer;

beforeAll(async () => {
  s = await accountServer();
  ada = await s.signup("ada@example.com");
  P = `/v2/projects/${ada.projectId}`;
});
afterAll(async () => { await s.close(); });

describe("keeping customer_attribution in step", () => {
  it("follows attributes set through the REST API, and drops the row when they are cleared", async () => {
    await customer("rest_user");
    const r = await ada.browser.call("POST", `${P}/customers/rest_user/attributes`, { attributes: [{ name: "$mediaSource", value: "Meta" }, { name: "$campaign", value: "Spring" }, { name: "$appsflyerId", value: "af-1" }, { name: "$email", value: "x@y.z" }] });
    expect(r.status).toBe(200);
    const c = await customer("rest_user");
    expect(await row(c.id)).toMatchObject({ projectId: ada.projectId, mediaSource: "Meta", campaign: "Spring", partnerIds: { appsflyer_id: "af-1" } });
    const api = await ada.browser.call("GET", `${P}/customers/rest_user/attribution`);
    expect(api.body.attribution).toMatchObject({ object: "customer_attribution", media_source: "Meta", campaign: "Spring", ad_group: null, partner_ids: { appsflyer_id: "af-1" } });
    s.advance(1000);
    await ada.browser.call("POST", `${P}/customers/rest_user/attributes`, { attributes: [{ name: "$mediaSource", value: null }, { name: "$campaign", value: null }, { name: "$appsflyerId", value: null }] });
    expect(await row(c.id)).toBeNull();
    expect((await ada.browser.call("GET", `${P}/customers/rest_user/attribution`)).body.attribution).toBeNull();
  });

  it("stays write-once for AdServices data and follows a customer merge", async () => {
    const a = await customer("anon_1"), b = await customer("known_1");
    await setAttributionOnce(s.db, a.id, { $mediaSource: { value: "Apple Search Ads" }, $campaign: { value: "111" }, $appleAdsCampaignId: { value: "111" }, $appleAdsAdGroupId: { value: "222" } }, s.now());
    await setAttributionOnce(s.db, a.id, { $campaign: { value: "999" } }, s.now());
    expect(await row(a.id)).toMatchObject({ mediaSource: "Apple Search Ads", campaign: "111", campaignId: "111", adGroup: "222" });
    await setAttributes(s.db, b.id, { $email: { value: "k@example.com" } }, s.now());
    await mergeCustomers(s.db, a.id, b.id);
    expect(await row(a.id)).toBeNull();
    expect(await row(b.id)).toMatchObject({ mediaSource: "Apple Search Ads", campaignId: "111" });
  });

  it("puts Apple Search Ads names on every attributed customer when the names load", async () => {
    await s.db.insert(schema.integrations).values({ id: newId("int_", 10), projectId: ada.projectId!, kind: "apple_search_ads", name: "Apple Search Ads", settings: { names: { campaigns: { 111: "Brand US" }, ad_groups: { 222: "Exact match" } } } });
    const n = await resyncAppleAdsNames(s.db, ada.projectId!);
    expect(n).toBe(1);
    const b = await customer("known_1");
    expect(await row(b.id)).toMatchObject({ campaign: "Brand US", campaignId: "111", adGroup: "Exact match", adGroupId: "222" });
    // A new AdServices customer gets the names straight away.
    const c = await customer("asa_2");
    await setAttributionOnce(s.db, c.id, { $mediaSource: { value: "Apple Search Ads" }, $campaign: { value: "111" }, $appleAdsCampaignId: { value: "111" } }, s.now());
    expect(await row(c.id)).toMatchObject({ campaign: "Brand US" });
  });
});

describe("audiences and the Customers lists", () => {
  it("filter by campaign name, media source and the other attribution fields", async () => {
    const d = await customer("tiktok_1");
    await setAttributes(s.db, d.id, { $mediaSource: { value: "TikTok" }, $campaign: { value: "Launch" }, $adGroup: { value: "18-24" }, $keyword: { value: "sleep" }, $ad: { value: "v1" }, $creative: { value: "red" } }, s.now());
    const preview = await ada.browser.call("POST", `${P}/audiences/actions/preview`, { rules: { groups: [{ conditions: [{ field: "campaign", operator: "is", value: "Brand US" }] }] } });
    expect(preview.body.customer_sample.map((m: any) => m.app_user_id).sort()).toEqual(["asa_2", "known_1"]);
    const rules = { groups: [{ conditions: [{ field: "mediaSource", operator: "is", value: "TikTok" }, { field: "adGroup", operator: "is", value: "18-24" }, { field: "keyword", operator: "contains", value: "slee" }, { field: "creative", operator: "is", value: "red" }, { field: "ad", operator: "isAnyOf", value: "v1,v2" }] }] };
    const list = await ada.browser.call("GET", `${P}/customer_lists?list=all&rules=${encodeURIComponent(JSON.stringify(rules))}`);
    expect(list.body.items.map((x: any) => x.id)).toEqual(["tiktok_1"]);
    const empty = await ada.browser.call("GET", `${P}/customer_lists?list=all&rules=${encodeURIComponent(JSON.stringify({ groups: [{ conditions: [{ field: "mediaSource", operator: "isEmpty" }] }] }))}`);
    expect(empty.body.items.map((x: any) => x.id)).not.toContain("tiktok_1");
    expect(empty.body.items.map((x: any) => x.id)).toContain("rest_user");
  });

  it("suggest the project's values, Apple Search Ads campaigns by name", async () => {
    const r = await ada.browser.call("GET", `${P}/audiences/filter_options?fields=campaign,mediaSource,adGroup`);
    const by = Object.fromEntries(r.body.items.map((i: any) => [i.field, i.options.map((o: any) => o.id)]));
    expect(by.campaign).toEqual(["Brand US", "Launch"]);
    expect(by.mediaSource).toEqual(["Apple Search Ads", "TikTok"]);
    expect(by.adGroup).toEqual(["18-24", "Exact match"]);
  });
});

describe("the migration's backfill", () => {
  it("reads attributes exactly like attributionFromAttributes", async () => {
    const m = readFileSync(new URL("../../../packages/db/migrations/0027_attribution_benchmarks_insights.sql", import.meta.url), "utf8");
    const backfill = m.slice(m.indexOf("-- Backfill"));
    const cases: Record<string, Record<string, string>> = {
      plain: { $mediaSource: " Meta ", $campaign: "Spring", $adGroup: "A", $ad: "Ad 1", $keyword: "kw", $creative: "c", $email: "nope@example.com" },
      asa_ids: { $mediaSource: "Apple Search Ads", $campaign: "111", $adGroup: "222", $keyword: "333", $appleAdsCampaignId: "111", $appleAdsAdGroupId: "222", $appleAdsKeywordId: "333", $appleAdsAdId: "444", $appleAdsCountryOrRegion: "de", $claimType: "Click", $conversionType: "Download" },
      asa_only_ids: { $appleAdsCampaignId: "111", $appleAdsOrgId: "9" },
      own_name: { $campaign: "Mine", $appleAdsCampaignId: "111" },
      partners: { $adjustId: "adj", $branchId: "br", $kochavaDeviceId: "k", $singularDeviceId: "s", $tenjinId: "t", $airbridgeDeviceId: "a" },
      long: { $mediaSource: "x".repeat(300) },
      blank: { $mediaSource: "   ", $campaign: "" },
      nothing: { $idfa: "AAAA", $email: "e@x.y" },
    };
    const names: AppleAdsNames = { campaigns: { 111: "Brand US" }, ad_groups: { 222: "Exact match" } };
    const ids: Record<string, string> = {};
    for (const [k, attrs] of Object.entries(cases)) {
      const c = await customer(`bf_${k}`);
      ids[k] = c.id;
      await s.db.insert(schema.customerAttributes).values(Object.entries(attrs).map(([key, value]) => ({ customerId: c.id, key, value, updatedAtMs: 1 })));
    }
    // As before the migration: no rows; then the backfill SQL.
    await s.db.delete(schema.customerAttribution);
    await s.db.execute(sql.raw(backfill));
    for (const [k, attrs] of Object.entries(cases)) {
      const want = attributionFromAttributes(attrs, names);
      const got = await row(ids[k]!);
      if (!want) { expect(got, k).toBeNull(); continue; }
      const { customerId: _c, projectId: _p, updatedAt: _u, ...fields } = got!;
      expect(fields, k).toEqual(want);
    }
    // And the earlier customers come back as the code would build them.
    const b = await customer("known_1");
    expect(await row(b.id)).toMatchObject({ campaign: "Brand US" });
    await syncCustomerAttribution(s.db, b.id);
    expect(await row(b.id)).toMatchObject({ campaign: "Brand US" });
  });
});
