import { and, eq, inArray, sql } from "drizzle-orm";
import { newId, productKeysFor, webhookStore, type Store } from "@revenuedot/core";
import { schema, type DB } from "@revenuedot/db";
import type { CustomerRow } from "../repo/customers.js";
import { recordRawEvent } from "./events.js";
import { accessOf } from "../repo/access.js";

/**
 * In-app currencies (virtual currencies). A balance is the sum of its ledger rows; `virtual_currency_balances` caches it.
 * Product grants credit a balance when a purchase, renewal or trial start is recorded; the store transaction id is the
 * ledger's idempotency key, so replayed notifications and receipts never credit twice.
 */

export interface Balance { code: string; name: string; description: string | null; balance: number }

/** Credits the currencies whose product grants name this product. Returns the credited amounts per currency code. */
export async function grantForPurchase(db: DB, opts: {
  projectId: string; appId: string | null; customer: CustomerRow; appUserId: string; store: string; sandbox: boolean; productIdentifier: string; productPlanIdentifier?: string | null;
  trial: boolean; transactionId: string; now: Date;
}): Promise<Record<string, number>> {
  const currencies = await db.select().from(schema.virtualCurrencies)
    .where(and(eq(schema.virtualCurrencies.projectId, opts.projectId), eq(schema.virtualCurrencies.state, "active")));
  if (!currencies.some((c) => c.productGrants.length)) return {};
  // Blocked customers, and sandbox purchases outside the project's sandbox testing access, credit nothing (prd/project-settings).
  const access = await accessOf(db, opts.customer);
  if (access.blocked || (opts.sandbox && access.sandbox === false)) return {};
  const ids = productKeysFor(opts);
  const products = await db.select({ id: schema.products.id, name: schema.products.displayName }).from(schema.products)
    .where(and(eq(schema.products.projectId, opts.projectId), inArray(schema.products.storeIdentifier, ids), ...(opts.appId ? [eq(schema.products.appId, opts.appId)] : [])));
  const productIds = new Set(products.map((p) => p.id));
  const credited: Record<string, number> = {};
  for (const cur of currencies) {
    let amount = 0;
    for (const g of cur.productGrants) if (g.product_ids.some((id) => productIds.has(id))) amount += opts.trial ? g.trial_amount : g.amount;
    if (amount <= 0) continue;
    const ledgerId = await adjust(db, opts.projectId, opts.customer.id, cur.code, amount, { source: "purchase", sourceKey: opts.transactionId, now: opts.now });
    if (!ledgerId) continue;
    credited[cur.code] = amount;
    // RevenueCat sends this event for purchase grants only; adjustments through the API make no webhook.
    await recordRawEvent(db, {
      projectId: opts.projectId, appId: opts.appId, customer: opts.customer, appUserId: opts.appUserId, type: "VIRTUAL_CURRENCY_TRANSACTION", sandbox: opts.sandbox, now: opts.now,
      fields: {
        adjustments: [{ amount, currency: { code: cur.code, description: cur.description, name: cur.name } }],
        product_display_name: products[0]?.name ?? opts.productIdentifier, product_id: opts.productIdentifier, purchase_environment: opts.sandbox ? "SANDBOX" : "PRODUCTION",
        source: "in_app_purchase", store: webhookStore(opts.store as Store), transaction_id: opts.transactionId, virtual_currency_transaction_id: `vatx${ledgerId.slice(4)}`,
      },
    });
  }
  return credited;
}

/** Applies one signed change. Returns the ledger id, or null when `sourceKey` was already applied. */
export async function adjust(db: DB, projectId: string, customerId: string, code: string, amount: number,
  o: { source: "api" | "purchase" | "sdk" | "ad_reward"; sourceKey?: string | null; reference?: string | null; now: Date }): Promise<string | null> {
  const inserted = await db.insert(schema.virtualCurrencyTransactions).values({
    id: newId("vct_", 16), projectId, customerId, code, amount, source: o.source, sourceKey: o.sourceKey ?? null, reference: o.reference ?? null, createdAt: o.now,
  }).onConflictDoNothing().returning({ id: schema.virtualCurrencyTransactions.id });
  // A null source key never conflicts (Postgres treats nulls as distinct), so API adjustments without a key always apply.
  if (!inserted.length) return null;
  await db.insert(schema.virtualCurrencyBalances).values({ customerId, code, balance: amount })
    .onConflictDoUpdate({ target: [schema.virtualCurrencyBalances.customerId, schema.virtualCurrencyBalances.code], set: { balance: sql`${schema.virtualCurrencyBalances.balance} + ${amount}` } });
  return inserted[0]!.id;
}

/** Balances of the project's currencies for a customer: every active currency, or only those with a non-zero balance. */
export async function balancesOf(db: DB, projectId: string, customerId: string, opts: { includeEmpty: boolean }): Promise<Balance[]> {
  const currencies = await db.select().from(schema.virtualCurrencies).where(eq(schema.virtualCurrencies.projectId, projectId));
  const rows = await db.select().from(schema.virtualCurrencyBalances).where(eq(schema.virtualCurrencyBalances.customerId, customerId));
  const have = new Map(rows.map((r) => [r.code, r.balance]));
  return currencies
    .filter((c) => c.state === "active" || (have.get(c.code) ?? 0) !== 0)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.code < b.code ? -1 : 1))
    .map((c) => ({ code: c.code, name: c.name, description: c.description, balance: have.get(c.code) ?? 0 }))
    .filter((b) => opts.includeEmpty || b.balance !== 0);
}
