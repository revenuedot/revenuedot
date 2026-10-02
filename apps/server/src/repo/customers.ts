import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { ATTRIBUTION_KEYS, isAnonymous, isAttributionKey, newId, type CustomerState, type NonSubscription, type Subscription } from "@revenuedot/core";
import { schema, type DB } from "@revenuedot/db";
import { accessOf } from "./access.js";
import { syncCustomerAttribution } from "./attribution.js";

const { customers, customerAliases, customerAttributes, subscriptions, nonSubscriptions } = schema;
export type CustomerRow = typeof customers.$inferSelect;

export async function findCustomer(db: DB, projectId: string, appUserId: string): Promise<CustomerRow | null> {
  const [row] = await db.select({ c: customers }).from(customerAliases)
    .innerJoin(customers, eq(customers.id, customerAliases.customerId))
    .where(and(eq(customerAliases.projectId, projectId), eq(customerAliases.appUserId, appUserId))).limit(1);
  return row?.c ?? null;
}

/** Returns the customer for an app user id, creating it (first seen now) if it does not exist. */
export async function getOrCreateCustomer(db: DB, projectId: string, appUserId: string, now: Date): Promise<{ customer: CustomerRow; created: boolean }> {
  const found = await findCustomer(db, projectId, appUserId);
  if (found) return { customer: found, created: false };
  const id = newId("cus_", 16);
  const [customer] = await db.insert(customers).values({ id, projectId, originalAppUserId: appUserId, firstSeen: now, lastSeen: now }).returning();
  await db.insert(customerAliases).values({ projectId, appUserId, customerId: id }).onConflictDoNothing();
  const again = await findCustomer(db, projectId, appUserId);
  return { customer: again ?? customer!, created: !!again && again.id === id };
}

export async function aliasesOf(db: DB, customerId: string): Promise<string[]> {
  const rows = await db.select({ a: customerAliases.appUserId }).from(customerAliases).where(eq(customerAliases.customerId, customerId));
  return rows.map((r) => r.a);
}

/** What the SDK's request headers say about the device, app build and SDK (all optional). */
export interface SeenInfo {
  appVersion?: string | null; platform?: string | null; country?: string | null;
  sdkVersion?: string | null; sdkFlavor?: string | null; platformVersion?: string | null; appBuild?: string | null;
}

export async function touch(db: DB, customerId: string, now: Date, info: SeenInfo = {}) {
  await db.update(customers).set({
    lastSeen: now,
    ...(info.appVersion ? { lastSeenAppVersion: info.appVersion } : {}),
    ...(info.platform ? { lastSeenPlatform: info.platform } : {}),
    ...(info.country ? { lastSeenCountry: info.country } : {}),
    ...(info.sdkVersion ? { lastSeenSdkVersion: info.sdkVersion } : {}),
    ...(info.sdkFlavor ? { lastSeenSdkFlavor: info.sdkFlavor } : {}),
    ...(info.platformVersion ? { lastSeenPlatformVersion: info.platformVersion } : {}),
    ...(info.appBuild ? { lastSeenAppBuild: info.appBuild } : {}),
  }).where(eq(customers.id, customerId));
  await recordActivity(db, customerId, now);
}

/**
 * Records that the customer used the app on this UTC day (the Active Customers chart). Repeats are no-ops. Chart
 * bookkeeping never fails the SDK request it rides on (a customer deleted meanwhile, a lost connection).
 */
export async function recordActivity(db: DB, customerId: string, now: Date) {
  const day = now.toISOString().slice(0, 10);
  try {
    await db.execute(sql`INSERT INTO customer_activity (project_id, customer_id, day) SELECT project_id, id, ${day} FROM customers WHERE id = ${customerId} ON CONFLICT DO NOTHING`);
  } catch (e) { console.warn("Recording customer activity failed", e); }
}

/**
 * A customer created by a purchase of an older transaction (a restore on a new install, a server-side import, a store
 * notification for a purchase we had not seen) was first seen when that purchase was made, not when we heard of it.
 */
export async function backdateFirstSeen(db: DB, customerId: string, earliest: Date) {
  await db.update(customers).set({ firstSeen: earliest }).where(and(eq(customers.id, customerId), sql`${customers.firstSeen} > ${earliest.toISOString()}::timestamptz`));
}

const WRITE_ONCE = new Set<string>(ATTRIBUTION_KEYS);

/**
 * Upserts attributes; a newer `updated_at_ms` wins. Empty string or null deletes the value (iOS sends "", Android null).
 * `attributionOnce` (the SDK endpoints): attribution attributes ($mediaSource, $campaign … $appleAds*) are write-once,
 * as RevenueCat documents ("Once attribution data is set for a subscriber, it can't be changed"), so a reinstall or a
 * partner resending conversion data never overwrites the original install's attribution. The REST API v2 (a developer
 * with a secret key, the dashboard) can still correct or clear them.
 */
export async function setAttributes(db: DB, customerId: string, attrs: Record<string, { value: unknown; updated_at_ms?: number }>, now: Date, o: { attributionOnce?: boolean } = {}) {
  let attribution = false;
  for (const [key, raw] of Object.entries(attrs ?? {})) {
    const value = raw?.value === null || raw?.value === undefined || raw.value === "" ? null : String(raw.value);
    const updatedAtMs = Number(raw?.updated_at_ms ?? now.getTime());
    // One upsert, newest timestamp wins: a read-then-insert let two concurrent writes of a new key (the SDK's attribute
    // sync next to a receipt carrying attributes) collide on the primary key on Postgres and answer 500.
    // Write-once attribution (SDK): a stored value is kept unless it is empty or the same.
    const once = o.attributionOnce && WRITE_ONCE.has(key);
    await db.insert(customerAttributes).values({ customerId, key, value, updatedAtMs }).onConflictDoUpdate({
      target: [customerAttributes.customerId, customerAttributes.key], set: { value, updatedAtMs },
      setWhere: once
        ? sql`${customerAttributes.updatedAtMs} <= ${updatedAtMs} and (${customerAttributes.value} is null or ${customerAttributes.value} = ${value})`
        : sql`${customerAttributes.updatedAtMs} <= ${updatedAtMs}`,
    });
    if (isAttributionKey(key)) attribution = true;
  }
  // Attribution attributes also live as one first-class row (prd/attribution-benchmarks-insights §1).
  if (attribution) await syncCustomerAttribution(db, customerId, now);
}

export function subRowToDomain(r: typeof subscriptions.$inferSelect): Subscription {
  return {
    productIdentifier: r.productIdentifier, productPlanIdentifier: r.productPlanIdentifier, store: r.store as Subscription["store"],
    isSandbox: r.isSandbox, purchaseDate: r.purchaseDate, originalPurchaseDate: r.originalPurchaseDate, expiresDate: r.expiresDate,
    periodType: r.periodType as Subscription["periodType"], ownershipType: r.ownershipType as Subscription["ownershipType"],
    unsubscribeDetectedAt: r.unsubscribeDetectedAt, billingIssuesDetectedAt: r.billingIssuesDetectedAt,
    gracePeriodExpiresDate: r.gracePeriodExpiresDate, refundedAt: r.refundedAt, autoResumeDate: r.autoResumeDate,
    storeTransactionId: r.storeTransactionId, originalTransactionId: r.originalTransactionId,
    price: r.priceAmount !== null && r.priceCurrency ? { amount: r.priceAmount, currency: r.priceCurrency } : null,
    entitlementIdentifier: r.entitlementIdentifier, autoRenewProductId: r.autoRenewProductId,
    cancelReason: r.cancelReason as Subscription["cancelReason"], priceIncreaseStatus: r.priceIncreaseStatus as Subscription["priceIncreaseStatus"],
  };
}

export function nonSubRowToDomain(r: typeof nonSubscriptions.$inferSelect): NonSubscription {
  return {
    id: r.id, productIdentifier: r.productIdentifier, store: r.store as NonSubscription["store"], isSandbox: r.isSandbox,
    purchaseDate: r.purchaseDate, storeTransactionId: r.storeTransactionId, isConsumable: r.isConsumable, refundedAt: r.refundedAt,
    price: r.priceAmount !== null && r.priceCurrency ? { amount: r.priceAmount, currency: r.priceCurrency } : null,
  };
}

/**
 * Everything customer info is built from. With `recoveryBase` (the API origin), a customer with an open payment recovery
 * case gets `management_url` (top level and on that subscription): the case's Customer Center link, which the SDKs'
 * Customer Center opens from "Manage subscription" (prd/payment-recovery/PRD.md). Otherwise it stays null.
 */
export async function loadState(db: DB, customer: CustomerRow, opts: { recoveryBase?: string } = {}): Promise<CustomerState> {
  const [subs, ones, attrs, access, cases] = await Promise.all([
    db.select().from(subscriptions).where(eq(subscriptions.customerId, customer.id)),
    db.select().from(nonSubscriptions).where(eq(nonSubscriptions.customerId, customer.id)),
    db.select().from(customerAttributes).where(eq(customerAttributes.customerId, customer.id)),
    accessOf(db, customer),
    opts.recoveryBase ? db.select({ subscriptionId: schema.recoveryCases.subscriptionId, token: schema.recoveryCases.centerToken }).from(schema.recoveryCases)
      .where(and(eq(schema.recoveryCases.customerId, customer.id), eq(schema.recoveryCases.status, "open"))).orderBy(desc(schema.recoveryCases.detectedAt)) : Promise.resolve([]),
  ]);
  const attributes: CustomerState["attributes"] = {};
  for (const a of attrs) attributes[a.key] = { value: a.value, updatedAtMs: a.updatedAtMs };
  // The Customer Center token, never the emailed one: for web purchases it only offers to email a one-time link.
  const link = (token: string) => `${opts.recoveryBase}/v1/recovery/c/${token}`;
  const bySub = new Map(cases.filter((x) => x.subscriptionId).map((x) => [x.subscriptionId!, x.token]));
  return {
    originalAppUserId: customer.originalAppUserId, firstSeen: customer.firstSeen, lastSeen: customer.lastSeen,
    originalApplicationVersion: customer.originalApplicationVersion, originalPurchaseDate: customer.originalPurchaseDate,
    subscriptions: subs.map((r) => { const d = subRowToDomain(r); const t = bySub.get(r.id); return t ? { ...d, managementUrl: link(t) } : d; }),
    nonSubscriptions: ones.map(nonSubRowToDomain), attributes, access,
    ...(cases.length ? { managementUrl: link(cases[0]!.token) } : {}),
  };
}

/**
 * Moves everything from `from` into `into` (aliases, purchases, attributes that `into` lacks, in-app currency, support
 * tickets, refund requests, win-back emails) and deletes `from`.
 */
export async function mergeCustomers(db: DB, fromId: string, intoId: string) {
  if (fromId === intoId) return;
  // One transaction: a merge that stops halfway would leave balances added to `into` that a retry adds again.
  await db.transaction(async (tx) => mergeInto(tx as unknown as DB, fromId, intoId));
}

async function mergeInto(db: DB, fromId: string, intoId: string) {
  await mergeCurrency(db, fromId, intoId);
  await db.update(schema.supportTickets).set({ customerId: intoId }).where(eq(schema.supportTickets.customerId, fromId));
  await db.update(schema.refundRequests).set({ customerId: intoId }).where(eq(schema.refundRequests.customerId, fromId));
  await db.update(schema.recoveryCases).set({ customerId: intoId }).where(eq(schema.recoveryCases.customerId, fromId));
  await db.update(schema.adRewardVerifications).set({ customerId: intoId }).where(eq(schema.adRewardVerifications.customerId, fromId));
  await db.execute(sql`UPDATE winback_sends SET customer_id = ${intoId} WHERE customer_id = ${fromId}
    AND campaign_id NOT IN (SELECT campaign_id FROM winback_sends WHERE customer_id = ${intoId})`);
  await db.update(customerAliases).set({ customerId: intoId }).where(eq(customerAliases.customerId, fromId));
  await db.update(subscriptions).set({ customerId: intoId }).where(eq(subscriptions.customerId, fromId));
  await db.update(nonSubscriptions).set({ customerId: intoId }).where(eq(nonSubscriptions.customerId, fromId));
  await db.update(schema.transactions).set({ customerId: intoId }).where(eq(schema.transactions.customerId, fromId));
  await db.update(schema.events).set({ customerId: intoId }).where(eq(schema.events.customerId, fromId));
  await db.update(schema.sdkEvents).set({ customerId: intoId }).where(eq(schema.sdkEvents.customerId, fromId));
  await db.execute(sql`INSERT INTO customer_activity (project_id, customer_id, day) SELECT project_id, ${intoId}, day FROM customer_activity WHERE customer_id = ${fromId} ON CONFLICT DO NOTHING`);
  const intoAttrs = await db.select({ key: customerAttributes.key }).from(customerAttributes).where(eq(customerAttributes.customerId, intoId));
  const have = new Set(intoAttrs.map((a) => a.key));
  const fromAttrs = await db.select().from(customerAttributes).where(eq(customerAttributes.customerId, fromId));
  for (const a of fromAttrs) if (!have.has(a.key)) await db.insert(customerAttributes).values({ ...a, customerId: intoId }).onConflictDoNothing();
  await db.delete(customers).where(eq(customers.id, fromId));
  if (fromAttrs.some((a) => isAttributionKey(a.key) && !have.has(a.key))) await syncCustomerAttribution(db, intoId);
}

/**
 * In-app currency follows the customer: balances are summed and ledger rows move. A ledger row whose source key the
 * surviving customer already has (the same store transaction granted to both, or the same Idempotency-Key) stays behind
 * and its amount is not added again, so a grant is never counted twice.
 */
async function mergeCurrency(db: DB, fromId: string, intoId: string) {
  const vct = schema.virtualCurrencyTransactions, vcb = schema.virtualCurrencyBalances;
  const fromRows = await db.select().from(vct).where(eq(vct.customerId, fromId));
  const fromBalances = await db.select().from(vcb).where(eq(vcb.customerId, fromId));
  if (!fromRows.length && !fromBalances.length) return;
  const intoKeys = new Set((await db.select({ code: vct.code, key: vct.sourceKey }).from(vct).where(eq(vct.customerId, intoId)))
    .filter((r) => r.key !== null).map((r) => `${r.code}\u0000${r.key}`));
  const duplicate = fromRows.filter((r) => r.sourceKey !== null && intoKeys.has(`${r.code}\u0000${r.sourceKey}`));
  const add = new Map<string, number>();
  for (const b of fromBalances) add.set(b.code, (add.get(b.code) ?? 0) + b.balance);
  for (const r of duplicate) add.set(r.code, (add.get(r.code) ?? 0) - r.amount);
  if (duplicate.length) await db.delete(vct).where(inArray(vct.id, duplicate.map((r) => r.id)));
  await db.update(vct).set({ customerId: intoId }).where(eq(vct.customerId, fromId));
  for (const [code, amount] of add) {
    await db.insert(vcb).values({ customerId: intoId, code, balance: Math.max(0, amount) })
      .onConflictDoUpdate({ target: [vcb.customerId, vcb.code], set: { balance: sql`greatest(0, ${vcb.balance} + ${amount})` } });
  }
  await db.delete(vcb).where(eq(vcb.customerId, fromId));
}

export async function isOnlyAnonymous(db: DB, customerId: string): Promise<boolean> {
  const aliases = await aliasesOf(db, customerId);
  return aliases.length > 0 && aliases.every(isAnonymous);
}

/**
 * logIn semantics (POST /v1/subscribers/identify):
 * - the new id already exists: switch to it (200). If the old id was anonymous and the new customer has no anonymous alias yet, the anonymous customer is merged in.
 * - the new id is new and the old id is anonymous: the new id becomes an alias of the anonymous customer (201).
 * - otherwise a fresh customer is created for the new id (201).
 */
export async function identify(db: DB, projectId: string, oldId: string, newAppUserId: string, now: Date): Promise<{ customer: CustomerRow; created: boolean; aliased: boolean }> {
  const target = await findCustomer(db, projectId, newAppUserId);
  const old = await findCustomer(db, projectId, oldId);
  if (target) {
    let aliased = false;
    if (old && old.id !== target.id && isAnonymous(oldId) && (await isOnlyAnonymous(db, old.id))) {
      const targetAliases = await aliasesOf(db, target.id);
      if (!targetAliases.some(isAnonymous)) { await mergeCustomers(db, old.id, target.id); aliased = true; }
    }
    return { customer: (await findCustomer(db, projectId, newAppUserId))!, created: false, aliased };
  }
  if (old && isAnonymous(oldId) && (await isOnlyAnonymous(db, old.id))) {
    // A concurrent logIn may have added the alias first: only the call that added it reports (and emits) the alias.
    const added = await db.insert(customerAliases).values({ projectId, appUserId: newAppUserId, customerId: old.id }).onConflictDoNothing().returning({ appUserId: customerAliases.appUserId });
    return { customer: (await findCustomer(db, projectId, newAppUserId))!, created: true, aliased: added.length > 0 };
  }
  return { ...(await getOrCreateCustomer(db, projectId, newAppUserId, now)), aliased: false };
}

export async function customersByIds(db: DB, ids: string[]) {
  return ids.length ? db.select().from(customers).where(inArray(customers.id, ids)) : [];
}
