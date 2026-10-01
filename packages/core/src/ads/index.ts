/**
 * Ads (prd/ads/PRD.md): the Ads Overview aggregation, reward rule matching, the SDK's reward verification answer and
 * the pieces of AdMob server-side verification that need no I/O (callback parsing, DER to raw ECDSA signatures).
 * Pure code, so the server, tests and the reference numbers agree on Node and Workers.
 */

// ---------- Overview ----------

/** One group of SDK ad events, as the server's SQL aggregates them (one row per day and dimension combination and type). */
export interface AdEventGroup {
  /** UTC day, YYYY-MM-DD. */
  day: string;
  type: string;
  currency: string | null;
  network: string | null;
  format: string | null;
  placement: string | null;
  adUnitId: string | null;
  mediator: string | null;
  /** Number of events in the group. */
  count: number;
  /** Sum of `revenue_micros` (revenue events only). */
  micros: number;
}

export type Fx = (amount: number, currency: string, dayMs: number) => number | null;

export interface AdTotals {
  ad_revenue: number;
  impressions: number;
  ecpm: number | null;
  clicks: number;
  ctr: number | null;
  loaded: number;
  failed_to_load: number;
  fill_rate: number | null;
  revenue_events: number;
}

export interface AdBreakdownRow { key: string; ad_revenue: number; impressions: number; ecpm: number | null; clicks: number; share: number }

export const AD_TYPES = {
  revenue: "rc_ads_ad_revenue", displayed: "rc_ads_ad_displayed", opened: "rc_ads_ad_opened", loaded: "rc_ads_ad_loaded", failed: "rc_ads_ad_failed_to_load",
} as const;
export const AD_EVENT_TYPES = Object.values(AD_TYPES) as string[];

export const AD_DIMENSIONS = ["network", "format", "placement", "ad_unit", "mediator"] as const;
export type AdDimension = (typeof AD_DIMENSIONS)[number];

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`);

interface Cell { revenue: number; displayed: number; revenueEvents: number; clicks: number; loaded: number; failed: number }
const emptyCell = (): Cell => ({ revenue: 0, displayed: 0, revenueEvents: 0, clicks: 0, loaded: 0, failed: 0 });
/** Impressions of a cell: displayed events, or one per revenue event when the network sent only impression-level revenue. */
const impressionsOf = (c: Cell) => (c.displayed > 0 ? c.displayed : c.revenueEvents);

function add(c: Cell, g: AdEventGroup, usd: number) {
  if (g.type === AD_TYPES.revenue) { c.revenue += usd; c.revenueEvents += g.count; }
  else if (g.type === AD_TYPES.displayed) c.displayed += g.count;
  else if (g.type === AD_TYPES.opened) c.clicks += g.count;
  else if (g.type === AD_TYPES.loaded) c.loaded += g.count;
  else if (g.type === AD_TYPES.failed) c.failed += g.count;
}

/** The USD value of a revenue group, or null when its currency cannot be converted. Unknown currency means USD (the SDKs always send one). */
export function groupUsd(g: AdEventGroup, fx: Fx): number | null {
  if (g.type !== AD_TYPES.revenue || !g.micros) return 0;
  return fx(g.micros / 1e6, (g.currency || "USD").toUpperCase(), dayMs(g.day));
}

const cellKey = (g: AdEventGroup) => `${g.day}\u0000${g.network}\u0000${g.format}\u0000${g.placement}\u0000${g.adUnitId}\u0000${g.mediator}`;

function cells(groups: AdEventGroup[], fx: Fx) {
  const map = new Map<string, { g: AdEventGroup; c: Cell }>();
  const unconverted = new Map<string, number>();
  for (const g of groups) {
    const usd = groupUsd(g, fx);
    if (usd === null) unconverted.set((g.currency || "?").toUpperCase(), (unconverted.get((g.currency || "?").toUpperCase()) ?? 0) + g.micros);
    const k = cellKey(g);
    let e = map.get(k);
    if (!e) { e = { g, c: emptyCell() }; map.set(k, e); }
    add(e.c, g, usd ?? 0);
  }
  return { cells: [...map.values()], unconverted: [...unconverted].map(([currency, micros]) => ({ currency, amount: micros / 1e6 })) };
}

function totalsOf(list: Cell[]): AdTotals {
  const s = list.reduce((a, c) => ({ revenue: a.revenue + c.revenue, imp: a.imp + impressionsOf(c), clicks: a.clicks + c.clicks, loaded: a.loaded + c.loaded, failed: a.failed + c.failed, rev: a.rev + c.revenueEvents }),
    { revenue: 0, imp: 0, clicks: 0, loaded: 0, failed: 0, rev: 0 });
  return {
    ad_revenue: r2(s.revenue), impressions: s.imp, ecpm: s.imp ? r2((s.revenue / s.imp) * 1000) : null, clicks: s.clicks, ctr: s.imp ? r4(s.clicks / s.imp) : null,
    loaded: s.loaded, failed_to_load: s.failed, fill_rate: s.loaded + s.failed ? r4(s.loaded / (s.loaded + s.failed)) : null, revenue_events: s.rev,
  };
}

/** Totals of a set of groups (the previous period uses this alone). */
export function adTotals(groups: AdEventGroup[], fx: Fx): AdTotals {
  return totalsOf(cells(groups, fx).cells.map((x) => x.c));
}

const dimValue = (g: AdEventGroup, d: AdDimension) => (d === "network" ? g.network : d === "format" ? g.format : d === "placement" ? g.placement : d === "ad_unit" ? g.adUnitId : g.mediator) ?? "";

export interface AdsOverviewInput {
  groups: AdEventGroup[];
  /** Days of the period, oldest first (YYYY-MM-DD). */
  days: string[];
  fx: Fx;
  /** Subscription revenue (USD) per day of the period. */
  subscriptionRevenueByDay?: Record<string, number>;
  /** Distinct customers with an ad event in the period. */
  adCustomers?: number;
}

export function adsOverview(i: AdsOverviewInput) {
  const { cells: list, unconverted } = cells(i.groups, i.fx);
  const totals = totalsOf(list.map((x) => x.c));
  const subscription = r2(Object.values(i.subscriptionRevenueByDay ?? {}).reduce((a, b) => a + b, 0));
  const series = i.days.map((day) => {
    const t = totalsOf(list.filter((x) => x.g.day === day).map((x) => x.c));
    return { date: day, ad_revenue: t.ad_revenue, impressions: t.impressions, ecpm: t.ecpm, clicks: t.clicks, subscription_revenue: r2(i.subscriptionRevenueByDay?.[day] ?? 0) };
  });
  const breakdown = (d: AdDimension): AdBreakdownRow[] => {
    const by = new Map<string, Cell[]>();
    for (const x of list) { const k = dimValue(x.g, d); by.set(k, [...(by.get(k) ?? []), x.c]); }
    return [...by].map(([key, cs]) => {
      const t = totalsOf(cs);
      return { key, ad_revenue: t.ad_revenue, impressions: t.impressions, ecpm: t.ecpm, clicks: t.clicks, share: totals.ad_revenue ? r4(t.ad_revenue / totals.ad_revenue) : 0 };
    }).sort((a, b) => b.ad_revenue - a.ad_revenue || b.impressions - a.impressions || a.key.localeCompare(b.key));
  };
  const total = r2(totals.ad_revenue + subscription);
  return {
    totals: { ...totals, ad_customers: i.adCustomers ?? 0, subscription_revenue: subscription, total_revenue: total, ad_share: total > 0 ? r4(totals.ad_revenue / total) : null },
    series,
    breakdowns: Object.fromEntries(AD_DIMENSIONS.map((d) => [d, breakdown(d)])) as Record<AdDimension, AdBreakdownRow[]>,
    unconverted,
  };
}

/** The UTC days of a period that ends today (inclusive), oldest first. */
export function periodDays(range: "7d" | "28d" | "90d" | "12m", now: Date): { days: string[]; start: Date; end: Date; previousStart: Date } {
  const n = range === "7d" ? 7 : range === "28d" ? 28 : range === "90d" ? 90 : 365;
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const start = new Date(end.getTime() - n * 86_400_000);
  const days = Array.from({ length: n }, (_, k) => new Date(start.getTime() + k * 86_400_000).toISOString().slice(0, 10));
  return { days, start, end, previousStart: new Date(start.getTime() - n * 86_400_000) };
}

// ---------- Rewards ----------

export interface RewardRule {
  id: string; enabled: boolean; position: number; appId: string | null; adUnitId: string | null; rewardItem: string | null;
  kind: string; currencyCode: string | null; amount: number | null; multiplier: number | null; entitlementId: string | null; durationMinutes: number | null;
}

export interface RewardInput { appId: string | null; adUnitId: string | null; rewardItem: string | null; rewardAmount: number | null }

/** The first enabled rule (by position) whose app, ad unit and reward item match; an empty rule field matches anything. */
export function matchRewardRule<R extends RewardRule>(rules: R[], r: RewardInput): R | null {
  const norm = (s: string | null | undefined) => (s ?? "").trim();
  // AdMob's callback names the unit "1234567890" while the SDK sends "ca-app-pub-…/1234567890": either form matches.
  const unitMatches = (rule: string, got: string) => rule === got || rule.endsWith(`/${got}`) || got.endsWith(`/${rule}`);
  return [...rules].sort((a, b) => a.position - b.position).find((x) =>
    x.enabled
    && (!x.appId || x.appId === r.appId)
    && (!norm(x.adUnitId) || (!!norm(r.adUnitId) && unitMatches(norm(x.adUnitId), norm(r.adUnitId))))
    && (!norm(x.rewardItem) || norm(x.rewardItem).toLowerCase() === norm(r.rewardItem).toLowerCase())) ?? null;
}

/** The currency amount a rule grants: its fixed amount, or the network's amount times the multiplier (rounded, at least 1). */
export function ruleCurrencyAmount(rule: RewardRule, networkAmount: number | null): number {
  if (rule.multiplier !== null && rule.multiplier !== undefined) return Math.max(1, Math.round((networkAmount ?? 0) * rule.multiplier));
  return Math.max(0, rule.amount ?? 0);
}

export type SdkReward = { type: "virtual_currency"; code: string; amount: number } | { type: "entitlement"; identifier: string; expires_at: string };

/**
 * The answer to `GET /v1/subscribers/{id}/ads/reward_verifications/{client_transaction_id}` in the shape both SDKs decode
 * (iOS `RewardVerificationStatusResponse`, Android `RewardVerificationResponse`): pending until a verification exists.
 */
export function rewardAnswer(v: { status: string; rewards: SdkReward[] | Record<string, unknown>[]; failureReason?: string | null } | null) {
  if (!v) return { status: "pending" as const };
  if (v.status === "failed") return { status: "failed" as const, failure_reason: v.failureReason ?? "verification_failed", message: FAILURE_MESSAGES[v.failureReason ?? ""] ?? "The reward could not be verified." };
  const [first, ...more] = v.rewards as SdkReward[];
  return { status: "verified" as const, reward: first ?? null, more_rewards: more };
}

export const FAILURE_MESSAGES: Record<string, string> = {
  user_mismatch: "The ad network's user id is not this customer.",
  missing_user: "The ad network's callback has no user id. Pass the app user id to the network's server-side verification options.",
  grant_failed: "The reward rule names an in-app currency or entitlement that no longer exists.",
};

// ---------- AdMob server-side verification ----------

export const ADMOB_KEYS_URL = "https://www.gstatic.com/admob/reward/verifier-keys.json";

export interface AdMobCallback {
  /** The bytes Google signed: the raw query string before `&signature=`. */
  message: string;
  signature: string;
  keyId: string;
  params: Record<string, string>;
}

/**
 * Splits AdMob's SSV query (https://developers.google.com/admob/android/ssv). `signature` and `key_id` are always the
 * last two parameters; everything before `&signature=` is what Google signed, byte for byte as it arrived.
 * Returns null when the query has no signature (Google's "Verify URL" check calls with no parameters).
 */
export function parseAdMobCallback(rawQuery: string): AdMobCallback | null {
  const q = rawQuery.startsWith("?") ? rawQuery.slice(1) : rawQuery;
  const at = q.indexOf("&signature=");
  if (at < 0) return null;
  const params: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(q)) params[k] = v;
  if (!params.signature || !params.key_id) return null;
  return { message: q.slice(0, at), signature: params.signature, keyId: params.key_id, params };
}

/** The SDK's `customData`: `{"api_key","client_transaction_id","impression_id"}`; null when it is not that. */
export function parseRewardCustomData(raw: string | undefined | null): { apiKey: string; clientTransactionId: string; impressionId: string | null } | null {
  if (!raw) return null;
  let j: unknown;
  try { j = JSON.parse(raw); } catch { return null; }
  if (!j || typeof j !== "object") return null;
  const o = j as Record<string, unknown>;
  if (typeof o.api_key !== "string" || !o.api_key || typeof o.client_transaction_id !== "string" || !o.client_transaction_id) return null;
  if (o.client_transaction_id.length > 128 || o.api_key.length > 200) return null;
  return { apiKey: o.api_key, clientTransactionId: o.client_transaction_id, impressionId: typeof o.impression_id === "string" ? o.impression_id.slice(0, 200) : null };
}

export function base64UrlDecode(s: string): Uint8Array<ArrayBuffer> {
  const b = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b + "=".repeat((4 - (b.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/**
 * An ECDSA signature in DER (SEQUENCE of two INTEGERs, what Google sends) as the 64-byte r‖s that WebCrypto verifies
 * (IEEE P1363). Returns null for anything that is not a well-formed P-256 DER signature.
 */
export function derToP1363(der: Uint8Array, size = 32): Uint8Array<ArrayBuffer> | null {
  let i = 0;
  const byte = () => (i < der.length ? der[i++]! : -1);
  const len = () => {
    const l = byte();
    if (l < 0) return -1;
    if (l < 0x80) return l;
    const n = l & 0x7f;
    if (n < 1 || n > 2) return -1;
    let v = 0;
    for (let k = 0; k < n; k++) { const b = byte(); if (b < 0) return -1; v = (v << 8) | b; }
    return v;
  };
  if (byte() !== 0x30) return null;
  const seqLen = len();
  if (seqLen < 0 || i + seqLen !== der.length) return null;
  const out = new Uint8Array(size * 2);
  for (let part = 0; part < 2; part++) {
    if (byte() !== 0x02) return null;
    const l = len();
    if (l <= 0 || i + l > der.length) return null;
    let v = der.subarray(i, i + l);
    i += l;
    while (v.length > size && v[0] === 0) v = v.subarray(1);
    if (v.length > size) return null;
    out.set(v, part * size + (size - v.length));
  }
  return i === der.length ? out : null;
}
