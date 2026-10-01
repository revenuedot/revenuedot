import { and, asc, eq } from "drizzle-orm";
import { FAILURE_MESSAGES, matchRewardRule, rewardAnswer, ruleCurrencyAmount, type SdkReward } from "@revenuedot/core/ads";
import { newId } from "@revenuedot/core";
import { schema, type DB } from "@revenuedot/db";
import { findCustomer, getOrCreateCustomer, type CustomerRow } from "../../repo/customers.js";
import { applyPurchases } from "../purchases.js";
import { recordRawEvent } from "../events.js";
import { adjust } from "../virtual-currencies.js";

/**
 * Rewarded ads (prd/ads/PRD.md): a verified reward from an ad network's server-side callback (or a test reward from the
 * dashboard) is recorded once per network transaction, the first matching rule grants in-app currency or a temporary
 * entitlement, and the SDK's poll reads the outcome.
 *
 * Idempotent end to end: the verification row is claimed first with status `granting`; currency grants use the
 * verification id as the ledger's idempotency key and entitlement grants a promotional chain keyed by it, so a callback
 * that Google retries after a crash finishes the same grant instead of granting twice.
 */

const V = schema.adRewardVerifications;
type Row = typeof V.$inferSelect;

export interface RewardCallback {
  projectId: string;
  app: { id: string | null; type: string } | null;
  appUserId: string;
  clientTransactionId: string;
  network: "admob" | "test";
  networkTransactionId: string;
  adUnitId: string | null;
  impressionId: string | null;
  rewardItem: string | null;
  rewardAmount: number | null;
  occurredAt: Date;
  isSandbox: boolean;
  now: Date;
}

const isoSeconds = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/** Records a reward and grants it. Returns the ledger row and whether this call created it. */
export async function recordReward(db: DB, cb: RewardCallback, kick?: () => void): Promise<{ row: Row; created: boolean }> {
  const [byNetwork] = await db.select().from(V).where(and(eq(V.network, cb.network), eq(V.networkTransactionId, cb.networkTransactionId))).limit(1);
  if (byNetwork && byNetwork.status !== "granting") return { row: byNetwork, created: false };
  if (!byNetwork) {
    // A client transaction id is used for one reward: a second callback naming it (another network transaction) is ignored.
    const [byClient] = await db.select().from(V).where(and(eq(V.projectId, cb.projectId), eq(V.clientTransactionId, cb.clientTransactionId))).limit(1);
    if (byClient) return { row: byClient, created: false };
  }

  const appUserId = cb.appUserId.trim().slice(0, 256);
  if (!appUserId) {
    const row = await claim(db, cb, null, "failed", "missing_user");
    return { row, created: true };
  }
  const customer = (await findCustomer(db, cb.projectId, appUserId)) ?? (await getOrCreateCustomer(db, cb.projectId, appUserId, cb.now)).customer;
  const row = byNetwork ?? await claim(db, cb, customer, "granting", null);
  if (row.status !== "granting") return { row, created: false };

  const rules = await db.select().from(schema.adRewardRules).where(eq(schema.adRewardRules.projectId, cb.projectId)).orderBy(asc(schema.adRewardRules.position));
  const rule = matchRewardRule(rules, { appId: cb.app?.id ?? null, adUnitId: cb.adUnitId, rewardItem: cb.rewardItem, rewardAmount: cb.rewardAmount });
  let rewards: SdkReward[] = [];
  let failure: string | null = null;
  if (rule) {
    try {
      rewards = await grant(db, rule, row, customer, appUserId, cb);
    } catch (e) {
      if (!(e instanceof GrantError)) throw e;
      failure = "grant_failed";
    }
  }
  const [done] = await db.update(V).set({ status: failure ? "failed" : "verified", failureReason: failure, ruleId: rule?.id ?? null, rewards: rewards as Record<string, unknown>[], customerId: customer.id })
    .where(eq(V.id, row.id)).returning();
  if (rewards.length) kick?.();
  return { row: done!, created: !byNetwork };
}

async function claim(db: DB, cb: RewardCallback, customer: CustomerRow | null, status: string, failure: string | null): Promise<Row> {
  const [row] = await db.insert(V).values({
    id: newId("adrw_", 16), projectId: cb.projectId, appId: cb.app?.id ?? null, customerId: customer?.id ?? null, appUserId: cb.appUserId.slice(0, 256),
    clientTransactionId: cb.clientTransactionId, network: cb.network, networkTransactionId: cb.networkTransactionId, adUnitId: cb.adUnitId, impressionId: cb.impressionId,
    rewardItem: cb.rewardItem, rewardAmount: cb.rewardAmount, status, failureReason: failure, isSandbox: cb.isSandbox, occurredAt: cb.occurredAt, createdAt: cb.now,
  }).onConflictDoNothing().returning();
  if (row) return row;
  // Another request claimed it a moment ago.
  const [existing] = await db.select().from(V).where(and(eq(V.network, cb.network), eq(V.networkTransactionId, cb.networkTransactionId))).limit(1);
  if (existing) return existing;
  const [byClient] = await db.select().from(V).where(and(eq(V.projectId, cb.projectId), eq(V.clientTransactionId, cb.clientTransactionId))).limit(1);
  return byClient!;
}

class GrantError extends Error {}

async function grant(db: DB, rule: typeof schema.adRewardRules.$inferSelect, row: Row, customer: CustomerRow, appUserId: string, cb: RewardCallback): Promise<SdkReward[]> {
  if (rule.kind === "virtual_currency") {
    const code = rule.currencyCode ?? "";
    const [cur] = await db.select().from(schema.virtualCurrencies).where(and(eq(schema.virtualCurrencies.projectId, cb.projectId), eq(schema.virtualCurrencies.code, code))).limit(1);
    if (!cur || cur.state !== "active") throw new GrantError(`In-app currency ${code} does not exist.`);
    const amount = ruleCurrencyAmount(rule, cb.rewardAmount);
    if (amount <= 0) return [];
    const ledgerId = await adjust(db, cb.projectId, customer.id, code, amount, { source: "ad_reward", sourceKey: row.id, reference: `${cb.network}:${cb.networkTransactionId}`.slice(0, 200), now: cb.now });
    if (ledgerId) {
      await recordRawEvent(db, {
        projectId: cb.projectId, appId: cb.app?.id ?? null, customer, appUserId, type: "VIRTUAL_CURRENCY_TRANSACTION", sandbox: cb.isSandbox, now: cb.now,
        fields: {
          adjustments: [{ amount, currency: { code: cur.code, description: cur.description, name: cur.name } }],
          product_display_name: null, product_id: null, purchase_environment: cb.isSandbox ? "SANDBOX" : "PRODUCTION",
          // RevenueDot extension: RevenueCat documents no source value for rewarded ads.
          source: "ad_reward", store: null, transaction_id: cb.networkTransactionId, virtual_currency_transaction_id: `vatx${ledgerId.slice(4)}`,
        },
      });
    }
    return [{ type: "virtual_currency", code, amount }];
  }
  if (rule.kind === "entitlement") {
    const key = rule.entitlementId ?? "";
    const [ent] = await db.select().from(schema.entitlements).where(and(eq(schema.entitlements.projectId, cb.projectId), eq(schema.entitlements.lookupKey, key))).limit(1);
    if (!ent) throw new GrantError(`Entitlement ${key} does not exist.`);
    const minutes = Math.min(525_600, Math.max(1, rule.durationMinutes ?? 60));
    const storeKey = `adr_${row.id}`;
    const [existing] = await db.select().from(schema.subscriptions).where(and(eq(schema.subscriptions.projectId, cb.projectId), eq(schema.subscriptions.store, "promotional"), eq(schema.subscriptions.storeKey, storeKey))).limit(1);
    const start = existing?.purchaseDate ?? cb.now;
    const end = existing?.expiresDate ?? new Date(start.getTime() + minutes * 60_000);
    if (!existing) {
      await applyPurchases(db, customer, [{
        kind: "subscription", store: "promotional", storeKey, productIdentifier: `rc_promo_${ent.lookupKey}_ad_reward`, isSandbox: cb.isSandbox,
        purchaseDate: start, originalPurchaseDate: start, expiresDate: end, periodType: "promotional", storeTransactionId: storeKey,
      }], { projectId: cb.projectId, appId: null, appUserId, now: cb.now, fromDevice: false });
      await db.update(schema.subscriptions).set({ entitlementIdentifier: ent.lookupKey })
        .where(and(eq(schema.subscriptions.projectId, cb.projectId), eq(schema.subscriptions.store, "promotional"), eq(schema.subscriptions.storeKey, storeKey)));
    }
    return [{ type: "entitlement", identifier: ent.lookupKey, expires_at: isoSeconds(end) }];
  }
  throw new GrantError(`Unknown reward kind ${rule.kind}.`);
}

/**
 * The SDK's poll: `pending` until the network's callback is recorded (or while it is being granted), then `verified`
 * with the rewards or `failed`. A verification that belongs to another customer answers `failed` (`user_mismatch`).
 */
export async function pollReward(db: DB, projectId: string, appUserId: string, clientTransactionId: string) {
  const [row] = await db.select().from(V).where(and(eq(V.projectId, projectId), eq(V.clientTransactionId, clientTransactionId))).limit(1);
  if (!row || row.status === "granting") return rewardAnswer(null);
  if (row.status === "verified" && row.customerId) {
    const cust = await findCustomer(db, projectId, appUserId);
    if (!cust || cust.id !== row.customerId) return rewardAnswer({ status: "failed", rewards: [], failureReason: "user_mismatch" });
  }
  return rewardAnswer({ status: row.status, rewards: row.rewards, failureReason: row.failureReason });
}

export function verificationShape(r: Row) {
  return {
    object: "ad_reward_verification" as const, id: r.id, app_id: r.appId, app_user_id: r.appUserId, client_transaction_id: r.clientTransactionId,
    network: r.network, network_transaction_id: r.networkTransactionId, ad_unit_id: r.adUnitId, impression_id: r.impressionId,
    reward_item: r.rewardItem, reward_amount: r.rewardAmount, status: r.status === "granting" ? "pending" : r.status, failure_reason: r.failureReason,
    failure_message: r.failureReason ? FAILURE_MESSAGES[r.failureReason] ?? null : null, rule_id: r.ruleId, rewards: r.rewards, is_sandbox: r.isSandbox,
    occurred_at: r.occurredAt.getTime(), created_at: r.createdAt.getTime(),
  };
}
