// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: weekly chart buckets that start on the viewer's day (Account settings → Date and region).
import { describe, expect, it } from "vitest";
import { buckets, chartDef, floorTo, runChart, type ChartInput } from "../src/index.js";

const T = (s: string) => Date.parse(`${s}T00:00:00Z`);
const day = (t: number) => new Date(t).toISOString().slice(0, 10);

describe("week start", () => {
  // Wednesday 2026-09-30.
  const wed = T("2026-09-30") + 15 * 3_600_000;
  it("floors to the chosen first day; Monday stays the default", () => {
    expect(day(floorTo(wed, "week"))).toBe("2026-09-28");
    expect(day(floorTo(wed, "week", 1))).toBe("2026-09-28");
    expect(day(floorTo(wed, "week", 0))).toBe("2026-09-27");
    expect(day(floorTo(wed, "week", 6))).toBe("2026-09-26");
    expect(day(floorTo(wed, "week", 3))).toBe("2026-09-30");
    expect(day(floorTo(wed, "week", 4))).toBe("2026-09-24");
    // Other resolutions ignore it.
    expect(day(floorTo(wed, "month", 0))).toBe("2026-09-01");
  });
  it("buckets start on that day", () => {
    const sun = buckets(T("2026-09-01"), T("2026-09-15"), "week", Infinity, 0).map((b) => day(b.start));
    expect(sun).toEqual(["2026-08-30", "2026-09-06", "2026-09-13"]);
    expect(buckets(T("2026-09-01"), T("2026-09-15"), "week").map((b) => day(b.start))).toEqual(["2026-08-31", "2026-09-07", "2026-09-14"]);
  });
  it("a weekly revenue chart groups purchases by the chosen week", () => {
    const tx = (id: string, at: string, usd: number) => ({ id, customerId: id, appId: "ios", store: "app_store", storeTransactionId: id, productId: "coins", kind: "one_time" as const, at: T(at), expiresAt: null, usd, country: "US" });
    const input: ChartInput = {
      now: T("2026-09-30"), txs: [tx("a", "2026-09-13", 10), tx("b", "2026-09-14", 20), tx("c", "2026-09-20", 40)],
      customers: ["a", "b", "c"].map((id) => ({ id, firstSeen: T("2026-09-13"), country: "US", platform: "iOS", appVersion: "1" })),
      products: [{ appId: "ios", storeIdentifier: "coins", type: "consumable", duration: null }], subStates: [], lifecycle: [], sdkEvents: [], refundEvents: [], activity: [], fx: () => 1,
    } as unknown as ChartInput;
    const run = (weekStart: number) => {
      const o = runChart(chartDef("revenue")!, input, { resolution: "week", rangeStart: T("2026-09-13"), rangeEnd: T("2026-09-27"), expand: true, selectors: {}, weekStart }).output;
      return o.kind === "series" ? o.points.map((p) => [day(p.start), p.values[0]]) : [];
    };
    // Sunday weeks: Sep 13 (a, b) and Sep 20 (c).
    expect(run(0)).toEqual([["2026-09-13", 30], ["2026-09-20", 40]]);
    // Monday weeks: Sep 7 (a), Sep 14 (b, c), Sep 21 (nothing).
    expect(run(1)).toEqual([["2026-09-07", 10], ["2026-09-14", 60], ["2026-09-21", 0]]);
  });
});
