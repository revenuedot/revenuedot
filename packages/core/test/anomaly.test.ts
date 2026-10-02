// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: the revenue anomaly detector's math (prd/account-settings/PRD.md §4).
import { describe, expect, it } from "vitest";
import { ANOMALY_RULES, detectAnomaly, median } from "../src/index.js";

/** 28 days that wobble around `base` by ±`wobble` in a fixed pattern. */
const steady = (base: number, wobble: number, n = 28) => Array.from({ length: n }, (_, i) => base + [0, 1, -1, 2, -2, 1, -1][i % 7]! * wobble);

describe("median", () => {
  it("handles odd, even and empty lists", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

describe("detectAnomaly", () => {
  it("flags a revenue drop to zero and a spike, with the robust z-score and the change", () => {
    const h = steady(1000, 50);
    const drop = detectAnomaly("revenue", h, 0);
    expect(drop).toMatchObject({ anomaly: true, reason: "anomaly", direction: "down", median: 1000, change: -1 });
    expect(drop.z).toBeLessThan(-3);
    const spike = detectAnomaly("revenue", h, 2600);
    expect(spike).toMatchObject({ anomaly: true, direction: "up", change: 1.6 });
    // MAD of the pattern is 50 (1.4826 × 50 = 74.1), below the floor of 10% of the median: the spread is 100.
    expect(spike.spread).toBe(100);
    expect(spike.z).toBe(16);
    // A wider wobble (MAD 100) puts the spread above the floor.
    expect(detectAnomaly("revenue", steady(1000, 100), 2600).spread).toBeCloseTo(148.26, 6);
  });

  it("ignores normal days and small absolute moves", () => {
    const h = steady(1000, 50);
    expect(detectAnomaly("revenue", h, 1080)).toMatchObject({ anomaly: false, reason: "within_range" });
    // $3 against $1 is +200% with a huge z, but below the $20 minimum change.
    expect(detectAnomaly("revenue", steady(1, 0), 3)).toMatchObject({ anomaly: false, reason: "within_range" });
  });

  it("sensitivity changes the thresholds", () => {
    const h = steady(100, 10); // spread = max(14.826, 10, minAbs / z)
    // 135: z ≈ 2.36, +35%: only high sensitivity alerts.
    expect(detectAnomaly("revenue", h, 135, "high").anomaly).toBe(true);
    expect(detectAnomaly("revenue", h, 135, "medium").anomaly).toBe(false);
    expect(detectAnomaly("revenue", h, 135, "low").anomaly).toBe(false);
    // 160: z ≈ 4.05, +60%, $60: every sensitivity alerts.
    for (const s of ["low", "medium", "high"] as const) expect(detectAnomaly("revenue", h, 160, s).anomaly).toBe(true);
    expect(ANOMALY_RULES.medium).toEqual({ z: 3, relative: 0.3, minAbsolute: { revenue: 20, new_subscriptions: 3 } });
  });

  it("a flat history does not divide by zero: the spread has floors", () => {
    const flat = Array(28).fill(10);
    const r = detectAnomaly("new_subscriptions", flat, 10);
    expect(r).toMatchObject({ anomaly: false, z: 0, spread: 1 });
    // 10 → 4 subscriptions: spread max(0, 1, 3/3) = 1, z = −6, −60%, 6 ≥ 3: an anomaly.
    expect(detectAnomaly("new_subscriptions", flat, 4)).toMatchObject({ anomaly: true, direction: "down", z: -6 });
    // 10 → 8: z = −2, below 3.
    expect(detectAnomaly("new_subscriptions", flat, 8).anomaly).toBe(false);
  });

  it("needs 14 days of history and something in it", () => {
    expect(detectAnomaly("revenue", steady(1000, 50, 13), 0)).toMatchObject({ anomaly: false, reason: "not_enough_history" });
    expect(detectAnomaly("revenue", steady(1000, 50, 14), 0)).toMatchObject({ anomaly: true });
    expect(detectAnomaly("revenue", Array(28).fill(0), 500)).toMatchObject({ anomaly: false, reason: "not_enough_history" });
  });

  it("uses only the last 28 days and is not thrown by one outlier day", () => {
    const old = Array(30).fill(10_000);
    const h = [...old, ...steady(1000, 50)];
    expect(detectAnomaly("revenue", h, 1000).median).toBe(1000);
    const withOutlier = steady(1000, 50);
    withOutlier[5] = 20_000;
    expect(detectAnomaly("revenue", withOutlier, 0).anomaly).toBe(true);
    expect(detectAnomaly("revenue", withOutlier, 1050).anomaly).toBe(false);
  });
});
