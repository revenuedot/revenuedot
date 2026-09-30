import { and, eq, inArray } from "drizzle-orm";
import { isAnonymous, newId, type CustomerState, type NonSubscription, type Subscription } from "@revenuedot/core";
import { schema, type DB } from "@revenuedot/db";

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

export async function touch(db: DB, customerId: string, now: Date, info: { appVersion?: string | null; platform?: string | null; country?: string | null } = {}) {
  await db.update(customers).set({
    lastSeen: now,
    ...(info.appVersion ? { lastSeenAppVersion: info.appVersion } : {}),
    ...(info.platform ? { lastSeenPlatform: info.platform } : {}),
    ...(info.country ? { lastSeenCountry: info.country } : {}),
  }).where(eq(customers.id, customerId));
}

/** Upserts attributes; a newer `updated_at_ms` wins. Empty string or null deletes the value (iOS sends "", Android null). */
export async function setAttributes(db: DB, customerId: string, attrs: Record<string, { value: unknown; updated_at_ms?: number }>, now: Date) {
  for (const [key, raw] of Object.entries(attrs ?? {})) {
    const value = raw?.value === null || raw?.value === undefined || raw.value === "" ? null : String(raw.value);
    const updatedAtMs = Number(raw?.updated_at_ms ?? now.getTime());
    const [cur] = await db.select().from(customerAttributes).where(and(eq(customerAttributes.customerId, customerId), eq(customerAttributes.key, key))).limit(1);
    if (cur && cur.updatedAtMs > updatedAtMs) continue;
    if (cur) await db.update(customerAttributes).set({ value, updatedAtMs }).where(and(eq(customerAttributes.customerId, customerId), eq(customerAttributes.key, key)));
    else await db.insert(customerAttributes).values({ customerId, key, value, updatedAtMs });
  }
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
  };
}

export function nonSubRowToDomain(r: typeof nonSubscriptions.$inferSelect): NonSubscription {
  return {
    id: r.id, productIdentifier: r.productIdentifier, store: r.store as NonSubscription["store"], isSandbox: r.isSandbox,
    purchaseDate: r.purchaseDate, storeTransactionId: r.storeTransactionId, isConsumable: r.isConsumable, refundedAt: r.refundedAt,
    price: r.priceAmount !== null && r.priceCurrency ? { amount: r.priceAmount, currency: r.priceCurrency } : null,
  };
}

export async function loadState(db: DB, customer: CustomerRow): Promise<CustomerState> {
  const [subs, ones, attrs] = await Promise.all([
    db.select().from(subscriptions).where(eq(subscriptions.customerId, customer.id)),
    db.select().from(nonSubscriptions).where(eq(nonSubscriptions.customerId, customer.id)),
    db.select().from(customerAttributes).where(eq(customerAttributes.customerId, customer.id)),
  ]);
  const attributes: CustomerState["attributes"] = {};
  for (const a of attrs) attributes[a.key] = { value: a.value, updatedAtMs: a.updatedAtMs };
  return {
    originalAppUserId: customer.originalAppUserId, firstSeen: customer.firstSeen, lastSeen: customer.lastSeen,
    originalApplicationVersion: customer.originalApplicationVersion, originalPurchaseDate: customer.originalPurchaseDate,
    subscriptions: subs.map(subRowToDomain), nonSubscriptions: ones.map(nonSubRowToDomain), attributes,
  };
}

/** Moves everything from `from` into `into` (aliases, purchases, attributes that `into` lacks) and deletes `from`. */
export async function mergeCustomers(db: DB, fromId: string, intoId: string) {
  if (fromId === intoId) return;
  await db.update(customerAliases).set({ customerId: intoId }).where(eq(customerAliases.customerId, fromId));
  await db.update(subscriptions).set({ customerId: intoId }).where(eq(subscriptions.customerId, fromId));
  await db.update(nonSubscriptions).set({ customerId: intoId }).where(eq(nonSubscriptions.customerId, fromId));
  await db.update(schema.transactions).set({ customerId: intoId }).where(eq(schema.transactions.customerId, fromId));
  await db.update(schema.events).set({ customerId: intoId }).where(eq(schema.events.customerId, fromId));
  const intoAttrs = await db.select({ key: customerAttributes.key }).from(customerAttributes).where(eq(customerAttributes.customerId, intoId));
  const have = new Set(intoAttrs.map((a) => a.key));
  const fromAttrs = await db.select().from(customerAttributes).where(eq(customerAttributes.customerId, fromId));
  for (const a of fromAttrs) if (!have.has(a.key)) await db.insert(customerAttributes).values({ ...a, customerId: intoId }).onConflictDoNothing();
  await db.delete(customers).where(eq(customers.id, fromId));
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
export async function identify(db: DB, projectId: string, oldId: string, newAppUserId: string, now: Date): Promise<{ customer: CustomerRow; created: boolean }> {
  const target = await findCustomer(db, projectId, newAppUserId);
  const old = await findCustomer(db, projectId, oldId);
  if (target) {
    if (old && old.id !== target.id && isAnonymous(oldId) && (await isOnlyAnonymous(db, old.id))) {
      const targetAliases = await aliasesOf(db, target.id);
      if (!targetAliases.some(isAnonymous)) await mergeCustomers(db, old.id, target.id);
    }
    return { customer: (await findCustomer(db, projectId, newAppUserId))!, created: false };
  }
  if (old && isAnonymous(oldId) && (await isOnlyAnonymous(db, old.id))) {
    await db.insert(customerAliases).values({ projectId, appUserId: newAppUserId, customerId: old.id }).onConflictDoNothing();
    return { customer: (await findCustomer(db, projectId, newAppUserId))!, created: true };
  }
  return getOrCreateCustomer(db, projectId, newAppUserId, now);
}

export async function customersByIds(db: DB, ids: string[]) {
  return ids.length ? db.select().from(customers).where(inArray(customers.id, ids)) : [];
}
