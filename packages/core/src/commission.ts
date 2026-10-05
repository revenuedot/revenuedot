/**
 * Store commission per transaction, the way RevenueCat estimates it
 * (https://www.revenuecat.com/docs/dashboard-and-metrics/taxes-and-commissions):
 *   App Store / Mac App Store  30%; 15% while the app is in the Small Business Program (entry and exit dates per app).
 *   Google Play                subscriptions 15%; one-time purchases 15% on the first $1M of the app's sales in a calendar
 *                              year, then 30% for the rest of that year. Under Google's 2026 fees, a one-time purchase above
 *                              $1M by a customer who first installed the app on or after the region's start date is 25%.
 *   Amazon Appstore            30%; 20% while the app is in the Small Business Accelerator Program.
 *   Galaxy Store 30%, Roku 20%, Paddle 5% (estimates: RevenueCat publishes no rate), everything else 0.
 * Program dates are compared with the transaction's purchase time, so changing them recomputes past proceeds wherever
 * proceeds are derived (charts, metrics, exports, REST); webhooks and integration events already sent keep their values,
 * as in RevenueCat.
 */

/** A program membership: entry at `start`, exit at `end` (exclusive; null while still enrolled). Epoch ms. */
export interface ProgramPeriod { start: number; end: number | null }

export interface CommissionSettings {
  /** Per app id: App Store Small Business Program or Amazon Small Business Accelerator periods. */
  programs?: Record<string, ProgramPeriod[]>;
}

export interface CommissionTx {
  id: string; store: string; appId: string | null; at: number; usd: number;
  /** purchase | renewal | trial | one_time | refund | refund_reversal (the transactions ledger's kinds). */
  kind: string;
  country?: string | null;
  /** When the customer was first seen: RevenueCat's proxy for the install date. */
  firstSeen?: number | null;
}

export const PLAY_REDUCED_TIER_USD = 1_000_000;

const utc = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);
const EEA = new Set(["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE", "IS", "LI", "NO"]);

/** When Google's 2026 fee structure takes effect for a customer's country. */
export function playNewFeesFrom(country: string | null | undefined): number {
  const c = (country ?? "").toUpperCase();
  if (EEA.has(c) || c === "GB" || c === "UK" || c === "US") return utc(2026, 6, 30);
  if (c === "AU" || c === "JP") return utc(2026, 9, 30);
  if (c === "KR") return utc(2026, 12, 31);
  return utc(2027, 9, 30);
}

export const inPeriods = (at: number, periods: ProgramPeriod[] | undefined) => !!periods?.some((p) => at >= p.start && (p.end === null || at < p.end));

const isOneTime = (kind: string) => kind === "one_time";
/** What counts toward the $1M a year: money that came in (purchases, renewals, one-time purchases). */
const countsTowardTier = (kind: string) => kind === "purchase" || kind === "renewal" || kind === "one_time";

/**
 * The rate for one transaction. `playYearToDate` is the app's Google Play sales in the transaction's calendar year before
 * it (only needed for Google Play one-time purchases; unknown counts as under $1M, RevenueCat's default assumption).
 */
export function commissionRate(tx: Omit<CommissionTx, "id" | "usd"> & { usd?: number }, settings: CommissionSettings = {}, playYearToDate = 0): number {
  const periods = tx.appId ? settings.programs?.[tx.appId] : undefined;
  switch (tx.store) {
    case "app_store": case "mac_app_store": return inPeriods(tx.at, periods) ? 0.15 : 0.3;
    case "amazon": return inPeriods(tx.at, periods) ? 0.2 : 0.3;
    case "play_store": {
      if (!isOneTime(tx.kind)) return 0.15;
      if (playYearToDate < PLAY_REDUCED_TIER_USD) return 0.15;
      const from = playNewFeesFrom(tx.country);
      return tx.at >= from && tx.firstSeen !== null && tx.firstSeen !== undefined && tx.firstSeen >= from ? 0.25 : 0.3;
    }
    case "galaxy": return 0.3;
    case "roku": return 0.2;
    case "paddle": return 0.05;
    default: return 0;
  }
}

/** The calendar year (UTC) a time falls in, for the $1M tier. */
const yearOf = (at: number) => new Date(at).getUTCFullYear();
/** An app's calendar year (UTC), the $1M tier's scope. */
export const playTierKey = (appId: string | null, at: number) => `${appId ?? ""}|${yearOf(at)}`;

/**
 * Per app and calendar year (playTierKey), the Google Play transaction whose sales take the year to $1M, in the order
 * commissionRates reads them (time, then id): every Google Play transaction after it is above the tier. Lets a subset of
 * an environment's transactions (daily rollups build customers in batches) get the rates the whole set gives them.
 */
export type PlayTierCrossings = Map<string, { at: number; id: string }>;

/** The crossings of a whole environment's transactions (what the server computes in SQL for a batched build). */
export function playTierCrossings(txs: CommissionTx[]): PlayTierCrossings {
  const out: PlayTierCrossings = new Map();
  const ytd = new Map<string, number>();
  for (const t of txs.filter((x) => x.store === "play_store").sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))) {
    const key = playTierKey(t.appId, t.at);
    if (out.has(key) || !countsTowardTier(t.kind) || !(t.usd > 0)) continue;
    const sum = (ytd.get(key) ?? 0) + t.usd;
    ytd.set(key, sum);
    if (sum >= PLAY_REDUCED_TIER_USD) out.set(key, { at: t.at, id: t.id });
  }
  return out;
}

/**
 * Rates for a set of transactions (one environment of one project), keyed by transaction id. Google Play one-time
 * purchases see the app's sales earlier in the same calendar year: everything in `txs` counts, so pass every Google
 * Play transaction of the environment, not only the ones being reported.
 */
export function commissionRates(txs: CommissionTx[], settings: CommissionSettings = {}, crossings?: PlayTierCrossings): Map<string, number> {
  const out = new Map<string, number>();
  const play = txs.filter((t) => t.store === "play_store").sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
  const ytd = new Map<string, number>();
  for (const t of play) {
    const key = playTierKey(t.appId, t.at);
    if (crossings) {
      // Known from every transaction of the environment (playTierCrossings): above the tier after the crossing one.
      const c = crossings.get(key);
      out.set(t.id, commissionRate(t, settings, c && (t.at > c.at || (t.at === c.at && t.id > c.id)) ? PLAY_REDUCED_TIER_USD : 0));
      continue;
    }
    const before = ytd.get(key) ?? 0;
    out.set(t.id, commissionRate(t, settings, before));
    if (countsTowardTier(t.kind) && t.usd > 0) ytd.set(key, before + t.usd);
  }
  for (const t of txs) if (!out.has(t.id)) out.set(t.id, commissionRate(t, settings));
  return out;
}

/** Program periods from app settings (`YYYY-MM-DD` entry and exit dates, exit exclusive at the start of that day). */
export function periodsFrom(raw: unknown): ProgramPeriod[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
  const out: ProgramPeriod[] = [];
  for (const r of list as Array<Record<string, unknown>>) {
    const s = typeof r?.entry_date === "string" ? Date.parse(`${r.entry_date}T00:00:00Z`) : NaN;
    if (Number.isNaN(s)) continue;
    const e = typeof r.exit_date === "string" && r.exit_date ? Date.parse(`${r.exit_date}T00:00:00Z`) : null;
    out.push({ start: s, end: e !== null && !Number.isNaN(e) ? e : null });
  }
  return out;
}
