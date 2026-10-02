// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: attaches store traffic to subscription chains that a migration import keyed with incomplete store ids.
// Docs: https://revenuedot.app/docs/migrate
import { and, eq, inArray, isNull, like, ne, or } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";
import { baseOrderId } from "../stores/google/map.js";

const { subscriptions, transactions } = schema;
type SubRow = typeof subscriptions.$inferSelect;

/** Placeholder chain key for an imported Google subscription whose purchase token is not known yet. */
export const NEEDS_TOKEN = "needs_token_refresh:";

const isApple = (store: string) => store === "app_store" || store === "mac_app_store";

/** What the store adapters know about a chain when it arrives: its real key plus every store id that belongs to it. */
export interface ChainIds {
  store: string;
  storeKey: string;
  storeTransactionId?: string | null;
  originalTransactionId?: string | null;
  /** Apple: other transaction ids of the chain the store proved (receipt history). Google: other order ids. */
  chainTransactionIds?: string[] | null;
  productIdentifier?: string;
  purchaseDate?: Date;
  originalPurchaseDate?: Date;
  /** Google: the purchase token this one replaced (`linkedPurchaseToken`) and the order ids Google reports for it. */
  replacesStoreKey?: string | null;
  replacedOrderIds?: string[] | null;
}

const uniq = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x))];

/**
 * An import can only key a chain with what the export had:
 * - Google: the order id, until the purchase token is found (`needs_token_refresh:<order>`).
 * - Apple without the in-app purchase key: the first transaction RevenueCat knew, which is not Apple's
 *   original_transaction_id when RevenueCat split the chain after a lapse. Those rows keep `original_transaction_id` null.
 * When the store later proves the real key (a receipt post or a notification), the imported row takes that key, so the
 * purchase updates it (no duplicate row, no false INITIAL_PURCHASE). Idempotent; a no-op once keys are real.
 * `ownerId` (the customer the purchase belongs to, when known) also matches an unconfirmed Apple row of that customer
 * for the same product that started after the chain did: the later half of a chain the source split.
 */
export async function adoptImportedChain(db: DB, projectId: string, p: ChainIds, ownerId?: string | null): Promise<void> {
  if (p.store === "play_store") {
    await adoptGoogle(db, projectId, p.storeKey, uniq([p.storeTransactionId, p.originalTransactionId, ...(p.chainTransactionIds ?? [])]));
    if (p.replacesStoreKey && p.replacedOrderIds?.length) await adoptGoogle(db, projectId, p.replacesStoreKey, uniq(p.replacedOrderIds));
  } else if (isApple(p.store)) {
    await adoptApple(db, projectId, p, ownerId ?? null);
  }
}

async function rowByKey(db: DB, projectId: string, store: string, key: string): Promise<SubRow | undefined> {
  const [row] = await db.select().from(subscriptions)
    .where(and(eq(subscriptions.projectId, projectId), eq(subscriptions.store, store), eq(subscriptions.storeKey, key))).limit(1);
  return row;
}

/** Folds imported rows into the chain's real key: the newest becomes the chain (when it has no row yet), the rest go. */
async function fold(db: DB, projectId: string, store: string, key: string, candidates: SubRow[], set: Partial<SubRow> = {}) {
  if (!candidates.length) return;
  let target = await rowByKey(db, projectId, store, key);
  const sorted = [...candidates].sort((a, b) => b.purchaseDate.getTime() - a.purchaseDate.getTime());
  const earliest = new Date(Math.min(...candidates.map((c) => c.originalPurchaseDate.getTime()), target?.originalPurchaseDate.getTime() ?? Infinity));
  for (const c of sorted) {
    if (!target) {
      await db.update(subscriptions).set({ storeKey: key, originalPurchaseDate: earliest, ...set }).where(eq(subscriptions.id, c.id));
      target = { ...c, storeKey: key };
      continue;
    }
    // The row with the newer period carries the chain's state; the store's update that follows overwrites it anyway.
    if (c.purchaseDate > target.purchaseDate && c.customerId === target.customerId) {
      await db.delete(subscriptions).where(eq(subscriptions.id, target.id));
      await db.update(subscriptions).set({ storeKey: key, originalPurchaseDate: earliest, ...set }).where(eq(subscriptions.id, c.id));
      target = { ...c, storeKey: key };
    } else {
      await db.delete(subscriptions).where(eq(subscriptions.id, c.id));
      await db.update(subscriptions).set({ originalPurchaseDate: earliest }).where(eq(subscriptions.id, target.id));
    }
  }
}

async function adoptGoogle(db: DB, projectId: string, token: string, orderIds: string[]) {
  if (!orderIds.length || token.startsWith(NEEDS_TOKEN)) return;
  if (await rowByKey(db, projectId, "play_store", token)) return;
  const bases = uniq(orderIds.map(baseOrderId));
  const S = subscriptions;
  const candidates = await db.select().from(S).where(and(
    eq(S.projectId, projectId), eq(S.store, "play_store"), like(S.storeKey, `${NEEDS_TOKEN}%`),
    or(
      inArray(S.storeKey, bases.map((b) => NEEDS_TOKEN + b)),
      inArray(S.storeTransactionId, orderIds),
      inArray(S.originalTransactionId, bases),
    ),
  ));
  await fold(db, projectId, "play_store", token, candidates);
}

async function adoptApple(db: DB, projectId: string, p: ChainIds, ownerId: string | null) {
  const S = subscriptions;
  const ids = uniq([p.storeTransactionId, p.originalTransactionId, ...(p.chainTransactionIds ?? [])]).filter((x) => x !== p.storeKey);
  const unconfirmed = and(eq(S.projectId, projectId), eq(S.store, p.store), ne(S.storeKey, p.storeKey), isNull(S.originalTransactionId));
  const matches: SubRow[] = [];
  if (ids.length) {
    matches.push(...await db.select().from(S).where(and(unconfirmed, or(inArray(S.storeKey, ids), inArray(S.storeTransactionId, ids)))));
    // Imported transaction history: a chain whose earlier transactions were imported under another key.
    const owners = await db.selectDistinct({ c: transactions.customerId, product: transactions.productIdentifier }).from(transactions)
      .where(and(eq(transactions.projectId, projectId), eq(transactions.store, p.store), inArray(transactions.storeTransactionId, ids)));
    for (const o of owners) {
      matches.push(...await db.select().from(S).where(and(unconfirmed, eq(S.customerId, o.c), eq(S.productIdentifier, o.product))));
    }
  }
  if (ownerId && p.productIdentifier && p.originalPurchaseDate && p.purchaseDate) {
    // The later half of a split chain: same customer and product, started after Apple's original purchase, not newer than this period.
    const rows = await db.select().from(S).where(and(unconfirmed, eq(S.customerId, ownerId), eq(S.productIdentifier, p.productIdentifier)));
    matches.push(...rows.filter((r) => r.originalPurchaseDate >= p.originalPurchaseDate! && r.purchaseDate <= p.purchaseDate!));
  }
  const byId = new Map(matches.map((m) => [m.id, m]));
  await fold(db, projectId, p.store, p.storeKey, [...byId.values()], { originalTransactionId: p.originalTransactionId ?? p.storeKey });
}

/**
 * The import side of the same problem: an Apple chain the store already re-keyed (a receipt arrived after the first
 * import) is found again by its transactions, so running the import a second time updates it instead of adding a row.
 * `rows` are the subscriptions the import has in hand for the page (it loads every row of its customers up front).
 */
export function importedAppleChainKey(rows: Iterable<Pick<SubRow, "store" | "customerId" | "storeTransactionId" | "storeKey">>, store: string, customerId: string, txIds: string[]): string | null {
  const want = new Set(txIds);
  for (const r of rows) if (r.store === store && r.customerId === customerId && r.storeTransactionId !== null && want.has(r.storeTransactionId)) return r.storeKey;
  return null;
}
