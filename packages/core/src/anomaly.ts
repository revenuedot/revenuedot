/**
 * Revenue anomaly detection (prd/account-settings/PRD.md §4). Pure: one day's value against the days before it.
 *
 * The baseline is the median of the trailing days and the spread their median absolute deviation (MAD), scaled by
 * 1.4826 so it estimates a standard deviation for normal data while ignoring the odd outlier day. A day is an anomaly
 * when all three hold for the chosen sensitivity:
 *   - the robust z-score |x − median| / spread is at least `z`,
 *   - the relative change |x − median| / median is at least `relative` (always true when the median is 0),
 *   - the absolute change is at least `minAbsolute` for that series (so $3 against $1 never alerts).
 * A flat history (MAD 0) would make every change infinite, so the spread has floors: 10% of the median, and the
 * series' minimum change divided by `z`. Fewer than ANOMALY_MIN_HISTORY days of history, or a history of nothing but
 * zeros (an app that is not live yet), is "not enough history" and never alerts.
 */

export type AnomalySensitivity = "low" | "medium" | "high";
export type AnomalySeries = "revenue" | "new_subscriptions";

export interface SensitivityRule { z: number; relative: number; minAbsolute: Record<AnomalySeries, number> }

export const ANOMALY_RULES: Record<AnomalySensitivity, SensitivityRule> = {
  low: { z: 4, relative: 0.5, minAbsolute: { revenue: 50, new_subscriptions: 5 } },
  medium: { z: 3, relative: 0.3, minAbsolute: { revenue: 20, new_subscriptions: 3 } },
  high: { z: 2, relative: 0.2, minAbsolute: { revenue: 10, new_subscriptions: 2 } },
};

/** Days of history the baseline uses, and the fewest it accepts. */
export const ANOMALY_BASELINE_DAYS = 28;
export const ANOMALY_MIN_HISTORY = 14;

export interface AnomalyResult {
  series: AnomalySeries;
  /** The day's value. */
  value: number;
  /** Median of the history (the usual value). */
  median: number;
  /** The robust spread used (after floors). */
  spread: number;
  z: number;
  /** (value − median) / median; null when the median is 0. */
  change: number | null;
  direction: "up" | "down" | "flat";
  anomaly: boolean;
  /** Why it is not an anomaly when it is not: "not_enough_history", "within_range". */
  reason: "anomaly" | "not_enough_history" | "within_range";
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** `history` is the trailing days before the day, oldest first (only the last ANOMALY_BASELINE_DAYS are used). */
export function detectAnomaly(series: AnomalySeries, history: number[], value: number, sensitivity: AnomalySensitivity = "medium"): AnomalyResult {
  const rule = ANOMALY_RULES[sensitivity] ?? ANOMALY_RULES.medium;
  const h = history.slice(-ANOMALY_BASELINE_DAYS).filter((x) => Number.isFinite(x));
  const med = median(h);
  const mad = median(h.map((x) => Math.abs(x - med)));
  const minAbs = rule.minAbsolute[series];
  const spread = Math.max(1.4826 * mad, 0.1 * Math.abs(med), minAbs / rule.z);
  const diff = value - med;
  const z = spread > 0 ? diff / spread : 0;
  const change = med !== 0 ? diff / Math.abs(med) : null;
  const direction = diff > 0 ? "up" : diff < 0 ? "down" : "flat";
  const base = { series, value, median: med, spread, z: round(z, 2), change: change === null ? null : round(change, 4), direction } as const;
  if (h.length < ANOMALY_MIN_HISTORY || h.every((x) => x === 0)) return { ...base, anomaly: false, reason: "not_enough_history" };
  const anomaly = Math.abs(z) >= rule.z && (change === null || Math.abs(change) >= rule.relative) && Math.abs(diff) >= minAbs;
  return { ...base, anomaly, reason: anomaly ? "anomaly" : "within_range" };
}

const round = (n: number, d: number) => { const p = 10 ** d; return Math.round(n * p) / p; };
