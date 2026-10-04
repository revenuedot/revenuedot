import { commissionModel } from "../commission.js";
import { and, asc, eq, gt, inArray, lte, or, sql, type AnyColumn } from "drizzle-orm";
import { commission, splitGross, taxShare, type Store } from "@revenuedot/core";
import { schema, type DB } from "@revenuedot/db";
import { entitlementMap } from "../../repo/catalog.js";
import { baseOrderId } from "../../stores/google/map.js";

/**
 * The five tables a data export can write, read in pages of PAGE rows ordered by a stable key.
 * - transactions: one row per store transaction (purchase, trial, renewal, one-time purchase) with the column names of
 *   RevenueCat's transactions export, so existing warehouse queries keep working. Refunds lower `price_in_usd` to 0 and
 *   set `refunded_at` on the original row instead of adding a negative row.
 * - customers, subscriptions, events: RevenueDot's own tables.
 * - paywall_events: the SDK's paywall events (`sdk_events` rows whose type starts with `paywall_`: impression, close,
 *   cancel, purchase initiated, purchase error, exit offer, component interactions), incremental by when we received them.
 * Incremental windows: rows recorded, refunded or changed after `since` and up to `until`. A full export has no `since`.
 */

export type ColumnType = "string" | "bool" | "int" | "float" | "timestamp" | "json";
export type Value = string | number | boolean | Date | null;
export type Row = Record<string, Value>;
export const EXPORT_TABLES = ["transactions", "customers", "subscriptions", "events", "paywall_events"] as const;
export type ExportTable = (typeof EXPORT_TABLES)[number];

export const COLUMNS: Record<ExportTable, [string, ColumnType][]> = {
  transactions: [
    ["rc_original_app_user_id", "string"], ["rc_last_seen_app_user_id_alias", "string"], ["country", "string"], ["country_source", "string"],
    ["product_identifier", "string"], ["product_display_name", "string"], ["product_duration", "string"], ["start_time", "timestamp"], ["end_time", "timestamp"],
    ["grace_period_end_time", "timestamp"], ["effective_end_time", "timestamp"], ["store", "string"], ["is_auto_renewable", "bool"], ["is_trial_period", "bool"],
    ["is_in_intro_offer_period", "bool"], ["is_sandbox", "bool"], ["price_in_usd", "float"], ["purchase_price_in_usd", "float"], ["takehome_percentage", "float"],
    ["tax_percentage", "float"], ["commission_percentage", "float"], ["store_transaction_id", "string"], ["original_store_transaction_id", "string"],
    ["refunded_at", "timestamp"], ["unsubscribe_detected_at", "timestamp"], ["billing_issues_detected_at", "timestamp"], ["purchased_currency", "string"],
    ["price_in_purchased_currency", "float"], ["purchase_price_in_purchased_currency", "float"], ["entitlement_identifiers", "json"], ["renewal_number", "int"],
    ["is_trial_conversion", "bool"], ["presented_offering", "string"], ["ownership_type", "string"], ["reserved_subscriber_attributes", "json"],
    ["custom_subscriber_attributes", "json"], ["platform", "string"], ["updated_at", "timestamp"], ["offer", "string"], ["offer_type", "string"],
    ["first_seen_time", "timestamp"], ["auto_resume_time", "timestamp"], ["app_id", "string"],
  ],
  customers: [
    ["rc_original_app_user_id", "string"], ["rc_last_seen_app_user_id_alias", "string"], ["aliases", "json"], ["first_seen_time", "timestamp"],
    ["last_seen_time", "timestamp"], ["platform", "string"], ["app_version", "string"], ["country", "string"], ["sdk_version", "string"],
    ["original_purchase_time", "timestamp"], ["reserved_subscriber_attributes", "json"], ["custom_subscriber_attributes", "json"], ["updated_at", "timestamp"],
  ],
  subscriptions: [
    ["rc_original_app_user_id", "string"], ["store", "string"], ["product_identifier", "string"], ["product_plan_identifier", "string"], ["app_id", "string"],
    ["is_sandbox", "bool"], ["period_type", "string"], ["ownership_type", "string"], ["purchase_time", "timestamp"], ["original_purchase_time", "timestamp"],
    ["end_time", "timestamp"], ["grace_period_end_time", "timestamp"], ["unsubscribe_detected_at", "timestamp"], ["billing_issues_detected_at", "timestamp"],
    ["refunded_at", "timestamp"], ["auto_resume_time", "timestamp"], ["cancel_reason", "string"], ["store_transaction_id", "string"],
    ["original_store_transaction_id", "string"], ["price_in_purchased_currency", "float"], ["purchased_currency", "string"], ["price_in_usd", "float"],
    ["country", "string"], ["presented_offering", "string"], ["auto_renew_product_identifier", "string"], ["updated_at", "timestamp"],
  ],
  events: [
    ["event_id", "string"], ["type", "string"], ["event_time", "timestamp"], ["recorded_at", "timestamp"], ["environment", "string"], ["app_id", "string"],
    ["app_user_id", "string"], ["rc_original_app_user_id", "string"], ["product_id", "string"], ["store", "string"], ["price_in_usd", "float"],
    ["currency", "string"], ["price_in_purchased_currency", "float"], ["payload", "json"],
  ],
  paywall_events: [
    ["id", "string"], ["occurred_at", "timestamp"], ["received_at", "timestamp"], ["app_id", "string"], ["app_user_id", "string"], ["customer_id", "string"],
    ["type", "string"], ["is_sandbox", "bool"], ["paywall_id", "string"], ["offering_id", "string"], ["session_id", "string"], ["paywall_revision", "int"],
    ["locale", "string"], ["display_mode", "string"], ["package_id", "string"], ["product_id", "string"], ["payload", "json"],
  ],
};

/**
 * The columns a job writes for a table, in the catalog's order. `selected` is the job's choice for that table; none (or an
 * empty list) means every column, so columns added to the catalog later are included too.
 */
export function columnsFor(table: ExportTable, selected?: string[] | null): [string, ColumnType][] {
  const all = COLUMNS[table];
  if (!selected?.length) return all;
  const want = new Set(selected);
  return all.filter(([n]) => want.has(n));
}

export const PAGE = 2000;

export interface Window { since: Date | null; until: Date; environment: "both" | "production" | "sandbox" }

/**
 * Keyset cursor inside one export: (time, id) of the last row read. `t` is Postgres's own text for the timestamp, so
 * microseconds survive (a JavaScript Date keeps milliseconds only, and rows written by `now()` share sub-millisecond
 * times: reading them back through a Date would repeat rows at every page and loop forever on a big batch).
 */
export interface Cursor { t: string; id: string }

const T = schema.transactions, S = schema.subscriptions, C = schema.customers, A = schema.customerAttributes, AL = schema.customerAliases, E = schema.events;
const PAID = ["purchase", "renewal", "trial", "one_time"];

const inWindow = (col: AnyColumn, w: Window) => (w.since ? and(gt(col, w.since), lte(col, w.until))! : lte(col, w.until));
const after = (time: AnyColumn, id: AnyColumn, c: Cursor | null) => (c ? sql`(${time}, ${id}) > (${c.t}::timestamptz, ${c.id})` : undefined);
/** The exact text of a timestamp column, for the next page's cursor. */
const exact = (col: AnyColumn) => sql<string>`${col}::text`;
const nextCursor = <T extends { k: string }>(rows: T[], id: (r: T) => string): Cursor | null => (rows.length === PAGE ? { t: rows[rows.length - 1]!.k, id: id(rows[rows.length - 1]!) } : null);

async function customerInfo(db: DB, ids: string[]) {
  if (!ids.length) return new Map<string, { c: typeof C.$inferSelect; last: string; aliases: string[]; reserved: Record<string, unknown>; custom: Record<string, unknown>; attrsAt: number }>();
  const [cs, as, als] = await Promise.all([
    db.select().from(C).where(inArray(C.id, ids)),
    db.select().from(A).where(inArray(A.customerId, ids)),
    db.select().from(AL).where(inArray(AL.customerId, ids)).orderBy(asc(AL.createdAt)),
  ]);
  const out = new Map<string, { c: typeof C.$inferSelect; last: string; aliases: string[]; reserved: Record<string, unknown>; custom: Record<string, unknown>; attrsAt: number }>();
  for (const c of cs) out.set(c.id, { c, last: c.originalAppUserId, aliases: [], reserved: {}, custom: {}, attrsAt: 0 });
  for (const a of als) { const o = out.get(a.customerId); if (o) { o.aliases.push(a.appUserId); if (!a.appUserId.startsWith("$RCAnonymousID:")) o.last = a.appUserId; } }
  for (const a of as) {
    const o = out.get(a.customerId);
    if (!o) continue;
    (a.key.startsWith("$") ? o.reserved : o.custom)[a.key] = { value: a.value, updated_at_ms: a.updatedAtMs };
    o.attrsAt = Math.max(o.attrsAt, a.updatedAtMs);
  }
  return out;
}

const envCond = (col: AnyColumn, w: Window) => (w.environment === "both" ? undefined : eq(col, w.environment === "sandbox"));
const maxDate = (...d: (Date | null | undefined)[]) => d.reduce<Date | null>((m, x) => (x && (!m || x > m) ? x : m), null);

/** One page of rows and the cursor for the next page (null when done). */
export async function readPage(db: DB, projectId: string, table: ExportTable, w: Window, cursor: Cursor | null): Promise<{ rows: Row[]; next: Cursor | null }> {
  if (table === "transactions") return transactionsPage(db, projectId, w, cursor);
  if (table === "paywall_events") return paywallEventsPage(db, projectId, w, cursor);
  if (table === "subscriptions") {
    const page = await db.select({ s: S, k: exact(S.updatedAt) }).from(S).where(and(eq(S.projectId, projectId), envCond(S.isSandbox, w), inWindow(S.updatedAt, w), after(S.updatedAt, S.id, cursor)))
      .orderBy(asc(S.updatedAt), asc(S.id)).limit(PAGE);
    const rows = page.map((r) => r.s);
    const info = await customerInfo(db, [...new Set(rows.map((r) => r.customerId))]);
    return {
      rows: rows.map((s) => ({
        rc_original_app_user_id: info.get(s.customerId)?.c.originalAppUserId ?? null, store: s.store, product_identifier: s.productIdentifier, product_plan_identifier: s.productPlanIdentifier,
        app_id: s.appId, is_sandbox: s.isSandbox, period_type: s.periodType, ownership_type: s.ownershipType, purchase_time: s.purchaseDate, original_purchase_time: s.originalPurchaseDate,
        end_time: s.expiresDate, grace_period_end_time: s.gracePeriodExpiresDate, unsubscribe_detected_at: s.unsubscribeDetectedAt, billing_issues_detected_at: s.billingIssuesDetectedAt,
        refunded_at: s.refundedAt, auto_resume_time: s.autoResumeDate, cancel_reason: s.cancelReason, store_transaction_id: s.storeTransactionId,
        original_store_transaction_id: s.originalTransactionId ?? s.storeKey, price_in_purchased_currency: s.priceAmount, purchased_currency: s.priceCurrency, price_in_usd: s.priceUsd,
        country: s.countryCode, presented_offering: s.presentedOfferingId, auto_renew_product_identifier: s.autoRenewProductId, updated_at: s.updatedAt,
      })),
      next: nextCursor(page, (r) => r.s.id),
    };
  }
  if (table === "events") {
    const envE = w.environment === "both" ? undefined : eq(E.environment, w.environment);
    const page = await db.select({ e: E, k: exact(E.createdAt) }).from(E).where(and(eq(E.projectId, projectId), envE, inWindow(E.createdAt, w), after(E.createdAt, E.id, cursor)))
      .orderBy(asc(E.createdAt), asc(E.id)).limit(PAGE);
    return {
      rows: page.map(({ e }) => {
        const ev = ((e.payload as { event?: Record<string, any> }).event ?? {}) as Record<string, any>;
        return {
          event_id: e.id, type: e.type, event_time: new Date(e.eventTimestampMs), recorded_at: e.createdAt, environment: e.environment, app_id: e.appId,
          app_user_id: ev.app_user_id ?? null, rc_original_app_user_id: ev.original_app_user_id ?? null, product_id: ev.product_id ?? null, store: ev.store ?? null,
          price_in_usd: typeof ev.price === "number" ? ev.price : null, currency: ev.currency ?? null,
          price_in_purchased_currency: typeof ev.price_in_purchased_currency === "number" ? ev.price_in_purchased_currency : null, payload: JSON.stringify(ev),
        };
      }),
      next: nextCursor(page, (r) => r.e.id),
    };
  }
  // customers: new, seen, or with attributes changed in the window. The keyset is first_seen + id.
  const attrChanged = w.since
    ? sql`exists (select 1 from ${A} where ${A.customerId} = ${C.id} and ${A.updatedAtMs} > ${w.since.getTime()} and ${A.updatedAtMs} <= ${w.until.getTime()})`
    : undefined;
  const windowCond = w.since ? or(inWindow(C.firstSeen, w), inWindow(C.lastSeen, w), attrChanged) : lte(C.firstSeen, w.until);
  const sandboxCond = w.environment === "both" ? undefined
    : sql`exists (select 1 from ${T} where ${T.customerId} = ${C.id} and ${T.isSandbox} = ${w.environment === "sandbox"})`;
  const page = await db.select({ c: C, k: exact(C.firstSeen) }).from(C).where(and(eq(C.projectId, projectId), windowCond, sandboxCond, after(C.firstSeen, C.id, cursor)))
    .orderBy(asc(C.firstSeen), asc(C.id)).limit(PAGE);
  const rows = page.map((r) => r.c);
  const info = await customerInfo(db, rows.map((r) => r.id));
  return {
    rows: rows.map((c) => {
      const i = info.get(c.id)!;
      return {
        rc_original_app_user_id: c.originalAppUserId, rc_last_seen_app_user_id_alias: i.last, aliases: JSON.stringify(i.aliases), first_seen_time: c.firstSeen,
        last_seen_time: c.lastSeen, platform: c.lastSeenPlatform, app_version: c.lastSeenAppVersion, country: c.lastSeenCountry, sdk_version: c.lastSeenSdkVersion,
        original_purchase_time: c.originalPurchaseDate, reserved_subscriber_attributes: JSON.stringify(i.reserved), custom_subscriber_attributes: JSON.stringify(i.custom),
        updated_at: maxDate(c.lastSeen, i.attrsAt ? new Date(i.attrsAt) : null),
      };
    }),
    next: nextCursor(page, (r) => r.c.id),
  };
}

async function transactionsPage(db: DB, projectId: string, w: Window, cursor: Cursor | null) {
  const R = schema.transactions;
  // A transaction is in the window when it was recorded, refunded (or the refund reversed), or its subscription changed then.
  const changed = w.since ? or(
    inWindow(T.createdAt, w),
    sql`exists (select 1 from ${R} r where r.project_id = ${T.projectId} and r.store = ${T.store} and r.store_transaction_id = ${T.storeTransactionId}
      and r.kind in ('refund', 'refund_reversal') and r.created_at > ${w.since.toISOString()}::timestamptz and r.created_at <= ${w.until.toISOString()}::timestamptz)`,
    sql`exists (select 1 from ${S} s where s.project_id = ${T.projectId} and s.store = ${T.store} and s.store_transaction_id = ${T.storeTransactionId}
      and s.updated_at > ${w.since.toISOString()}::timestamptz and s.updated_at <= ${w.until.toISOString()}::timestamptz)`,
  ) : undefined;
  const page = await db.select({ t: T, k: exact(T.createdAt) }).from(T).where(and(eq(T.projectId, projectId), inArray(T.kind, PAID), envCond(T.isSandbox, w), lte(T.createdAt, w.until), changed, after(T.createdAt, T.id, cursor)))
    .orderBy(asc(T.createdAt), asc(T.id)).limit(PAGE);
  const rows = page.map((r) => r.t);
  if (!rows.length) return { rows: [], next: null };
  const customerIds = [...new Set(rows.map((r) => r.customerId))];
  const [info, subs, chainTx, products, ents] = await Promise.all([
    customerInfo(db, customerIds),
    db.select().from(S).where(inArray(S.customerId, customerIds)),
    db.select().from(T).where(and(eq(T.projectId, projectId), inArray(T.customerId, customerIds))),
    db.select().from(schema.products).where(eq(schema.products.projectId, projectId)),
    entitlementMap(db, projectId),
  ]);
  const productOf = new Map(products.map((p) => [`${p.appId}|${p.storeIdentifier}`, p]));
  const productAny = new Map(products.map((p) => [p.storeIdentifier, p]));
  const refunds = new Map<string, Date>(), reversals = new Map<string, Date>();
  for (const t of chainTx) {
    const k = `${t.store}|${t.storeTransactionId}`;
    if (t.kind === "refund") refunds.set(k, t.purchasedAt);
    if (t.kind === "refund_reversal") reversals.set(k, t.createdAt);
  }
  const subFor = (t: typeof T.$inferSelect) => {
    const mine = subs.filter((s) => s.customerId === t.customerId && s.store === t.store);
    if (t.store === "play_store") return mine.find((s) => baseOrderId(s.originalTransactionId ?? s.storeTransactionId ?? s.storeKey) === baseOrderId(t.storeTransactionId)) ?? null;
    const exact = mine.find((s) => s.storeTransactionId === t.storeTransactionId || s.storeKey === t.storeTransactionId || s.originalTransactionId === t.storeTransactionId);
    if (exact) return exact;
    return mine.filter((s) => (s.productIdentifier === t.productIdentifier || s.autoRenewProductId === t.productIdentifier) && s.originalPurchaseDate <= t.purchasedAt)
      .sort((a, b) => b.originalPurchaseDate.getTime() - a.originalPurchaseDate.getTime())[0] ?? null;
  };
  /** Chain key → the chain's paid transactions in time order, for renewal_number and is_trial_conversion. */
  const chains = new Map<string, (typeof T.$inferSelect)[]>();
  const chainKey = (t: typeof T.$inferSelect) => {
    if (t.store === "play_store") return `${t.customerId}|g|${baseOrderId(t.storeTransactionId)}`;
    const s = subFor(t);
    return s ? `${t.customerId}|s|${s.id}` : `${t.customerId}|t|${t.storeTransactionId}`;
  };
  for (const t of chainTx) {
    if (!PAID.includes(t.kind)) continue;
    const k = chainKey(t);
    (chains.get(k) ?? chains.set(k, []).get(k)!).push(t);
  }
  for (const list of chains.values()) list.sort((a, b) => a.purchasedAt.getTime() - b.purchasedAt.getTime());

  const cm = await commissionModel(db, projectId);
  const out: Row[] = rows.map((t) => {
    const i = info.get(t.customerId);
    const s = t.kind === "one_time" ? null : subFor(t);
    const current = !!s && (s.storeTransactionId ?? s.storeKey) === t.storeTransactionId;
    const key = `${t.store}|${t.storeTransactionId}`;
    const refundedAt = refunds.has(key) && !reversals.has(key) ? refunds.get(key)! : current && s?.refundedAt ? s.refundedAt : null;
    const product = (t.appId ? productOf.get(`${t.appId}|${t.productIdentifier}`) : undefined) ?? productAny.get(t.productIdentifier);
    const chain = chains.get(chainKey(t)) ?? [t];
    const idx = Math.max(0, chain.findIndex((x) => x.id === t.id));
    const comm = cm.rate({ id: t.id, store: t.store, appId: t.appId, at: t.purchasedAt, kind: t.kind, isSandbox: t.isSandbox, country: t.countryCode, firstSeen: i?.c.firstSeen ?? null });
    const usd = t.revenueUsd;
    const split = splitGross(1, taxShare({ store: t.store, country: t.countryCode, taxAmount: t.taxAmount, priceAmount: t.priceAmount }), comm);
    const grace = current && s?.gracePeriodExpiresDate && t.expiresAt && s.gracePeriodExpiresDate > t.expiresAt ? s.gracePeriodExpiresDate : null;
    const auto = t.kind !== "one_time" && (product ? product.type === "subscription" : !!t.expiresAt);
    return {
      rc_original_app_user_id: i?.c.originalAppUserId ?? null, rc_last_seen_app_user_id_alias: i?.last ?? null,
      country: t.countryCode ?? i?.c.lastSeenCountry ?? null, country_source: t.countryCode ? "from_sdk" : i?.c.lastSeenCountry ? "estimated" : null,
      product_identifier: t.productIdentifier, product_display_name: product?.displayName ?? null, product_duration: product?.duration ?? null,
      start_time: t.purchasedAt, end_time: auto ? t.expiresAt : null, grace_period_end_time: grace, effective_end_time: refundedAt ?? grace ?? t.expiresAt,
      store: t.store, is_auto_renewable: auto, is_trial_period: t.kind === "trial", is_in_intro_offer_period: current && s?.periodType === "intro", is_sandbox: t.isSandbox,
      price_in_usd: refundedAt ? 0 : usd, purchase_price_in_usd: usd, takehome_percentage: split.proceeds, tax_percentage: split.taxPercentage, commission_percentage: split.commissionPercentage,
      store_transaction_id: t.storeTransactionId,
      original_store_transaction_id: t.store === "play_store" ? baseOrderId(t.storeTransactionId) : s?.originalTransactionId ?? s?.storeKey ?? t.storeTransactionId,
      refunded_at: refundedAt, unsubscribe_detected_at: current ? s?.unsubscribeDetectedAt ?? null : null, billing_issues_detected_at: current ? s?.billingIssuesDetectedAt ?? null : null,
      purchased_currency: t.priceCurrency, price_in_purchased_currency: refundedAt ? 0 : t.priceAmount, purchase_price_in_purchased_currency: t.priceAmount,
      entitlement_identifiers: JSON.stringify(Object.entries(ents).filter(([, p]) => p.includes(t.productIdentifier)).map(([k]) => k)),
      renewal_number: idx + 1, is_trial_conversion: t.kind === "renewal" && idx > 0 && chain[idx - 1]!.kind === "trial",
      presented_offering: s?.presentedOfferingId ?? null, ownership_type: s?.ownershipType ?? "PURCHASED",
      reserved_subscriber_attributes: JSON.stringify(i?.reserved ?? {}), custom_subscriber_attributes: JSON.stringify(i?.custom ?? {}),
      platform: i?.c.lastSeenPlatform ?? null,
      updated_at: maxDate(t.createdAt, refunds.has(key) ? refunds.get(key) : null, reversals.get(key), current ? s?.updatedAt : null),
      offer: t.offerId ?? null, offer_type: t.offerType ?? null, first_seen_time: i?.c.firstSeen ?? null, auto_resume_time: current ? s?.autoResumeDate ?? null : null, app_id: t.appId,
    };
  });
  return { rows: out, next: nextCursor(page, (r) => r.t.id) };
}

const str = (v: unknown) => (typeof v === "string" && v ? v : null);

async function paywallEventsPage(db: DB, projectId: string, w: Window, cursor: Cursor | null) {
  const X = schema.sdkEvents;
  const envX = w.environment === "both" ? undefined : eq(X.isSandbox, w.environment === "sandbox");
  // The customer comes through the alias when the event arrived before the customer existed.
  const page = await db.select({ x: X, k: exact(X.receivedAt), aliasCustomer: AL.customerId }).from(X)
    .leftJoin(AL, and(eq(AL.projectId, X.projectId), eq(AL.appUserId, X.appUserId)))
    .where(and(eq(X.projectId, projectId), sql`${X.type} like 'paywall\\_%'`, envX, inWindow(X.receivedAt, w), after(X.receivedAt, X.id, cursor)))
    .orderBy(asc(X.receivedAt), asc(X.id)).limit(PAGE);
  return {
    rows: page.map(({ x, aliasCustomer }) => {
      const p = x.payload as Record<string, unknown>;
      const ctx = (p.presented_offering_context && typeof p.presented_offering_context === "object" ? p.presented_offering_context : {}) as Record<string, unknown>;
      const rev = Number(p.paywall_revision);
      return {
        id: x.id, occurred_at: x.occurredAt, received_at: x.receivedAt, app_id: x.appId, app_user_id: x.appUserId, customer_id: x.customerId ?? aliasCustomer ?? null,
        type: x.type, is_sandbox: x.isSandbox, paywall_id: str(p.paywall_id) ?? str(ctx.paywall_id), offering_id: str(p.offering_id) ?? str(ctx.offering_identifier),
        session_id: str(p.session_id), paywall_revision: p.paywall_revision !== undefined && p.paywall_revision !== null && Number.isFinite(rev) ? Math.trunc(rev) : null,
        locale: str(p.locale), display_mode: str(p.display_mode), package_id: str(p.package_id), product_id: str(p.product_id), payload: JSON.stringify(p),
      };
    }),
    next: nextCursor(page, (r) => r.x.id),
  };
}
