import { and, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { commissionRates, type ChartInput, type ChartLifecycle, type ChartRefundEvent, type TxKind } from "@revenuedot/core";
import { commissionSettingsOf } from "../commission.js";
import { schema, type DB } from "@revenuedot/db";
import { ensureEcbRange, fxLookup, type FxFetch } from "../fx.js";

const DAY = 86_400_000;
const dayStart = (t: number) => Math.floor(t / DAY) * DAY;
const KINDS = new Set<TxKind>(["trial", "purchase", "renewal", "one_time", "refund", "refund_reversal"]);
/** Webhook store names (APP_STORE …) back to ours. */
const storeOf = (s: unknown) => (typeof s === "string" ? s.toLowerCase() : "");

/** The JSON inside a JWS (no signature check: the notification was verified when it arrived). */
function jwsPayload(jws: unknown): Record<string, any> | null {
  if (typeof jws !== "string") return null;
  const part = jws.split(".")[1];
  if (!part) return null;
  try { return JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/"))); } catch { return null; }
}

const REFUND_TYPES: Record<string, ChartRefundEvent["kind"]> = { CONSUMPTION_REQUEST: "request", REFUND: "granted", REFUND_DECLINED: "declined", REFUND_REVERSED: "reversed" };

const AD_TYPES = ["rc_ads_ad_displayed", "rc_ads_ad_opened", "rc_ads_ad_loaded", "rc_ads_ad_failed_to_load", "rc_ads_ad_revenue"];

/** The optional, possibly large row sets a chart reads. Everything else (ledger, subscriptions, customers) is always loaded. */
export interface ChartSources {
  /** SDK event types the chart reads (sdk_events is the largest table: every paywall impression). */
  sdkTypes: string[];
  /** Customer activity days in [from, to) (YYYY-MM-DD), for Active Customers only. */
  activity: { from: string; to: string } | null;
  /** Apple refund requests and outcomes, for Refund Request Outcomes only. */
  refundRequests: boolean;
}

/** What one chart reads beyond the ledger. `range` is the [start, end) the chart covers, its first period included. */
export function chartSources(name: string, range: { from: number; to: number } | null): ChartSources {
  const sdkTypes = name === "revenue" || name === "ad_revenue" ? ["rc_ads_ad_revenue"]
    : name.startsWith("ad_") ? AD_TYPES
    : name.startsWith("paywall_") ? ["paywall_impression", "paywall_purchase_initiated"]
    : name === "customer_center_survey_responses" ? ["customer_center_survey_option_chosen"] : [];
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  return {
    sdkTypes,
    activity: name === "customers_active" ? range ? { from: iso(range.from), to: iso(range.to + DAY - 1) } : { from: "0000-00-00", to: "9999-99-99" } : null,
    refundRequests: name === "refund_request",
  };
}

/**
 * Loads one project's rows for the charts (packages/core/src/charts): the transaction ledger and subscription states
 * of one environment, customers, lifecycle events, and what `sources` asks for (SDK events, activity days, Apple refund
 * requests), plus a USD → display currency rate per date.
 */
export async function loadChartInput(db: DB, opts: { projectId: string; sandbox: boolean; now: Date; currency: string; fetch?: FxFetch | null; sources: ChartSources }): Promise<ChartInput> {
  const { projectId, sandbox, sources } = opts;
  const env = sandbox ? "sandbox" : "production";
  const T = schema.transactions, S = schema.subscriptions, N = schema.nonSubscriptions, C = schema.customers, E = schema.events, X = schema.sdkEvents, A = schema.customerAliases;
  const CA = schema.customerActivity, SN = schema.storeNotifications, CAT = schema.customerAttribution;
  const [txs, subs, nonSubs, customers, products, lifecycle, sdk, activity, notes] = await Promise.all([
    db.select().from(T).where(and(eq(T.projectId, projectId), eq(T.isSandbox, sandbox))),
    db.select().from(S).where(and(eq(S.projectId, projectId), eq(S.isSandbox, sandbox))),
    db.select({ store: N.store, tx: N.storeTransactionId, offering: N.presentedOfferingId }).from(N).where(and(eq(N.projectId, projectId), eq(N.isSandbox, sandbox))),
    // project_id in the join lets Postgres read only this project's attribution rows (customer_attribution_media index).
    db.select({
      id: C.id, firstSeen: C.firstSeen, lastSeen: C.lastSeen, country: C.lastSeenCountry, platform: C.lastSeenPlatform, appVersion: C.lastSeenAppVersion,
      mediaSource: CAT.mediaSource, campaign: CAT.campaign, adGroup: CAT.adGroup, keyword: CAT.keyword, ad: CAT.ad, creative: CAT.creative,
    }).from(C).leftJoin(CAT, and(eq(CAT.customerId, C.id), eq(CAT.projectId, projectId))).where(eq(C.projectId, projectId)),
    db.select().from(schema.products).where(eq(schema.products.projectId, projectId)),
    db.select({ customerId: E.customerId, type: E.type, at: E.eventTimestampMs, store: sql<string | null>`${E.payload}->'event'->>'store'`, productId: sql<string | null>`${E.payload}->'event'->>'product_id'`, cancelReason: sql<string | null>`${E.payload}->'event'->>'cancel_reason'` }).from(E)
      .where(and(eq(E.projectId, projectId), eq(E.environment, env), inArray(E.type, ["CANCELLATION", "UNCANCELLATION", "BILLING_ISSUE"]))),
    // Only the fields the charts read, with the customer resolved through the alias when the event came before it.
    sources.sdkTypes.length ? db.select({
      customerId: sql<string | null>`coalesce(${X.customerId}, ${A.customerId})`, appId: X.appId, type: X.type, at: X.occurredAt,
      paywallId: sql<string | null>`coalesce(${X.payload}->>'paywall_id', ${X.payload}->'presented_offering_context'->>'paywall_id', ${X.payload}->>'offering_id')`,
      surveyOptionId: sql<string | null>`${X.payload}->>'survey_option_id'`, revenueMicros: sql<string | null>`${X.payload}->>'revenue_micros'`, currency: sql<string | null>`${X.payload}->>'currency'`,
    }).from(X).leftJoin(A, and(eq(A.projectId, X.projectId), eq(A.appUserId, X.appUserId)))
      .where(and(eq(X.projectId, projectId), eq(X.isSandbox, sandbox), inArray(X.type, sources.sdkTypes))) : Promise.resolve([]),
    sources.activity ? db.select({ customerId: CA.customerId, day: CA.day }).from(CA)
      .where(and(eq(CA.projectId, projectId), gte(CA.day, sources.activity.from), lt(CA.day, sources.activity.to))) : Promise.resolve([]),
    sources.refundRequests ? db.select({ type: SN.type, body: SN.body, store: SN.store, appId: SN.appId, receivedAt: SN.receivedAt }).from(SN)
      .where(and(eq(SN.projectId, projectId), eq(SN.environment, env), inArray(SN.type, Object.keys(REFUND_TYPES)), isNull(SN.error))) : Promise.resolve([]),
  ]);

  const currency = opts.currency.toUpperCase();
  if (currency !== "USD" && txs.length) {
    let first = Infinity;
    for (const t of txs) first = Math.min(first, t.purchasedAt.getTime());
    await ensureEcbRange(db, new Date(first), opts.now, opts.fetch);
  }
  const fx = await fxLookup(db);
  const toDisplay = currency === "USD" ? () => 1 : (at: number) => fx.perUsd(currency, at) ?? 1;

  // The offering presented with each purchase: from the subscription chain or the one-time purchase.
  const subOffering = new Map<string, string | null>();
  for (const s of subs) subOffering.set(`${s.customerId}|${s.store}|${s.productIdentifier}`, s.presentedOfferingId);
  const oneOffering = new Map<string, string | null>();
  for (const n of nonSubs) oneOffering.set(`${n.store}|${n.tx}`, n.offering);

  const byTx = new Map<string, (typeof txs)[number]>();
  for (const t of txs) if (t.kind !== "refund" && t.kind !== "refund_reversal") byTx.set(`${t.store}|${t.storeTransactionId}`, t);

  const refundEvents: ChartRefundEvent[] = [];
  for (const n of notes) {
    let body: Record<string, unknown> | null = null;
    try { body = JSON.parse(n.body); } catch { continue; }
    const p = jwsPayload(body?.signedPayload);
    const info = jwsPayload(p?.data?.signedTransactionInfo);
    const id = typeof info?.transactionId === "string" ? info.transactionId : null;
    if (!id) continue;
    const tx = byTx.get(`${n.store}|${id}`);
    refundEvents.push({ transactionId: id, kind: REFUND_TYPES[n.type!]!, at: n.receivedAt.getTime(), appId: n.appId, store: n.store, customerId: tx?.customerId ?? null, usd: tx ? tx.revenueUsd : null, purchasedAt: tx ? tx.purchasedAt.getTime() : null });
  }

  const days = activity.map((a) => ({ customerId: a.customerId, day: Date.parse(`${a.day}T00:00:00Z`) }));
  // Days we know about without an activity row (customers from before migration 0012, imports): first and last seen.
  if (sources.activity) {
    const { from, to } = sources.activity;
    const known = new Set(activity.map((a) => `${a.customerId}|${a.day}`));
    for (const c of customers) for (const d of [c.firstSeen, c.lastSeen]) {
      const day = d.toISOString().slice(0, 10);
      if (day >= from && day < to && !known.has(`${c.id}|${day}`)) { known.add(`${c.id}|${day}`); days.push({ customerId: c.id, day: dayStart(d.getTime()) }); }
    }
  }

  // Each transaction's store commission: program dates per app and Google Play's yearly tier (core commission.ts).
  const firstSeenOf = new Map(customers.map((c) => [c.id, c.firstSeen.getTime()]));
  const rates = commissionRates(txs.map((t) => ({ id: t.id, store: t.store, appId: t.appId, at: t.purchasedAt.getTime(), usd: t.revenueUsd, kind: t.kind, country: t.countryCode, firstSeen: firstSeenOf.get(t.customerId) ?? null })),
    await commissionSettingsOf(db, projectId));
  return {
    now: opts.now.getTime(),
    fx: toDisplay,
    txs: txs.filter((t) => KINDS.has(t.kind as TxKind)).map((t) => ({ commission: rates.get(t.id),
      id: t.id, customerId: t.customerId, appId: t.appId, store: t.store, storeTransactionId: t.storeTransactionId, productId: t.productIdentifier,
      kind: t.kind as TxKind, at: t.purchasedAt.getTime(), expiresAt: t.expiresAt ? t.expiresAt.getTime() : null, usd: t.revenueUsd, country: t.countryCode,
      offering: t.kind === "one_time" || oneOffering.has(`${t.store}|${t.storeTransactionId}`) ? oneOffering.get(`${t.store}|${t.storeTransactionId}`) ?? null : subOffering.get(`${t.customerId}|${t.store}|${t.productIdentifier}`) ?? null,
    })),
    customers: customers.map((c) => ({
      id: c.id, firstSeen: c.firstSeen.getTime(), country: c.country, platform: c.platform, appVersion: c.appVersion,
      attribution: { media_source: c.mediaSource, campaign: c.campaign, ad_group: c.adGroup, keyword: c.keyword, ad: c.ad, creative: c.creative },
    })),
    products: products.map((p) => ({ appId: p.appId, storeIdentifier: p.storeIdentifier, type: p.type, duration: p.duration })),
    subStates: subs.map((s) => ({
      customerId: s.customerId, store: s.store, appId: s.appId, productId: s.productIdentifier, expiresAt: s.expiresDate ? s.expiresDate.getTime() : null,
      autoRenew: !s.unsubscribeDetectedAt, billingIssue: !!s.billingIssuesDetectedAt, graceUntil: s.gracePeriodExpiresDate ? s.gracePeriodExpiresDate.getTime() : null,
      familyShared: s.ownershipType === "FAMILY_SHARED", offering: s.presentedOfferingId, cancelSurveyReason: s.cancelSurveyReason,
      unsubscribeAt: s.unsubscribeDetectedAt ? s.unsubscribeDetectedAt.getTime() : null,
    })),
    lifecycle: lifecycle.flatMap((e): ChartLifecycle[] => {
      // A refund is recorded as CANCELLATION with CUSTOMER_SUPPORT; it is not an opt-out.
      if (!e.customerId || (e.type === "CANCELLATION" && e.cancelReason === "CUSTOMER_SUPPORT")) return [];
      return [{ customerId: e.customerId, store: storeOf(e.store), productId: e.productId ?? "", type: e.type as ChartLifecycle["type"], at: e.at }];
    }),
    sdkEvents: sdk.map((e) => {
      const micros = Number(e.revenueMicros);
      const at = e.at.getTime();
      return {
        customerId: e.customerId, appId: e.appId, type: e.type, at, paywallId: e.paywallId, surveyOptionId: e.surveyOptionId,
        revenueUsd: e.type === "rc_ads_ad_revenue" && e.revenueMicros !== null && Number.isFinite(micros) ? fx.toUsd(micros / 1e6, e.currency || "USD", at) ?? 0 : null,
      };
    }),
    refundEvents,
    activity: days,
  };
}
