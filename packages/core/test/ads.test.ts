import { describe, expect, it } from "vitest";
import {
  adTotals, adUnitMatches, adsOverview, derToP1363, matchRewardRule, parseAdMobCallback, parseRewardCustomData, periodDays, rewardAnswer, ruleCurrencyAmount,
  type AdEventGroup, type RewardRule,
} from "../src/ads/index.js";

/** Ads (prd/ads/PRD.md): overview aggregation, reward rules, the SDK's poll answer and AdMob callback parsing. */

const g = (o: Partial<AdEventGroup>): AdEventGroup => ({ day: "2026-09-20", type: "rc_ads_ad_displayed", currency: null, network: "AdMob", format: "banner", placement: "home", adUnitId: "ca-app-pub-1/111", mediator: "AdMob", count: 1, micros: 0, ...o });
// 1 EUR = 1.25 USD; GBP unknown.
const fx = (amount: number, currency: string) => (currency === "USD" ? amount : currency === "EUR" ? amount * 1.25 : null);

describe("ads overview", () => {
  const groups = [
    g({ type: "rc_ads_ad_revenue", currency: "USD", count: 100, micros: 250_000 }),
    g({ type: "rc_ads_ad_displayed", count: 100 }),
    g({ type: "rc_ads_ad_opened", count: 4 }),
    g({ type: "rc_ads_ad_loaded", count: 120 }),
    g({ type: "rc_ads_ad_failed_to_load", count: 30 }),
    // Impression-level revenue only (no displayed events): each revenue event is an impression.
    g({ day: "2026-09-21", type: "rc_ads_ad_revenue", currency: "EUR", network: "Unity", format: "rewarded", placement: "level_end", adUnitId: "ca-app-pub-1/222", count: 50, micros: 1_000_000 }),
    g({ day: "2026-09-21", type: "rc_ads_ad_revenue", currency: "GBP", network: "Unity", format: "rewarded", placement: "level_end", adUnitId: "ca-app-pub-1/222", count: 2, micros: 30_000 }),
  ];

  it("converts per day, counts impressions, eCPM, CTR and fill rate", () => {
    const o = adsOverview({ groups, days: ["2026-09-20", "2026-09-21"], fx, subscriptionRevenueByDay: { "2026-09-20": 9.99, "2026-09-21": 0.01 }, adCustomers: 12 });
    // 0.25 USD + 1.00 EUR × 1.25 = 1.50; GBP cannot be converted and counts 0.
    expect(o.totals).toEqual({
      ad_revenue: 1.5, impressions: 152, ecpm: 9.87, clicks: 4, ctr: 0.0263, loaded: 120, failed_to_load: 30, fill_rate: 0.8, revenue_events: 152,
      ad_customers: 12, subscription_revenue: 10, total_revenue: 11.5, ad_share: 0.1304,
    });
    expect(o.unconverted).toEqual([{ currency: "GBP", amount: 0.03 }]);
    expect(o.series).toEqual([
      { date: "2026-09-20", ad_revenue: 0.25, impressions: 100, ecpm: 2.5, clicks: 4, subscription_revenue: 9.99 },
      { date: "2026-09-21", ad_revenue: 1.25, impressions: 52, ecpm: 24.04, clicks: 0, subscription_revenue: 0.01 },
    ]);
    expect(o.breakdowns.network).toEqual([
      { key: "Unity", ad_revenue: 1.25, impressions: 52, ecpm: 24.04, clicks: 0, share: 0.8333 },
      { key: "AdMob", ad_revenue: 0.25, impressions: 100, ecpm: 2.5, clicks: 4, share: 0.1667 },
    ]);
    expect(o.breakdowns.format.map((r) => r.key)).toEqual(["rewarded", "banner"]);
    expect(o.breakdowns.placement.map((r) => r.key)).toEqual(["level_end", "home"]);
    expect(o.breakdowns.ad_unit.map((r) => r.key)).toEqual(["ca-app-pub-1/222", "ca-app-pub-1/111"]);
  });

  it("has no eCPM, CTR or fill rate without impressions or loads, and no ad share without revenue", () => {
    const o = adsOverview({ groups: [], days: ["2026-09-20"], fx });
    expect(o.totals).toMatchObject({ ad_revenue: 0, impressions: 0, ecpm: null, ctr: null, fill_rate: null, ad_share: null, total_revenue: 0 });
    expect(adTotals([g({ type: "rc_ads_ad_displayed", count: 3 })], fx)).toMatchObject({ impressions: 3, ecpm: 0 });
  });

  it("periods are whole UTC days ending today, with a previous period of the same length", () => {
    const p = periodDays("7d", new Date("2026-10-01T15:00:00Z"));
    expect(p.days).toEqual(["2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01"]);
    expect(p.start.toISOString()).toBe("2026-09-25T00:00:00.000Z");
    expect(p.end.toISOString()).toBe("2026-10-02T00:00:00.000Z");
    expect(p.previousStart.toISOString()).toBe("2026-09-18T00:00:00.000Z");
    expect(periodDays("12m", new Date("2026-10-01T00:00:00Z")).days).toHaveLength(365);
  });
});

describe("reward rules", () => {
  const rule = (o: Partial<RewardRule>): RewardRule => ({ id: "r", enabled: true, position: 0, appId: null, adUnitId: null, rewardItem: null, kind: "virtual_currency", currencyCode: "GEMS", amount: 5, multiplier: null, entitlementId: null, durationMinutes: null, ...o });
  const rules = [
    rule({ id: "off", position: 0, enabled: false }),
    rule({ id: "unit", position: 1, adUnitId: "ca-app-pub-3940256099942544/1712485313" }),
    rule({ id: "item", position: 2, rewardItem: "Coins" }),
    rule({ id: "app", position: 3, appId: "app_play" }),
    rule({ id: "any", position: 4 }),
  ];
  it("picks the first enabled match; AdMob's bare unit number matches the SDK's full id", () => {
    expect(matchRewardRule(rules, { appId: "app_ios", adUnitId: "1712485313", rewardItem: null, rewardAmount: 1 })?.id).toBe("unit");
    expect(matchRewardRule(rules, { appId: "app_ios", adUnitId: "999", rewardItem: "coins", rewardAmount: 1 })?.id).toBe("item");
    expect(matchRewardRule(rules, { appId: "app_play", adUnitId: null, rewardItem: null, rewardAmount: 1 })?.id).toBe("app");
    expect(matchRewardRule(rules, { appId: "app_ios", adUnitId: null, rewardItem: null, rewardAmount: 1 })?.id).toBe("any");
    expect(matchRewardRule(rules.slice(0, 3), { appId: "app_ios", adUnitId: null, rewardItem: null, rewardAmount: 1 })).toBeNull();
  });
  it("grants a fixed amount, or the network's amount times the multiplier", () => {
    expect(ruleCurrencyAmount(rule({ amount: 5 }), 10)).toBe(5);
    expect(ruleCurrencyAmount(rule({ amount: null, multiplier: 2.5 }), 10)).toBe(25);
    expect(ruleCurrencyAmount(rule({ amount: null, multiplier: 0.01 }), 10)).toBe(1);
    // Capped at what the ledger holds.
    expect(ruleCurrencyAmount(rule({ amount: null, multiplier: 1_000_000 }), 1_000_000_000)).toBe(1_000_000_000);
    expect(ruleCurrencyAmount(rule({ amount: null, multiplier: 2 }), -5)).toBe(1);
  });
  it("matches an ad unit by its full id or the number after the slash, never an empty one", () => {
    expect(adUnitMatches("ca-app-pub-1/111", "111")).toBe(true);
    expect(adUnitMatches("111", "ca-app-pub-1/111")).toBe(true);
    expect(adUnitMatches("ca-app-pub-1/111", "ca-app-pub-1/111")).toBe(true);
    expect(adUnitMatches("ca-app-pub-1/111", "11")).toBe(false);
    expect(adUnitMatches("", "")).toBe(false);
    expect(adUnitMatches(null, "111")).toBe(false);
  });
});

describe("the SDK's poll answer", () => {
  it("is pending, verified with the first reward and the rest, or failed with a reason", () => {
    expect(rewardAnswer(null)).toEqual({ status: "pending" });
    expect(rewardAnswer({ status: "verified", rewards: [] })).toEqual({ status: "verified", reward: null, more_rewards: [] });
    expect(rewardAnswer({ status: "verified", rewards: [{ type: "virtual_currency", code: "GEMS", amount: 10 }, { type: "entitlement", identifier: "pro", expires_at: "2026-10-02T12:00:00Z" }] }))
      .toEqual({ status: "verified", reward: { type: "virtual_currency", code: "GEMS", amount: 10 }, more_rewards: [{ type: "entitlement", identifier: "pro", expires_at: "2026-10-02T12:00:00Z" }] });
    expect(rewardAnswer({ status: "failed", rewards: [], failureReason: "user_mismatch" })).toEqual({ status: "failed", failure_reason: "user_mismatch", message: "The ad network's user id is not this customer." });
  });
});

describe("AdMob callback parsing", () => {
  const custom = JSON.stringify({ api_key: "appl_testkey123", client_transaction_id: "8A1C0F7E-1111-2222-3333-444455556666", impression_id: "imp-1" });
  const query = `ad_network=5450213213286189855&ad_unit=1234567890&custom_data=${encodeURIComponent(custom)}&reward_amount=10&reward_item=coins&timestamp=1790000000000&transaction_id=123456789&user_id=wren&signature=MEUCIQ-sig_&key_id=3335741209`;
  it("signs everything before &signature= byte for byte", () => {
    const cb = parseAdMobCallback(query)!;
    expect(cb.message).toBe(query.slice(0, query.indexOf("&signature=")));
    expect(cb).toMatchObject({ signature: "MEUCIQ-sig_", keyId: "3335741209" });
    expect(cb.params).toMatchObject({ ad_unit: "1234567890", reward_amount: "10", reward_item: "coins", transaction_id: "123456789", user_id: "wren", custom_data: custom });
    expect(parseAdMobCallback("")).toBeNull();
    expect(parseAdMobCallback("ad_unit=1&user_id=x")).toBeNull();
    // Only the signed part is read: nothing may follow key_id, and no parameter may repeat.
    expect(parseAdMobCallback(`${query}&user_id=mallory`)).toBeNull();
    expect(parseAdMobCallback(query.replace("&signature=", "&user_id=mallory&signature="))).toBeNull();
    expect(parseAdMobCallback(query.replace("key_id=3335741209", "key_id=abc"))).toBeNull();
    expect(parseAdMobCallback(`constructor=1&${query}`)!.params.constructor).toBe("1");
  });
  it("reads the SDK's custom data and nothing else", () => {
    expect(parseRewardCustomData(custom)).toEqual({ apiKey: "appl_testkey123", clientTransactionId: "8A1C0F7E-1111-2222-3333-444455556666", impressionId: "imp-1" });
    expect(parseRewardCustomData("level=3")).toBeNull();
    expect(parseRewardCustomData(JSON.stringify({ api_key: "k" }))).toBeNull();
    expect(parseRewardCustomData(undefined)).toBeNull();
  });
  it("turns a DER signature into r‖s, padding short integers and dropping sign bytes", () => {
    const r = new Uint8Array(32).fill(0xaa), s = new Uint8Array(31).fill(0x11);
    // r has its high bit set, so DER prefixes 0x00; s is 31 bytes.
    const der = Uint8Array.from([0x30, 2 + 33 + 2 + 31, 0x02, 33, 0x00, ...r, 0x02, 31, ...s]);
    const raw = derToP1363(der)!;
    expect(raw).toHaveLength(64);
    expect([...raw.slice(0, 32)]).toEqual([...r]);
    expect([...raw.slice(32)]).toEqual([0, ...s]);
    expect(derToP1363(Uint8Array.from([0x30, 3, 0x02, 1, 1]))).toBeNull();
    expect(derToP1363(Uint8Array.from([0x31, 0]))).toBeNull();
  });
});
