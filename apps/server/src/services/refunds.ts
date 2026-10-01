import { and, asc, desc, eq, gte, isNull, lte, or } from "drizzle-orm";
import { newId } from "@revenuedot/core";
import { schema, type DB } from "@revenuedot/db";
import type { AppRecord } from "../context.js";
import { findCustomer, type CustomerRow } from "../repo/customers.js";
import { appleApiFor } from "../stores/apple/index.js";
import { AppleApiClientError, type AppleEnv } from "../stores/apple/api.js";
import type { AppleTransaction } from "../stores/apple/map.js";
import type { StoreAdapter } from "../stores/types.js";
import { contextsFor, type CustomerData } from "./customer-context.js";
import { usdValue } from "./fx.js";
import { emptyContext, rulesMatch, type CustomerContext, type Rules } from "./targeting.js";

/**
 * Refund Control (prd/lifecycle/PRD.md): policies decide how RevenueDot answers Apple's CONSUMPTION_REQUEST, with the
 * App Store Server API's Send Consumption Information V1 and the app's In-App Purchase key, inside Apple's 12-hour window.
 * Every refund we learn of (Apple REFUND or REFUND_DECLINED, Google voided purchases, Stripe and Amazon refunds) is a row in
 * `refund_requests`, which feeds the Refund Control cards.
 */

export const PREFERENCES = ["prefer_refund", "prefer_no_refund", "consumption_only", "do_not_respond"] as const;
export type Preference = (typeof PREFERENCES)[number];
export const TEMPLATES = ["first_purchase_date", "platform", "recent_renewal", "custom"] as const;

/** The conditions each template starts with (the dashboard's "Add policy" cards). */
export const TEMPLATE_RULES: Record<(typeof TEMPLATES)[number], Rules> = {
  first_purchase_date: { groups: [{ conditions: [{ field: "firstPurchaseAt", operator: "within", value: "7d" }] }] },
  platform: { groups: [{ conditions: [{ field: "platform", operator: "isAnyOf", value: "ios" }] }] },
  recent_renewal: { groups: [{ conditions: [{ field: "lastRenewalAt", operator: "within", value: "24h" }] }] },
  custom: { groups: [] },
};

export const APPLE_WINDOW_MS = 12 * 3600_000;
/** Stop retrying this long before Apple's deadline. */
const DEADLINE_MARGIN_MS = 5 * 60_000;
const RETRY_STEPS_MS = [5 * 60_000, 15 * 60_000, 3600_000];

export interface PolicyRow { id: string; name: string; rules: Rules; preference: string; position: number }
export interface Decision { policyId: string | null; policyName: string; preference: Preference }

export interface RefundSettings { default_preference: Preference; customer_consented: boolean }
export function settingsOf(raw: Record<string, unknown> | null | undefined): RefundSettings {
  const pref = raw?.default_preference as Preference | undefined;
  return { default_preference: pref && PREFERENCES.includes(pref) ? pref : "do_not_respond", customer_consented: raw?.customer_consented === true };
}

/** The first policy (by position) whose rules match decides; none matching uses the default. A policy with no conditions matches everyone. */
export function choosePolicy(policies: PolicyRow[], ctx: CustomerContext, now: number, defaultPreference: Preference): Decision {
  for (const p of [...policies].sort((a, b) => a.position - b.position)) {
    if (rulesMatch(ctx, p.rules, now)) return { policyId: p.id, policyName: p.name, preference: p.preference as Preference };
  }
  return { policyId: null, policyName: "Default policy", preference: defaultPreference };
}

// ---------- Apple's ConsumptionRequestV1 ----------

export interface ConsumptionRequestV1 {
  accountTenure: number; appAccountToken: string; consumptionStatus: number; customerConsented: boolean; deliveryStatus: number;
  lifetimeDollarsPurchased: number; lifetimeDollarsRefunded: number; platform: number; playTime: number; refundPreference: number;
  sampleContentProvided: boolean; userStatus: number;
}

/** What the payload is computed from; every field comes from RevenueDot's own records (see buildConsumptionRequest). */
export interface ConsumptionInput {
  now: number;
  customerConsented: boolean;
  preference: Exclude<Preference, "do_not_respond">;
  appAccountToken: string | null;
  productType: "subscription" | "non_consumable" | "consumable" | "non_renewing_subscription";
  purchasedAt: number;
  expiresAt: number | null;
  /** Null when the customer is unknown to RevenueDot. */
  customer: null | {
    firstSeenAt: number; lastSeenAt: number; platform: string | null;
    lifetimePurchasedUsd: number; lifetimeRefundedUsd: number; hadFreeTrial: boolean;
    /** Consumables that grant an in-app currency: what the purchase granted and what is left. */
    currency?: { granted: number; balance: number } | null;
    attributes: Record<string, string | null>;
  };
}

const DAY = 86_400_000;
/** Apple's accountTenure buckets: 0–3, 3–10, 10–30, 30–90, 90–180, 180–365 days, then over 365. */
export function tenureBucket(ms: number): number {
  const d = ms / DAY;
  return d < 3 ? 1 : d < 10 ? 2 : d < 30 ? 3 : d < 90 ? 4 : d < 180 ? 5 : d < 365 ? 6 : 7;
}
/** Apple's dollar buckets: 0, 0.01–49.99, 50–99.99, 100–499.99, 500–999.99, 1000–1999.99, then over 2000. */
export function dollarsBucket(usd: number): number {
  return usd <= 0 ? 1 : usd < 50 ? 2 : usd < 100 ? 3 : usd < 500 ? 4 : usd < 1000 ? 5 : usd < 2000 ? 6 : 7;
}
/** Apple's playTime buckets: 0–5 min, 5–60 min, 1–6 h, 6–24 h, 1–4 days, 4–16 days, then over 16 days. */
export function playTimeBucket(minutes: number): number {
  return minutes < 5 ? 1 : minutes < 60 ? 2 : minutes < 360 ? 3 : minutes < 1440 ? 4 : minutes < 4 * 1440 ? 5 : minutes < 16 * 1440 ? 6 : 7;
}
const APPLE_PLATFORMS = new Set(["ios", "ipados", "macos", "tvos", "watchos", "visionos", "mac", "catalyst"]);
const USER_STATUS: Record<string, number> = { active: 1, suspended: 2, terminated: 3, limited: 4 };

export function buildConsumptionRequest(i: ConsumptionInput): ConsumptionRequestV1 {
  const c = i.customer;
  const usedAfterPurchase = !!c && c.lastSeenAt > i.purchasedAt + 60_000;
  let consumptionStatus = 0;
  if (i.productType === "subscription" || i.productType === "non_renewing_subscription") {
    consumptionStatus = i.expiresAt !== null && i.now >= i.expiresAt ? 3 : usedAfterPurchase ? 2 : c ? 1 : 0;
  } else if (i.productType === "non_consumable") {
    consumptionStatus = usedAfterPurchase ? 2 : c ? 1 : 0;
  } else if (c?.currency) {
    consumptionStatus = c.currency.balance <= 0 ? 3 : c.currency.balance < c.currency.granted ? 2 : 1;
  }
  const platform = c?.platform ? (APPLE_PLATFORMS.has(c.platform.toLowerCase()) ? 1 : 2) : 0;
  const minutes = Number(c?.attributes.rd_play_time_minutes);
  const status = c?.attributes.rd_user_status?.toLowerCase();
  return {
    accountTenure: c ? tenureBucket(i.now - c.firstSeenAt) : 0,
    appAccountToken: i.appAccountToken ?? "",
    consumptionStatus,
    customerConsented: i.customerConsented,
    deliveryStatus: 0,
    lifetimeDollarsPurchased: c ? dollarsBucket(c.lifetimePurchasedUsd) : 0,
    lifetimeDollarsRefunded: c ? dollarsBucket(c.lifetimeRefundedUsd) : 0,
    platform,
    playTime: c && c.attributes.rd_play_time_minutes != null && Number.isFinite(minutes) && minutes >= 0 ? playTimeBucket(minutes) : 0,
    refundPreference: i.preference === "prefer_refund" ? 1 : i.preference === "prefer_no_refund" ? 2 : 0,
    sampleContentProvided: !!c?.hadFreeTrial,
    userStatus: status && USER_STATUS[status] ? USER_STATUS[status]! : c ? 1 : 0,
  };
}

// ---------- Loading what the payload needs ----------

const PRODUCT_TYPE: Record<string, ConsumptionInput["productType"]> = {
  "Auto-Renewable Subscription": "subscription", "Non-Consumable": "non_consumable", Consumable: "consumable", "Non-Renewing Subscription": "non_renewing_subscription",
};

async function customerFor(db: DB, projectId: string, store: string, tx: { transactionId: string; originalTransactionId: string; appAccountToken?: string }): Promise<CustomerRow | null> {
  const [sub] = await db.select({ c: schema.subscriptions.customerId }).from(schema.subscriptions)
    .where(and(eq(schema.subscriptions.projectId, projectId), eq(schema.subscriptions.store, store), eq(schema.subscriptions.storeKey, tx.originalTransactionId))).limit(1);
  const [one] = sub ? [] : await db.select({ c: schema.nonSubscriptions.customerId }).from(schema.nonSubscriptions)
    .where(and(eq(schema.nonSubscriptions.projectId, projectId), eq(schema.nonSubscriptions.store, store), eq(schema.nonSubscriptions.storeTransactionId, tx.transactionId))).limit(1);
  const id = sub?.c ?? one?.c;
  if (id) {
    const [c] = await db.select().from(schema.customers).where(eq(schema.customers.id, id)).limit(1);
    if (c) return c;
  }
  return tx.appAccountToken ? findCustomer(db, projectId, tx.appAccountToken) : null;
}

/** Customer facts for the payload, in the request's environment (sandbox requests count sandbox purchases). */
async function customerFacts(db: DB, projectId: string, appId: string, d: CustomerData, productId: string, sandbox: boolean): Promise<NonNullable<ConsumptionInput["customer"]>> {
  const tx = d.tx.filter((t) => t.sandbox === sandbox);
  const purchased = tx.filter((t) => t.usd > 0).reduce((s, t) => s + t.usd, 0);
  const refunded = -tx.filter((t) => t.kind === "refund").reduce((s, t) => s + t.usd, 0);
  let currency: { granted: number; balance: number } | null = null;
  const [prod] = await db.select().from(schema.products).where(and(eq(schema.products.projectId, projectId), eq(schema.products.appId, appId), eq(schema.products.storeIdentifier, productId))).limit(1);
  if (prod) {
    const vcs = await db.select().from(schema.virtualCurrencies).where(eq(schema.virtualCurrencies.projectId, projectId));
    for (const vc of vcs) {
      const grant = vc.productGrants.find((g) => g.product_ids.includes(prod.id));
      if (!grant) continue;
      const [bal] = await db.select().from(schema.virtualCurrencyBalances).where(and(eq(schema.virtualCurrencyBalances.customerId, d.customer.id), eq(schema.virtualCurrencyBalances.code, vc.code))).limit(1);
      currency = { granted: grant.amount, balance: bal?.balance ?? 0 };
      break;
    }
  }
  return {
    firstSeenAt: d.customer.firstSeen.getTime(), lastSeenAt: d.customer.lastSeen.getTime(), platform: d.customer.lastSeenPlatform,
    lifetimePurchasedUsd: Math.round(purchased * 100) / 100, lifetimeRefundedUsd: Math.round(refunded * 100) / 100,
    hadFreeTrial: tx.some((t) => t.kind === "trial" && t.product === productId) || d.subs.some((s) => s.productIdentifier === productId && s.offerType === "free_trial"),
    currency, attributes: d.attributes,
  };
}

async function policiesOf(db: DB, projectId: string): Promise<PolicyRow[]> {
  const rows = await db.select().from(schema.refundPolicies).where(eq(schema.refundPolicies.projectId, projectId)).orderBy(asc(schema.refundPolicies.position));
  return rows.map((r) => ({ id: r.id, name: r.name, rules: r.rules as Rules, preference: r.preference, position: r.position }));
}

async function settingsFor(db: DB, projectId: string): Promise<RefundSettings> {
  const [p] = await db.select({ s: schema.projects.refundSettings }).from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1);
  return settingsOf(p?.s ?? null);
}

/** The policy decision for one customer (or an unknown one). */
export async function decide(db: DB, projectId: string, customer: CustomerRow | null, now: Date): Promise<{ decision: Decision; data: CustomerData | null }> {
  const settings = await settingsFor(db, projectId);
  const loaded = customer ? (await contextsFor(db, projectId, [customer], now))[0]! : null;
  const decision = choosePolicy(await policiesOf(db, projectId), loaded?.ctx ?? emptyContext(), now.getTime(), settings.default_preference);
  return { decision, data: loaded?.data ?? null };
}

// ---------- CONSUMPTION_REQUEST ----------

export interface RefundDeps { db: DB; stores: Record<string, StoreAdapter>; fetch?: typeof fetch; now: () => Date }

/**
 * Apple asks for consumption information: record the request, pick the policy and answer at once. A repeated notification
 * for the same transaction is a no-op once an answer went out (or was deliberately skipped).
 */
export async function handleConsumptionRequest(deps: RefundDeps, app: AppRecord, tx: AppleTransaction, n: { signedDate?: number; reason?: string | null }): Promise<typeof schema.refundRequests.$inferSelect> {
  const { db } = deps;
  const now = deps.now();
  const store = app.type === "mac_app_store" ? "mac_app_store" : "app_store";
  const sandbox = tx.environment !== "Production";
  const requestedAt = new Date(n.signedDate ?? now.getTime());
  const [existing] = await db.select().from(schema.refundRequests)
    .where(and(eq(schema.refundRequests.projectId, app.projectId), eq(schema.refundRequests.store, store), eq(schema.refundRequests.transactionId, tx.transactionId))).limit(1);
  if (existing && existing.consumptionStatus !== "pending" && existing.consumptionStatus !== "failed") return existing;

  const customer = await customerFor(db, app.projectId, store, tx);
  const { decision, data } = await decide(db, app.projectId, customer, now);
  const settings = await settingsFor(db, app.projectId);
  const amountUsd = tx.price != null && tx.currency ? await usdValue(db, { amount: tx.price / 1000, currency: tx.currency }, new Date(tx.purchaseDate), deps.fetch ?? null) : null;
  let consumptionStatus = "pending";
  let consumption: Record<string, unknown> | null = null;
  let lastError: string | null = null;
  if (decision.preference === "do_not_respond") { consumptionStatus = "skipped"; lastError = "The policy says not to respond."; }
  else if (!settings.customer_consented) { consumptionStatus = "skipped"; lastError = "Customer consent is not confirmed in Refund Control settings, so Apple gets no consumption information."; }
  else if (tx.environment !== "Production" && tx.environment !== "Sandbox") { consumptionStatus = "skipped"; lastError = `Apple's ${tx.environment} environment has no App Store Server API.`; }
  else {
    const facts = data ? await customerFacts(db, app.projectId, app.id, data, tx.productId, sandbox) : null;
    consumption = buildConsumptionRequest({
      now: now.getTime(), customerConsented: true, preference: decision.preference, appAccountToken: tx.appAccountToken ?? null,
      productType: PRODUCT_TYPE[tx.type] ?? "subscription", purchasedAt: tx.purchaseDate, expiresAt: tx.expiresDate ?? null, customer: facts,
    }) as unknown as Record<string, unknown>;
  }
  const values = {
    projectId: app.projectId, appId: app.id, customerId: customer?.id ?? null,
    appUserId: data ? data.aliases.find((a) => !a.startsWith("$RCAnonymousID:")) ?? data.customer.originalAppUserId : tx.appAccountToken ?? null,
    store, isSandbox: sandbox, transactionId: tx.transactionId, originalTransactionId: tx.originalTransactionId, productId: tx.productId, amountUsd,
    reason: n.reason ?? null, requestedAt, deadlineAt: new Date(requestedAt.getTime() + APPLE_WINDOW_MS),
    policyId: decision.policyId, policyName: decision.policyName, preference: decision.preference,
    consumptionStatus, consumption, lastError, nextAttemptAt: consumptionStatus === "pending" ? now : null,
  };
  let row: typeof schema.refundRequests.$inferSelect;
  if (existing) [row] = await db.update(schema.refundRequests).set(values).where(eq(schema.refundRequests.id, existing.id)).returning() as [typeof row];
  else [row] = await db.insert(schema.refundRequests).values({ id: newId("rfq_", 16), ...values, createdAt: now }).returning() as [typeof row];
  if (row.consumptionStatus === "pending") row = await sendConsumption(deps, row, app);
  return row;
}

/** One attempt to send the stored payload; failures back off (5 min, 15 min, then hourly) until just before the deadline. */
export async function sendConsumption(deps: RefundDeps, row: typeof schema.refundRequests.$inferSelect, appRow?: AppRecord): Promise<typeof schema.refundRequests.$inferSelect> {
  const { db } = deps;
  const now = deps.now();
  const update = async (set: Partial<typeof schema.refundRequests.$inferInsert>) =>
    (await db.update(schema.refundRequests).set(set).where(eq(schema.refundRequests.id, row.id)).returning())[0]!;
  if (row.deadlineAt && now.getTime() > row.deadlineAt.getTime() - DEADLINE_MARGIN_MS) {
    return update({ consumptionStatus: "expired", nextAttemptAt: null, lastError: row.lastError ?? "Apple's 12-hour window closed before an answer went out." });
  }
  const [app] = appRow ? [appRow] : await db.select().from(schema.apps).where(eq(schema.apps.id, row.appId ?? "")).limit(1);
  if (!app || !row.consumption) return update({ consumptionStatus: "failed", nextAttemptAt: null, lastError: "The app or the payload is gone." });
  const attempts = row.attempts + 1;
  let api: ReturnType<typeof appleApiFor> = null;
  try { api = appleApiFor(deps.stores, app, deps.fetch, deps.now); } catch { /* an incomplete key is reported below */ }
  if (!api) return update({ consumptionStatus: "failed", attempts, nextAttemptAt: null, lastError: "The app has no App Store In-App Purchase key, so RevenueDot cannot call the App Store Server API." });
  const env: AppleEnv = row.isSandbox ? "sandbox" : "production";
  try {
    const res = await api.sendConsumptionInformation(env, row.transactionId, row.consumption);
    if (res === null) return update({ consumptionStatus: "failed", attempts, nextAttemptAt: null, lastError: "Apple does not know this transaction (404)." });
    return update({ consumptionStatus: "sent", attempts, sentAt: now, nextAttemptAt: null, lastError: null });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Apple refuses the request itself (4xx other than 401/404/429): retrying cannot help.
    if (e instanceof AppleApiClientError) return update({ consumptionStatus: "failed", attempts, nextAttemptAt: null, lastError: message });
    const wait = RETRY_STEPS_MS[Math.min(attempts - 1, RETRY_STEPS_MS.length - 1)]!;
    const next = new Date(now.getTime() + wait);
    const lastChance = row.deadlineAt ? new Date(row.deadlineAt.getTime() - DEADLINE_MARGIN_MS) : next;
    if (next > lastChance && now >= lastChance) return update({ consumptionStatus: "expired", attempts, nextAttemptAt: null, lastError: message });
    return update({ consumptionStatus: "pending", attempts, nextAttemptAt: next > lastChance ? lastChance : next, lastError: message });
  }
}

/** The tick: retry answers that failed for a passing reason, and close the ones whose window ended. */
export async function retryDueConsumption(deps: RefundDeps): Promise<number> {
  const now = deps.now();
  const due = await deps.db.select().from(schema.refundRequests)
    .where(and(eq(schema.refundRequests.consumptionStatus, "pending"), or(isNull(schema.refundRequests.nextAttemptAt), lte(schema.refundRequests.nextAttemptAt, now)))).limit(50);
  for (const r of due) await sendConsumption(deps, r);
  return due.length;
}

// ---------- Outcomes ----------

/**
 * A refund went through (any store). Apple: the matching request is approved, or an approved request is recorded when Apple
 * never asked. Google, Stripe and Amazon: recorded approved, with the policy that would apply and nothing to answer.
 */
export async function noteRefund(db: DB, o: { projectId: string; appId: string | null; customerId: string; store: string; transactionId: string; originalTransactionId?: string | null; productId: string; sandbox: boolean; amountUsd: number | null; at: Date; now: Date }) {
  const rr = schema.refundRequests;
  const apple = o.store === "app_store" || o.store === "mac_app_store";
  const pending = await db.select().from(rr).where(and(eq(rr.projectId, o.projectId), eq(rr.store, o.store),
    o.originalTransactionId ? or(eq(rr.transactionId, o.transactionId), and(eq(rr.originalTransactionId, o.originalTransactionId), eq(rr.outcome, "pending"))) : eq(rr.transactionId, o.transactionId)))
    .orderBy(desc(rr.requestedAt)).limit(1);
  if (pending[0]) {
    if (pending[0].outcome !== "approved") await db.update(rr).set({ outcome: "approved", outcomeAt: o.at }).where(eq(rr.id, pending[0].id));
    return;
  }
  const [customer] = await db.select().from(schema.customers).where(eq(schema.customers.id, o.customerId)).limit(1);
  const { decision, data } = await decide(db, o.projectId, customer ?? null, o.now);
  await db.insert(rr).values({
    id: newId("rfq_", 16), projectId: o.projectId, appId: o.appId, customerId: o.customerId,
    appUserId: data ? data.aliases.find((a) => !a.startsWith("$RCAnonymousID:")) ?? data.customer.originalAppUserId : null,
    store: o.store, isSandbox: o.sandbox, transactionId: o.transactionId, originalTransactionId: o.originalTransactionId ?? null, productId: o.productId,
    amountUsd: o.amountUsd, reason: apple ? null : o.store === "play_store" ? "Voided purchase or chargeback" : "Refunded in the store", requestedAt: o.at,
    policyId: decision.policyId, policyName: decision.policyName, preference: decision.preference,
    consumptionStatus: apple ? "not_requested" : "not_applicable", outcome: "approved", outcomeAt: o.at, createdAt: o.now,
  }).onConflictDoNothing();
}

/** Apple REFUND for a transaction with a refund request: approved (whether or not the refund changes the customer's access). */
export async function noteAppleRefund(db: DB, projectId: string, store: string, transactionId: string, at: Date) {
  const rr = schema.refundRequests;
  await db.update(rr).set({ outcome: "approved", outcomeAt: at }).where(and(eq(rr.projectId, projectId), eq(rr.store, store), eq(rr.transactionId, transactionId), eq(rr.outcome, "pending")));
}

/** Apple REFUND_DECLINED: the request is declined (recorded even if the CONSUMPTION_REQUEST never reached us). */
export async function noteRefundDeclined(deps: RefundDeps, app: AppRecord, tx: AppleTransaction, at: Date) {
  const { db } = deps;
  const store = app.type === "mac_app_store" ? "mac_app_store" : "app_store";
  const rr = schema.refundRequests;
  const [row] = await db.select().from(rr).where(and(eq(rr.projectId, app.projectId), eq(rr.store, store), eq(rr.transactionId, tx.transactionId))).limit(1);
  if (row) { await db.update(rr).set({ outcome: "declined", outcomeAt: at }).where(eq(rr.id, row.id)); return; }
  const customer = await customerFor(db, app.projectId, store, tx);
  const { decision, data } = await decide(db, app.projectId, customer, deps.now());
  const amountUsd = tx.price != null && tx.currency ? await usdValue(db, { amount: tx.price / 1000, currency: tx.currency }, new Date(tx.purchaseDate), deps.fetch ?? null) : null;
  await db.insert(rr).values({
    id: newId("rfq_", 16), projectId: app.projectId, appId: app.id, customerId: customer?.id ?? null,
    appUserId: data ? data.aliases.find((a) => !a.startsWith("$RCAnonymousID:")) ?? data.customer.originalAppUserId : null,
    store, isSandbox: tx.environment !== "Production", transactionId: tx.transactionId, originalTransactionId: tx.originalTransactionId, productId: tx.productId, amountUsd,
    requestedAt: at, policyId: decision.policyId, policyName: decision.policyName, preference: decision.preference,
    consumptionStatus: "not_requested", outcome: "declined", outcomeAt: at, createdAt: deps.now(),
  }).onConflictDoNothing();
}

// ---------- Cards ----------

export async function refundStats(db: DB, projectId: string, o: { days: number; sandbox: boolean; now: Date }) {
  const since = new Date(o.now.getTime() - o.days * DAY);
  const rows = await db.select().from(schema.refundRequests)
    .where(and(eq(schema.refundRequests.projectId, projectId), eq(schema.refundRequests.isSandbox, o.sandbox), gte(schema.refundRequests.requestedAt, since)));
  const by = (k: string) => rows.filter((r) => r.outcome === k);
  const sum = (rs: typeof rows) => Math.round(rs.reduce((s, r) => s + (r.amountUsd ?? 0), 0) * 100) / 100;
  const approved = by("approved"), declined = by("declined"), pending = by("pending");
  const decided = approved.length + declined.length;
  const consumption: Record<string, number> = {};
  for (const r of rows) consumption[r.consumptionStatus] = (consumption[r.consumptionStatus] ?? 0) + 1;
  return {
    object: "refund_control_stats" as const, days: o.days, environment: o.sandbox ? "sandbox" : "production",
    refund_rate: decided ? Math.round((approved.length / decided) * 1000) / 1000 : null,
    requests: { approved: approved.length, declined: declined.length, pending: pending.length, total: rows.length },
    amount_in_usd: { approved: sum(approved), declined: sum(declined), pending: sum(pending) },
    consumption,
  };
}

/** Customers each policy would decide for (first match wins, like a real request), over the most recently seen customers. */
export function policyCounts(policies: PolicyRow[], contexts: CustomerContext[], now: number): { byPolicy: Record<string, number>; default: number } {
  const byPolicy: Record<string, number> = Object.fromEntries(policies.map((p) => [p.id, 0]));
  let rest = 0;
  for (const ctx of contexts) {
    const d = choosePolicy(policies, ctx, now, "do_not_respond");
    if (d.policyId) byPolicy[d.policyId]!++; else rest++;
  }
  return { byPolicy, default: rest };
}
