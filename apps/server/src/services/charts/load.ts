import { and, eq, inArray, isNull } from "drizzle-orm";
import type { ChartInput, ChartLifecycle, ChartRefundEvent, TxKind } from "@revenuedot/core";
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

/**
 * Loads one project's rows for the charts (packages/core/src/charts): the transaction ledger and subscription states
 * of one environment, customers and their activity days, lifecycle events, SDK events and Apple refund requests,
 * plus a USD → display currency rate per date.
 */
export async function loadChartInput(db: DB, opts: { projectId: string; sandbox: boolean; now: Date; currency: string; fetch?: FxFetch | null }): Promise<ChartInput> {
  const { projectId, sandbox } = opts;
  const env = sandbox ? "sandbox" : "production";
  const T = schema.transactions, S = schema.subscriptions, N = schema.nonSubscriptions, C = schema.customers, E = schema.events, X = schema.sdkEvents;
  const [txs, subs, nonSubs, customers, products, lifecycle, sdk, activity, notes, aliases] = await Promise.all([
    db.select().from(T).where(and(eq(T.projectId, projectId), eq(T.isSandbox, sandbox))),
    db.select().from(S).where(and(eq(S.projectId, projectId), eq(S.isSandbox, sandbox))),
    db.select({ store: N.store, tx: N.storeTransactionId, offering: N.presentedOfferingId }).from(N).where(and(eq(N.projectId, projectId), eq(N.isSandbox, sandbox))),
    db.select({ id: C.id, firstSeen: C.firstSeen, lastSeen: C.lastSeen, country: C.lastSeenCountry, platform: C.lastSeenPlatform, appVersion: C.lastSeenAppVersion }).from(C).where(eq(C.projectId, projectId)),
    db.select().from(schema.products).where(eq(schema.products.projectId, projectId)),
    db.select({ customerId: E.customerId, type: E.type, at: E.eventTimestampMs, payload: E.payload }).from(E)
      .where(and(eq(E.projectId, projectId), eq(E.environment, env), inArray(E.type, ["CANCELLATION", "UNCANCELLATION", "BILLING_ISSUE"]))),
    db.select().from(X).where(and(eq(X.projectId, projectId), eq(X.isSandbox, sandbox))),
    db.select().from(schema.customerActivity).where(eq(schema.customerActivity.projectId, projectId)),
    db.select().from(schema.storeNotifications).where(and(eq(schema.storeNotifications.projectId, projectId), eq(schema.storeNotifications.environment, env),
      inArray(schema.storeNotifications.type, Object.keys(REFUND_TYPES)), isNull(schema.storeNotifications.error))),
    db.select({ appUserId: schema.customerAliases.appUserId, customerId: schema.customerAliases.customerId }).from(schema.customerAliases).where(eq(schema.customerAliases.projectId, projectId)),
  ]);

  const currency = opts.currency.toUpperCase();
  if (currency !== "USD" && txs.length) {
    const first = Math.min(...txs.map((t) => t.purchasedAt.getTime()));
    await ensureEcbRange(db, new Date(first), opts.now, opts.fetch);
  }
  const fx = await fxLookup(db);
  const toDisplay = currency === "USD" ? () => 1 : (at: number) => fx.perUsd(currency, at) ?? 1;

  // The offering presented with each purchase: from the subscription chain or the one-time purchase.
  const subOffering = new Map<string, string | null>();
  for (const s of subs) subOffering.set(`${s.customerId}|${s.store}|${s.productIdentifier}`, s.presentedOfferingId);
  const oneOffering = new Map<string, string | null>();
  for (const n of nonSubs) oneOffering.set(`${n.store}|${n.tx}`, n.offering);
  const aliasOf = new Map(aliases.map((a) => [a.appUserId, a.customerId]));

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
    refundEvents.push({ transactionId: id, kind: REFUND_TYPES[n.type!]!, at: n.receivedAt.getTime(), appId: n.appId, store: n.store, customerId: tx?.customerId ?? null, usd: tx ? tx.revenueUsd : null });
  }

  const days = activity.map((a) => ({ customerId: a.customerId, day: Date.parse(`${a.day}T00:00:00Z`) }));
  // Days we know about without an activity row (customers from before migration 0012, imports): first and last seen.
  const known = new Set(activity.map((a) => `${a.customerId}|${a.day}`));
  for (const c of customers) for (const d of [c.firstSeen, c.lastSeen]) {
    const day = d.toISOString().slice(0, 10);
    if (!known.has(`${c.id}|${day}`)) { known.add(`${c.id}|${day}`); days.push({ customerId: c.id, day: dayStart(d.getTime()) }); }
  }

  return {
    now: opts.now.getTime(),
    fx: toDisplay,
    txs: txs.filter((t) => KINDS.has(t.kind as TxKind)).map((t) => ({
      id: t.id, customerId: t.customerId, appId: t.appId, store: t.store, storeTransactionId: t.storeTransactionId, productId: t.productIdentifier,
      kind: t.kind as TxKind, at: t.purchasedAt.getTime(), expiresAt: t.expiresAt ? t.expiresAt.getTime() : null, usd: t.revenueUsd, country: t.countryCode,
      offering: t.kind === "one_time" || oneOffering.has(`${t.store}|${t.storeTransactionId}`) ? oneOffering.get(`${t.store}|${t.storeTransactionId}`) ?? null : subOffering.get(`${t.customerId}|${t.store}|${t.productIdentifier}`) ?? null,
    })),
    customers: customers.map((c) => ({ id: c.id, firstSeen: c.firstSeen.getTime(), country: c.country, platform: c.platform, appVersion: c.appVersion })),
    products: products.map((p) => ({ appId: p.appId, storeIdentifier: p.storeIdentifier, type: p.type, duration: p.duration })),
    subStates: subs.map((s) => ({
      customerId: s.customerId, store: s.store, appId: s.appId, productId: s.productIdentifier, expiresAt: s.expiresDate ? s.expiresDate.getTime() : null,
      autoRenew: !s.unsubscribeDetectedAt, billingIssue: !!s.billingIssuesDetectedAt, graceUntil: s.gracePeriodExpiresDate ? s.gracePeriodExpiresDate.getTime() : null,
      familyShared: s.ownershipType === "FAMILY_SHARED", offering: s.presentedOfferingId, cancelSurveyReason: s.cancelSurveyReason,
      unsubscribeAt: s.unsubscribeDetectedAt ? s.unsubscribeDetectedAt.getTime() : null,
    })),
    lifecycle: lifecycle.flatMap((e): ChartLifecycle[] => {
      const ev = (e.payload as { event?: Record<string, unknown> }).event ?? {};
      // A refund is recorded as CANCELLATION with CUSTOMER_SUPPORT; it is not an opt-out.
      if (!e.customerId || (e.type === "CANCELLATION" && ev.cancel_reason === "CUSTOMER_SUPPORT")) return [];
      return [{ customerId: e.customerId, store: storeOf(ev.store), productId: String(ev.product_id ?? ""), type: e.type as ChartLifecycle["type"], at: e.at }];
    }),
    sdkEvents: sdk.map((e) => {
      const p = e.payload as Record<string, any>;
      const micros = Number(p.revenue_micros);
      const cur = typeof p.currency === "string" ? p.currency : "USD";
      const at = e.occurredAt.getTime();
      return {
        customerId: e.customerId ?? (e.appUserId ? aliasOf.get(e.appUserId) ?? null : null), appId: e.appId, type: e.type, at,
        sessionId: p.session_id ?? p.app_session_id ?? null, paywallId: p.paywall_id ?? p.presented_offering_context?.paywall_id ?? p.offering_id ?? null,
        surveyOptionId: p.survey_option_id ?? null,
        revenueUsd: e.type === "rc_ads_ad_revenue" && Number.isFinite(micros) ? fx.toUsd(micros / 1e6, cur, at) ?? 0 : null,
      };
    }),
    refundEvents,
    activity: days,
  };
}
