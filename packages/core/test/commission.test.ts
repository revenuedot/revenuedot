import { describe, expect, it } from "vitest";
import { commission, commissionRate, commissionRates, periodsFrom, playNewFeesFrom, type CommissionTx } from "../src/index.js";

const t = (s: string) => Date.parse(`${s}T12:00:00Z`);
const programs = { app1: periodsFrom([{ entry_date: "2025-01-01", exit_date: "2025-07-01" }, { entry_date: "2026-01-01", exit_date: null }]) };

describe("store commission", () => {
  it("App Store: 15% inside Small Business Program periods, 30% outside, exit date exclusive", () => {
    const at = (s: string) => commissionRate({ store: "app_store", appId: "app1", at: t(s), kind: "renewal" }, { programs });
    expect(at("2024-12-31")).toBe(0.3);
    expect(at("2025-01-01")).toBe(0.15);
    expect(at("2025-06-30")).toBe(0.15);
    expect(at("2025-07-01")).toBe(0.3);
    expect(at("2026-03-01")).toBe(0.15);
    expect(commissionRate({ store: "mac_app_store", appId: "app1", at: t("2026-03-01"), kind: "purchase" }, { programs })).toBe(0.15);
    expect(commissionRate({ store: "app_store", appId: "other", at: t("2026-03-01"), kind: "purchase" }, { programs })).toBe(0.3);
  });

  it("Amazon: 20% inside the Small Business Accelerator, 30% outside", () => {
    expect(commissionRate({ store: "amazon", appId: "app1", at: t("2026-02-01"), kind: "purchase" }, { programs })).toBe(0.2);
    expect(commissionRate({ store: "amazon", appId: "app1", at: t("2025-09-01"), kind: "purchase" }, { programs })).toBe(0.3);
  });

  it("Google Play: subscriptions 15%; one-time purchases 15% up to $1M a year, then 30% (25% for new installs under the 2026 fees)", () => {
    const sub = (ytd: number) => commissionRate({ store: "play_store", appId: "a", at: t("2026-08-01"), kind: "renewal" }, {}, ytd);
    expect(sub(0)).toBe(0.15);
    expect(sub(5_000_000)).toBe(0.15);
    const one = (ytd: number, o: { country?: string; firstSeen?: number; at?: string } = {}) =>
      commissionRate({ store: "play_store", appId: "a", at: t(o.at ?? "2026-08-01"), kind: "one_time", country: o.country ?? "US", firstSeen: o.firstSeen ?? t("2026-01-01") }, {}, ytd);
    expect(one(999_999)).toBe(0.15);
    expect(one(1_000_000)).toBe(0.3);
    expect(one(1_000_000, { firstSeen: t("2026-07-15") })).toBe(0.25);
    expect(one(1_000_000, { firstSeen: t("2026-07-15"), country: "BR" })).toBe(0.3);
    expect(playNewFeesFrom("de")).toBe(Date.UTC(2026, 5, 30));
    expect(playNewFeesFrom("JP")).toBe(Date.UTC(2026, 8, 30));
    expect(playNewFeesFrom("KR")).toBe(Date.UTC(2026, 11, 31));
  });

  it("commissionRates counts each app's Google Play sales per calendar year, in purchase order", () => {
    const txs: CommissionTx[] = [
      { id: "p1", store: "play_store", appId: "a", at: t("2026-02-01"), usd: 600_000, kind: "one_time", country: "BR" },
      { id: "p2", store: "play_store", appId: "a", at: t("2026-03-01"), usd: 500_000, kind: "one_time", country: "BR" },
      { id: "p3", store: "play_store", appId: "a", at: t("2026-04-01"), usd: 10, kind: "one_time", country: "BR" },
      { id: "s1", store: "play_store", appId: "a", at: t("2026-05-01"), usd: 10, kind: "renewal" },
      { id: "r1", store: "play_store", appId: "a", at: t("2026-05-02"), usd: -600_000, kind: "refund" },
      { id: "p4", store: "play_store", appId: "a", at: t("2027-01-02"), usd: 10, kind: "one_time", country: "BR" },
      { id: "b1", store: "play_store", appId: "b", at: t("2026-04-01"), usd: 10, kind: "one_time", country: "BR" },
      { id: "i1", store: "app_store", appId: "app1", at: t("2026-04-01"), usd: 10, kind: "purchase" },
      { id: "x1", store: "stripe", appId: null, at: t("2026-04-01"), usd: 10, kind: "purchase" },
    ];
    const r = commissionRates(txs, { programs });
    expect(Object.fromEntries(r)).toEqual({ p1: 0.15, p2: 0.15, p3: 0.3, s1: 0.15, r1: 0.15, p4: 0.15, b1: 0.15, i1: 0.15, x1: 0 });
  });

  it("other stores and the core default", () => {
    expect(commissionRate({ store: "galaxy", appId: null, at: 0, kind: "purchase" })).toBe(0.3);
    expect(commissionRate({ store: "roku", appId: null, at: 0, kind: "purchase" })).toBe(0.2);
    expect(commissionRate({ store: "paddle", appId: null, at: 0, kind: "purchase" })).toBe(0.05);
    expect(commissionRate({ store: "stripe", appId: null, at: 0, kind: "purchase" })).toBe(0);
    expect(commission("play_store")).toBe(0.15);
    expect(commission("app_store")).toBe(0.3);
  });

  it("periodsFrom reads entry and exit dates and skips bad ones", () => {
    expect(periodsFrom([{ entry_date: "2025-01-01", exit_date: "2025-02-01" }, { entry_date: "nope" }, { entry_date: "2026-01-01" }]))
      .toEqual([{ start: Date.UTC(2025, 0, 1), end: Date.UTC(2025, 1, 1) }, { start: Date.UTC(2026, 0, 1), end: null }]);
    expect(periodsFrom(null)).toEqual([]);
  });
});
