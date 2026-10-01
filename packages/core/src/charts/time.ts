/**
 * Chart periods. Everything is UTC: days start at 00:00, weeks on Monday, months, quarters and years on their first day.
 * A bucket is the half-open interval [start, end) in epoch milliseconds.
 */
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

export type Resolution = "day" | "week" | "month" | "quarter" | "year";
/** Position = the resolution id RevenueCat's API uses ("0" day … "4" year). */
export const RESOLUTIONS: Resolution[] = ["day", "week", "month", "quarter", "year"];

export interface Bucket { start: number; end: number }

export const dayStart = (t: number) => Math.floor(t / DAY) * DAY;

/** Adds calendar months; the day of month is clamped (Jan 31 + 1 month = Feb 28 or 29), the time of day kept. */
export function addMonths(t: number, n: number): number {
  const d = new Date(t);
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + n, day = d.getUTCDate();
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Date.UTC(y, m, Math.min(day, last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
}

/** The start of the period that contains `t`. */
export function floorTo(t: number, res: Resolution): number {
  const d = new Date(t);
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  switch (res) {
    case "day": return dayStart(t);
    case "week": return dayStart(t) - ((d.getUTCDay() + 6) % 7) * DAY;
    case "month": return Date.UTC(y, m, 1);
    case "quarter": return Date.UTC(y, m - (m % 3), 1);
    case "year": return Date.UTC(y, 0, 1);
  }
}

/** The start of the period `n` periods after the one starting at `start` (which must be a period start). */
export function addPeriods(start: number, res: Resolution, n = 1): number {
  switch (res) {
    case "day": return start + n * DAY;
    case "week": return start + n * 7 * DAY;
    case "month": return addMonths(start, n);
    case "quarter": return addMonths(start, 3 * n);
    case "year": return addMonths(start, 12 * n);
  }
}

/** Every period that overlaps [from, to). */
export function buckets(from: number, to: number, res: Resolution, max = Infinity): Bucket[] {
  const out: Bucket[] = [];
  for (let s = floorTo(from, res); s < to; s = addPeriods(s, res)) {
    out.push({ start: s, end: addPeriods(s, res) });
    if (out.length > max) break;
  }
  return out;
}

/**
 * Normalises a price to one month, the way RevenueCat's MRR does: 1 day ×30, 3 days ×10, 1 week ×4, 2 weeks ×2,
 * 4 weeks ×1, 1 month ×1, 2 months ×½, 3 months ×⅓, 6 months ×⅙, 1 year ×1/12. In general ×30/days, ×4/weeks,
 * ×1/months. Returns null for a missing or unparseable ISO 8601 duration.
 */
export function mrrFactor(iso: string | null | undefined): number | null {
  const m = iso ? /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?$/.exec(iso) : null;
  if (!m) return null;
  const [y, mo, w, d] = [m[1], m[2], m[3], m[4]].map((x) => Number(x ?? 0)) as [number, number, number, number];
  // Express the duration in the unit RevenueCat's table would: months if it has any, else weeks, else days.
  if (y || mo) { const months = y * 12 + mo + w * 7 / 30 + d / 30; return months > 0 ? 1 / months : null; }
  if (w) { const weeks = w + d / 7; return 4 / weeks; }
  return d > 0 ? 30 / d : null;
}

export const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);
