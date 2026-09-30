import { and, eq, sql } from "drizzle-orm";
import { diffNonSubscription, diffSubscription, isAnonymous, newId, type Subscription } from "@revenuedot/core";
import { schema, type DB } from "@revenuedot/db";
import { Codes, RCError } from "../errors.js";
import { backdateFirstSeen, findCustomer, isOnlyAnonymous, mergeCustomers, nonSubRowToDomain, subRowToDomain, type CustomerRow } from "../repo/customers.js";
import type { VerifiedPurchase, VerifiedSubscription } from "../stores/types.js";
import { recordEvent } from "./events.js";

const { subscriptions, nonSubscriptions, transactions, projects, customers } = schema;

export interface ApplyContext {
  projectId: string;
  appId: string | null;
  appUserId: string;
  now: Date;
  presentedOfferingId?: string | null;
  /** Receipt posts transfer ownership; store notifications never do. */
  fromDevice: boolean;
  /** The customer was created for these purchases: its first-seen date moves back to the earliest purchase. */
  customerCreated?: boolean;
}

/** USD value of a price; non-USD currencies need an FX source (TODO: daily rates table). */
const toUsd = (p?: { amount: number; currency: string } | null) => (p && p.currency === "USD" ? p.amount : p?.amount ?? 0);

/**
 * Saves verified purchases for a customer, resolving ownership, and records lifecycle events and revenue transactions.
 * Returns the customer that owns the purchases afterwards (it may change after a merge).
 */
export async function applyPurchases(db: DB, customer: CustomerRow, purchases: VerifiedPurchase[], ctx: ApplyContext): Promise<CustomerRow> {
  let owner = customer;
  for (const p of purchases) {
    if (p.kind === "subscription") owner = await applySubscription(db, owner, p, ctx);
    else owner = await applyOneTime(db, owner, p, ctx);
  }
  if (ctx.customerCreated && purchases.length) {
    const earliest = new Date(Math.min(...purchases.map((p) => (p.kind === "subscription" ? p.originalPurchaseDate : p.purchaseDate).getTime())));
    await backdateFirstSeen(db, owner.id, earliest);
    [owner] = await db.select().from(customers).where(eq(customers.id, owner.id)) as [CustomerRow];
  }
  return owner;
}

async function resolveOwnership(db: DB, current: CustomerRow, existingOwnerId: string, ctx: ApplyContext, sandbox: boolean): Promise<{ owner: CustomerRow; transferFrom?: CustomerRow }> {
  if (existingOwnerId === current.id || !ctx.fromDevice) {
    const [o] = await db.select().from(customers).where(eq(customers.id, existingOwnerId));
    return { owner: o ?? current };
  }
  const [prevOwner] = await db.select().from(customers).where(eq(customers.id, existingOwnerId));
  if (!prevOwner) return { owner: current };
  // An anonymous owner is always merged into the customer posting the receipt.
  if (await isOnlyAnonymous(db, prevOwner.id)) {
    await mergeCustomers(db, prevOwner.id, current.id);
    return { owner: current };
  }
  if (isAnonymous(ctx.appUserId) && (await isOnlyAnonymous(db, current.id))) {
    // The poster is anonymous and the receipt belongs to a known user: RevenueCat aliases the anonymous id into the owner.
    await mergeCustomers(db, current.id, prevOwner.id);
    const [o] = await db.select().from(customers).where(eq(customers.id, prevOwner.id));
    return { owner: o! };
  }
  const [project] = await db.select().from(projects).where(eq(projects.id, ctx.projectId));
  const behavior = (sandbox ? project?.sandboxTransferBehavior : null) ?? project?.transferBehavior ?? "transfer";
  if (behavior === "keep") {
    throw new RCError(400, Codes.RECEIPT_ALREADY_IN_USE, "The receipt is already in use by another subscriber.");
  }
  if (behavior === "share") {
    await mergeCustomers(db, current.id, prevOwner.id);
    const [o] = await db.select().from(customers).where(eq(customers.id, prevOwner.id));
    return { owner: o! };
  }
  if (behavior === "transfer_if_no_active") {
    const active = await db.select().from(subscriptions).where(eq(subscriptions.customerId, prevOwner.id));
    if (active.some((s) => s.expiresDate === null || s.expiresDate > ctx.now)) {
      throw new RCError(400, Codes.RECEIPT_ALREADY_IN_USE, "The receipt is already in use by another subscriber with an active subscription.");
    }
  }
  return { owner: current, transferFrom: prevOwner };
}

async function applySubscription(db: DB, customer: CustomerRow, p: Extract<VerifiedPurchase, { kind: "subscription" }>, ctx: ApplyContext) {
  const [existing] = await db.select().from(subscriptions)
    .where(and(eq(subscriptions.projectId, ctx.projectId), eq(subscriptions.store, p.store), eq(subscriptions.storeKey, p.storeKey))).limit(1);
  let owner = customer;
  let transferFrom: CustomerRow | undefined;
  if (existing) ({ owner, transferFrom } = await resolveOwnership(db, customer, existing.customerId, ctx, p.isSandbox));
  const prev: Subscription | null = existing ? subRowToDomain(existing) : null;
  const values = {
    projectId: ctx.projectId, customerId: owner.id, appId: ctx.appId, store: p.store, storeKey: p.storeKey,
    productIdentifier: p.productIdentifier, productPlanIdentifier: p.productPlanIdentifier ?? null, isSandbox: p.isSandbox,
    purchaseDate: p.purchaseDate, originalPurchaseDate: p.originalPurchaseDate, expiresDate: p.expiresDate, periodType: p.periodType,
    ownershipType: p.ownershipType ?? "PURCHASED", unsubscribeDetectedAt: p.unsubscribeDetectedAt ?? null,
    billingIssuesDetectedAt: p.billingIssuesDetectedAt ?? null, gracePeriodExpiresDate: p.gracePeriodExpiresDate ?? null,
    refundedAt: p.refundedAt ?? null, autoResumeDate: p.autoResumeDate ?? null, storeTransactionId: p.storeTransactionId,
    originalTransactionId: p.originalTransactionId ?? null, priceAmount: p.price?.amount ?? null, priceCurrency: p.price?.currency ?? null,
    priceUsd: p.price ? toUsd(p.price) : null, countryCode: p.countryCode ?? null, autoRenewProductId: p.autoRenewProductId ?? null, updatedAt: ctx.now,
    // `undefined` means the store did not say; keep what we know. A cancel reason only lives while auto-renew is off.
    cancelReason: !p.unsubscribeDetectedAt ? null : p.cancelReason === undefined ? existing?.cancelReason ?? null : p.cancelReason,
    priceIncreaseStatus: p.priceIncreaseStatus === undefined ? existing?.priceIncreaseStatus ?? null : p.priceIncreaseStatus,
    // Access that runs past now reopens the chain for a future EXPIRATION; an EXPIRATION derived below sets it again.
    expiredEventAt: (p.expiresDate === null || p.expiresDate > ctx.now || (p.gracePeriodExpiresDate && p.gracePeriodExpiresDate > ctx.now)) ? null : existing?.expiredEventAt ?? null,
  };
  if (existing) await db.update(subscriptions).set(values).where(eq(subscriptions.id, existing.id));
  else await db.insert(subscriptions).values({ id: newId("sub_", 16), ...values });
  const next = subRowToDomain({ ...(existing ?? ({} as typeof subscriptions.$inferSelect)), ...values, id: existing?.id ?? "" } as typeof subscriptions.$inferSelect);

  await db.update(customers).set({
    originalPurchaseDate: owner.originalPurchaseDate && owner.originalPurchaseDate < p.originalPurchaseDate ? owner.originalPurchaseDate : p.originalPurchaseDate,
  }).where(eq(customers.id, owner.id));

  const subject = {
    store: p.store, productId: p.productIdentifier, productPlanId: p.productPlanIdentifier, periodType: p.periodType,
    purchasedAt: p.purchaseDate, expiresAt: p.expiresDate, gracePeriodExpiresAt: p.gracePeriodExpiresDate, autoResumeAt: p.autoResumeDate,
    transactionId: p.storeTransactionId, originalTransactionId: p.originalTransactionId ?? p.storeKey, isSandbox: p.isSandbox,
    isFamilyShare: p.ownershipType === "FAMILY_SHARED", countryCode: p.countryCode, price: p.price, priceUsd: p.price ? toUsd(p.price) : null,
    presentedOfferingId: ctx.presentedOfferingId,
  };
  if (transferFrom) {
    const fromAliases = await db.select({ a: schema.customerAliases.appUserId }).from(schema.customerAliases).where(eq(schema.customerAliases.customerId, transferFrom.id));
    const toAliases = await db.select({ a: schema.customerAliases.appUserId }).from(schema.customerAliases).where(eq(schema.customerAliases.customerId, owner.id));
    await recordEvent(db, { projectId: ctx.projectId, appId: ctx.appId, customer: owner, appUserId: ctx.appUserId, derived: { type: "TRANSFER" }, subject, now: ctx.now,
      extra: { transferred_from: fromAliases.map((r) => r.a), transferred_to: toAliases.map((r) => r.a) } });
  }
  for (const d of diffSubscription(prev, next, ctx.now)) {
    await recordEvent(db, { projectId: ctx.projectId, appId: ctx.appId, customer: owner, appUserId: ctx.appUserId, derived: d, subject, now: ctx.now });
    if (d.type === "EXPIRATION") await db.update(subscriptions).set({ expiredEventAt: ctx.now }).where(and(eq(subscriptions.projectId, ctx.projectId), eq(subscriptions.store, p.store), eq(subscriptions.storeKey, p.storeKey)));
    const refund = d.type === "CANCELLATION" && d.isRefund;
    if (d.type === "INITIAL_PURCHASE" || d.type === "RENEWAL" || refund || d.type === "REFUND_REVERSED") {
      const kind = refund ? "refund" : d.type === "REFUND_REVERSED" ? "refund_reversal" : d.type === "RENEWAL" ? "renewal" : p.periodType === "trial" ? "trial" : "purchase";
      await db.insert(transactions).values({
        id: newId("txn_", 16), projectId: ctx.projectId, customerId: owner.id, appId: ctx.appId, store: p.store,
        storeTransactionId: p.storeTransactionId, productIdentifier: p.productIdentifier, kind, isSandbox: p.isSandbox,
        purchasedAt: refund ? p.refundedAt ?? ctx.now : d.type === "REFUND_REVERSED" ? ctx.now : p.purchaseDate, expiresAt: p.expiresDate,
        revenueUsd: kind === "trial" ? 0 : (refund ? -1 : 1) * (p.price ? toUsd(p.price) : 0),
        priceAmount: p.price?.amount ?? null, priceCurrency: p.price?.currency ?? null, countryCode: p.countryCode ?? null,
      }).onConflictDoNothing();
    }
  }
  if (p.replacesStoreKey && p.replacesStoreKey !== p.storeKey) await applyReplacement(db, ctx, p);
  const [o] = await db.select().from(customers).where(eq(customers.id, owner.id));
  return o!;
}

async function applyOneTime(db: DB, customer: CustomerRow, p: Extract<VerifiedPurchase, { kind: "non_subscription" }>, ctx: ApplyContext) {
  const [existing] = await db.select().from(nonSubscriptions)
    .where(and(eq(nonSubscriptions.projectId, ctx.projectId), eq(nonSubscriptions.store, p.store), eq(nonSubscriptions.storeTransactionId, p.storeTransactionId))).limit(1);
  let owner = customer;
  if (existing) ({ owner } = await resolveOwnership(db, customer, existing.customerId, ctx, p.isSandbox));
  const values = {
    projectId: ctx.projectId, customerId: owner.id, appId: ctx.appId, store: p.store, productIdentifier: p.productIdentifier,
    storeTransactionId: p.storeTransactionId, isSandbox: p.isSandbox, isConsumable: p.isConsumable, purchaseDate: p.purchaseDate,
    refundedAt: p.refundedAt ?? null, priceAmount: p.price?.amount ?? null, priceCurrency: p.price?.currency ?? null,
    priceUsd: p.price ? toUsd(p.price) : null, countryCode: p.countryCode ?? null,
  };
  const prev = existing ? nonSubRowToDomain(existing) : null;
  let id = existing?.id;
  if (existing) await db.update(nonSubscriptions).set(values).where(eq(nonSubscriptions.id, existing.id));
  else { id = newId("", 10); await db.insert(nonSubscriptions).values({ id, ...values }); }
  const next = nonSubRowToDomain({ id: id!, ...values } as typeof nonSubscriptions.$inferSelect);
  const subject = {
    store: p.store, productId: p.productIdentifier, periodType: "normal", purchasedAt: p.purchaseDate, expiresAt: null,
    transactionId: p.storeTransactionId, originalTransactionId: p.storeTransactionId, isSandbox: p.isSandbox, isFamilyShare: false,
    countryCode: p.countryCode, price: p.price, priceUsd: p.price ? toUsd(p.price) : null, presentedOfferingId: ctx.presentedOfferingId,
  };
  for (const d of diffNonSubscription(prev, next)) {
    await recordEvent(db, { projectId: ctx.projectId, appId: ctx.appId, customer: owner, appUserId: ctx.appUserId, derived: d, subject, now: ctx.now });
    const kind = d.isRefund ? "refund" : d.type === "REFUND_REVERSED" ? "refund_reversal" : "one_time";
    await db.insert(transactions).values({
      id: newId("txn_", 16), projectId: ctx.projectId, customerId: owner.id, appId: ctx.appId, store: p.store,
      storeTransactionId: p.storeTransactionId, productIdentifier: p.productIdentifier, kind,
      isSandbox: p.isSandbox, purchasedAt: kind === "refund" ? p.refundedAt ?? ctx.now : kind === "refund_reversal" ? ctx.now : p.purchaseDate,
      revenueUsd: (d.isRefund ? -1 : 1) * (p.price ? toUsd(p.price) : 0),
      priceAmount: p.price?.amount ?? null, priceCurrency: p.price?.currency ?? null, countryCode: p.countryCode ?? null,
    }).onConflictDoNothing();
  }
  const [o] = await db.select().from(customers).where(eq(customers.id, owner.id));
  return o!;
}

const planKey = (p: { productIdentifier: string; productPlanIdentifier?: string | null }) =>
  p.productPlanIdentifier ? `${p.productIdentifier}:${p.productPlanIdentifier}` : p.productIdentifier;
const minDate = (a: Date, b: Date) => (a < b ? a : b);

/**
 * An immediate upgrade, downgrade or crossgrade on Google Play issues a new purchase token whose `linkedPurchaseToken`
 * is the old one. The new token is its own chain (INITIAL_PURCHASE); the old chain ends at the switch with a
 * PRODUCT_CHANGE event for the old product (no CANCELLATION, no EXPIRATION), on whichever path learns of the new token
 * first: the device posting it to /v1/receipts, or the store notification. Idempotent.
 */
async function applyReplacement(db: DB, ctx: ApplyContext, next: VerifiedSubscription) {
  const [old] = await db.select().from(subscriptions)
    .where(and(eq(subscriptions.projectId, ctx.projectId), eq(subscriptions.store, next.store), eq(subscriptions.storeKey, next.replacesStoreKey!))).limit(1);
  if (!old) return;
  const oldOriginal = old.originalTransactionId ?? old.storeKey;
  const [done] = await db.select({ id: schema.events.id }).from(schema.events).where(and(
    eq(schema.events.projectId, ctx.projectId), eq(schema.events.customerId, old.customerId), eq(schema.events.type, "PRODUCT_CHANGE"),
    sql`${schema.events.payload}->'event'->>'original_transaction_id' = ${oldOriginal}`,
    sql`${schema.events.payload}->'event'->>'transaction_id' = ${old.storeTransactionId ?? ""}`,
  )).limit(1);
  let expiresDate = old.expiresDate ? minDate(old.expiresDate, next.originalPurchaseDate) : next.originalPurchaseDate;
  if (next.replacedExpiresDate) expiresDate = minDate(expiresDate, next.replacedExpiresDate);
  await db.update(subscriptions).set({
    expiresDate, gracePeriodExpiresDate: null, billingIssuesDetectedAt: null, autoResumeDate: null,
    autoRenewProductId: next.productIdentifier, expiredEventAt: old.expiredEventAt ?? ctx.now, updatedAt: ctx.now,
  }).where(eq(subscriptions.id, old.id));
  if (done || planKey(old) === planKey(next)) return;
  const [oldOwner] = await db.select().from(customers).where(eq(customers.id, old.customerId));
  if (!oldOwner) return;
  const aliases = await db.select({ a: schema.customerAliases.appUserId }).from(schema.customerAliases).where(eq(schema.customerAliases.customerId, oldOwner.id));
  const d = subRowToDomain(old);
  await recordEvent(db, {
    projectId: ctx.projectId, appId: old.appId ?? ctx.appId, customer: oldOwner, appUserId: aliases.find((a) => !isAnonymous(a.a))?.a ?? oldOwner.originalAppUserId,
    // Google's immediate replacement: `product_id` is the old product and there is no `new_product_id` (RevenueCat sends it only for
    // the App Store, deferred Google Play changes and its own billing).
    derived: { type: "PRODUCT_CHANGE" }, now: ctx.now,
    subject: {
      store: d.store, productId: d.productIdentifier, productPlanId: d.productPlanIdentifier, periodType: d.periodType,
      purchasedAt: d.purchaseDate, expiresAt: expiresDate, transactionId: d.storeTransactionId ?? null, originalTransactionId: oldOriginal,
      isSandbox: d.isSandbox, isFamilyShare: d.ownershipType === "FAMILY_SHARED", countryCode: old.countryCode, price: d.price, priceUsd: old.priceUsd,
    },
  });
}

export { findCustomer };

/**
 * Applies a purchase update that came from a store notification (not from a device).
 * The owner is whoever holds that store key; unknown chains are created on an anonymous customer only when `createIfUnknown` is set
 * (RevenueCat's "track new purchases from server-to-server notifications").
 * Returns false when the purchase is unknown and was not created.
 */
export async function applyFromStore(db: DB, opts: { projectId: string; appId: string; purchase: VerifiedPurchase; now: Date; createIfUnknown?: boolean; appUserIdHint?: string | null }): Promise<boolean> {
  const { projectId, appId, purchase: p, now } = opts;
  let ownerId: string | null = null;
  if (p.kind === "subscription") {
    const [row] = await db.select({ c: subscriptions.customerId }).from(subscriptions)
      .where(and(eq(subscriptions.projectId, projectId), eq(subscriptions.store, p.store), eq(subscriptions.storeKey, p.storeKey))).limit(1);
    ownerId = row?.c ?? null;
  } else {
    const [row] = await db.select({ c: nonSubscriptions.customerId }).from(nonSubscriptions)
      .where(and(eq(nonSubscriptions.projectId, projectId), eq(nonSubscriptions.store, p.store), eq(nonSubscriptions.storeTransactionId, p.storeTransactionId))).limit(1);
    ownerId = row?.c ?? null;
  }
  let owner: CustomerRow | undefined;
  let created = false;
  if (ownerId) [owner] = await db.select().from(customers).where(eq(customers.id, ownerId));
  if (!owner && opts.appUserIdHint) owner = (await findCustomer(db, projectId, opts.appUserIdHint)) ?? undefined;
  if (!owner) {
    if (!opts.createIfUnknown) return false;
    const { getOrCreateCustomer } = await import("../repo/customers.js");
    ({ customer: owner, created } = await getOrCreateCustomer(db, projectId, opts.appUserIdHint ?? `$RCAnonymousID:${crypto.randomUUID().replace(/-/g, "")}`, now));
  }
  const aliases = await db.select({ a: schema.customerAliases.appUserId }).from(schema.customerAliases).where(eq(schema.customerAliases.customerId, owner.id));
  const appUserId = aliases.find((a) => !isAnonymous(a.a))?.a ?? owner.originalAppUserId;
  await applyPurchases(db, owner, [p], { projectId, appId, appUserId, now, fromDevice: false, customerCreated: created });
  return true;
}
