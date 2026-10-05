import { and, asc, eq, gte, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";
import { trySend, type Mailer } from "../../mail/index.js";
import { billingPaymentEmail } from "../../mail/templates.js";
import { BillingStripeError, type billingStripe } from "./stripe.js";

/**
 * Stripe events of RevenueDot's own account (prd/cloud-billing/PRD.md, "Stripe is the source of truth"). Stripe delivers
 * events at least once and in no set order, so an event only says which customer changed: the handler then reads that
 * customer's subscriptions and invoice from Stripe, under a per-customer lock, and writes what Stripe says now. A late,
 * repeated, concurrent or out-of-order event therefore always ends in the current state. Payment emails follow the
 * invoice's real status, once per invoice, and go out after the database commit.
 * Nothing here changes how a customer's apps work: the SDK, purchases and entitlements never depend on the plan. Losing Pro
 * only brings back the go-live gate (gate.ts) for live accounts: live data and outbound deliveries pause.
 */

const A = schema.billingAccounts;
type Obj = Record<string, any>;
type Stripe = ReturnType<typeof billingStripe>;
type Account = typeof A.$inferSelect;
export interface BillingWebhookDeps { db: DB; now: Date; stripe: Stripe; mailer?: Mailer; publicUrl?: string }

/** System rows in billing_notices (no user): hourly gates and rate limits, claimed with an insert that wins once. */
export const SYSTEM_USER = "__billing__";

const ts = (s: unknown) => (typeof s === "number" && s > 0 ? new Date(s * 1000) : null);
const LIVE = ["active", "trialing", "past_due", "unpaid", "incomplete", "paused"];
/** Statuses that bill the meter: a second one of these on the same customer would bill the same usage twice. */
const BILLING = ["active", "trialing", "past_due"];

/** Stripe's subscription status as the account's plan and status. */
export function statusOf(stripeStatus: string): { status: string; plan: "pro" | "none" } {
  switch (stripeStatus) {
    case "active": case "trialing": return { status: "active", plan: "pro" };
    case "past_due": return { status: "past_due", plan: "pro" };
    case "unpaid": return { status: "unpaid", plan: "none" };
    case "incomplete": return { status: "incomplete", plan: "none" };
    case "paused": return { status: "paused", plan: "none" };
    default: return { status: "canceled", plan: "none" };
  }
}

/**
 * The subscription that decides the account. A paying one (active, trialing, past due) wins over one that is not (unpaid,
 * incomplete from an abandoned Checkout, paused). Among paying ones: one that is not set to end, then active over past
 * due, then the one on file, then the oldest (ties by id). Without a paying one: the live one on file, else the oldest live,
 * else the newest ended. Other paying subscriptions are duplicates.
 */
export function currentSubscription(subs: Obj[], onFile: string | null | undefined): { current: Obj | null; duplicates: Obj[] } {
  const byAge = (a: Obj, b: Obj) => (a.created ?? 0) - (b.created ?? 0) || String(a.id).localeCompare(String(b.id));
  const live = subs.filter((s) => LIVE.includes(s.status)).sort(byAge);
  const ending = (s: Obj) => (s.cancel_at_period_end || s.cancel_at ? 1 : 0);
  const billing = live.filter((s) => BILLING.includes(s.status)).sort((a, b) =>
    ending(a) - ending(b) || (a.status === "past_due" ? 1 : 0) - (b.status === "past_due" ? 1 : 0)
    || (b.id === onFile ? 1 : 0) - (a.id === onFile ? 1 : 0) || byAge(a, b));
  const current = billing[0] ?? live.find((s) => s.id === onFile) ?? live[0]
    ?? [...subs].sort((a, b) => byAge(b, a))[0] ?? null;
  const duplicates = current && BILLING.includes(current.status) ? billing.filter((s) => s.id !== current.id) : [];
  return { current, duplicates };
}

async function accountFor(db: DB, customer: unknown, userId?: unknown): Promise<Account | null> {
  if (typeof customer === "string" && customer) {
    const [a] = await db.select().from(A).where(eq(A.stripeCustomerId, customer));
    if (a) return a;
  }
  if (typeof userId === "string" && userId) {
    const [a] = await db.select().from(A).where(eq(A.userId, userId));
    if (a) return a;
  }
  return null;
}

/** Emails decided inside a transaction, sent after it commits (a rolled-back notice row never leaves a sent email behind). */
type Outbox = (() => Promise<unknown>)[];

async function notice(d: BillingWebhookDeps, out: Outbox, userId: string, key: string, kind: "failed" | "unpaid" | "recovered", amountCents: number, invoiceUrl?: string | null) {
  const [won] = await d.db.insert(schema.billingNotices).values({ userId, key, sentAt: d.now }).onConflictDoNothing().returning();
  if (!won) return;
  const [u] = await d.db.select().from(schema.users).where(eq(schema.users.id, userId));
  if (!u) return;
  const mail = billingPaymentEmail({ base: (d.publicUrl ?? "https://app.revenuedot.app").replace(/\/+$/, ""), kind, amount: amountCents / 100, invoiceUrl });
  out.push(() => trySend(d.mailer, { to: u.email, ...mail }));
}

/** Claims a system gate (an hourly reconcile, a sync rate limit). True once per key. */
export async function claim(db: DB, key: string, now: Date): Promise<boolean> {
  const [won] = await db.insert(schema.billingNotices).values({ userId: SYSTEM_USER, key, sentAt: now }).onConflictDoNothing().returning();
  return !!won;
}

/**
 * One customer at a time: a transaction holding an advisory lock on the customer, so concurrent webhooks never write a
 * stale read (whoever holds the lock last read Stripe last). A 10-second lock timeout keeps a stuck sync from piling up
 * connections; the waiting webhook then answers 500 and Stripe delivers it again. Emails go out after the commit.
 */
async function locked<T>(d: BillingWebhookDeps, customer: string, run: (d: BillingWebhookDeps, out: Outbox) => Promise<T>): Promise<T> {
  const out: Outbox = [];
  const result = await d.db.transaction(async (tx) => {
    await tx.execute(sql`set local lock_timeout = '10s'`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`billing:${customer}`}))`);
    return run({ ...d, db: tx as unknown as DB }, out);
  });
  for (const send of out) await send().catch((e) => console.error("billing: email failed", e));
  return result;
}

export interface SyncResult { userId: string; before: { plan: string; status: string }; after: { plan: string; status: string }; subscription: string | null; missing?: boolean; enterprise?: boolean }

/**
 * Reads the customer's subscriptions from Stripe and writes the account's plan, status, subscription, period end and end
 * date (only when something changed). Cancels a duplicate paying subscription. `userId` links a customer the account does
 * not know yet (Checkout). A customer Stripe no longer has (deleted, or from the other mode) leaves the account with no plan.
 */
export async function syncCustomer(d: BillingWebhookDeps, customer: string, userId?: string | null): Promise<SyncResult | null> {
  return locked(d, customer, (dd, out) => syncLocked(dd, out, customer, userId));
}

async function syncLocked(d: BillingWebhookDeps, out: Outbox, customer: string, userId?: string | null): Promise<SyncResult | null> {
  const { db, now } = d;
  let acct = await accountFor(db, customer, userId);
  if (!acct) {
    if (!userId) return null;
    const [user] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, userId));
    if (!user) return null;
    const [created] = await db.insert(A).values({ userId, stripeCustomerId: customer, createdAt: now, updatedAt: now }).onConflictDoUpdate({ target: A.userId, set: { stripeCustomerId: customer, updatedAt: now } }).returning();
    acct = created ?? null;
  }
  if (!acct) return null;
  const before = { plan: acct.plan, status: acct.status };
  // Enterprise is set by hand and billed by contract: Stripe never moves it.
  if (acct.plan === "enterprise") return { userId: acct.userId, before, after: before, subscription: acct.stripeSubscriptionId, enterprise: true };
  let subs: Obj[];
  try { subs = await d.stripe.listSubscriptions(customer); }
  catch (e) {
    if (!(e instanceof BillingStripeError && e.missing)) throw e;
    // Stripe has no such customer: nothing can bill it, so no plan; the next Checkout makes a new customer. The customer id is
    // kept, so a mistaken key (the other mode) heals itself on the next sync once the right key is back.
    console.error(`billing: Stripe has no customer ${customer} (account ${acct.userId}); leaving the account with no plan`);
    const changed = acct.plan !== "none" || acct.status !== "canceled";
    if (changed) {
      await db.update(A).set({ plan: "none", status: "canceled", cancelAt: null, updatedAt: now }).where(eq(A.userId, acct.userId));
      await db.update(schema.users).set({ plan: "none" }).where(eq(schema.users.id, acct.userId));
    }
    return { userId: acct.userId, before, after: { plan: "none", status: "canceled" }, subscription: null, missing: true };
  }
  const { current, duplicates } = currentSubscription(subs, acct.stripeSubscriptionId);
  for (const dup of duplicates) {
    try { await d.stripe.cancelSubscription(dup.id); console.warn(`billing: cancelled duplicate subscription ${dup.id} of ${customer} (kept ${current?.id})`); }
    catch (e) { console.error(`billing: DUPLICATE subscription ${dup.id} of ${customer} could not be cancelled; it bills the meter twice`, e); }
  }
  // A customer with no subscription at all: Checkout started but not finished. Nothing to change.
  if (!current) return { userId: acct.userId, before, after: before, subscription: null };
  const s = statusOf(String(current.status));
  const item = current.items?.data?.[0];
  const periodEnd = ts(item?.current_period_end) ?? ts(current.current_period_end);
  const cancelAt = s.status === "canceled" ? null : ts(current.cancel_at) ?? (current.cancel_at_period_end ? periodEnd : null);
  const same = (a: Date | null, b: Date | null) => (a?.getTime() ?? null) === (b?.getTime() ?? null);
  const changed = acct.plan !== s.plan || acct.status !== s.status || acct.stripeCustomerId !== customer || acct.stripeSubscriptionId !== current.id
    || !same(acct.currentPeriodEnd, periodEnd) || !same(acct.cancelAt, cancelAt);
  // Only a real change touches the row, so a settled account leaves the reconcile set after 7 days.
  if (changed) {
    await db.update(A).set({ plan: s.plan, status: s.status, stripeCustomerId: customer, stripeSubscriptionId: current.id, currentPeriodEnd: periodEnd, cancelAt, updatedAt: now,
      ...(s.plan === "pro" && !acct.standardStartedAt ? { standardStartedAt: now } : {}) }).where(eq(A.userId, acct.userId));
    await db.update(schema.users).set({ plan: s.plan }).where(eq(schema.users.id, acct.userId));
  }
  // Past due or unpaid: the latest invoice from Stripe too, so its row and emails are right even if invoice webhooks were lost.
  const latest = typeof current.latest_invoice === "string" ? current.latest_invoice : current.latest_invoice?.id ?? null;
  let inv: InvoiceRow | null = null;
  if (latest && (s.status === "past_due" || s.status === "unpaid")) inv = await upsertInvoice(d, out, acct.userId, await d.stripe.getInvoice(latest));
  if (s.status === "unpaid" && before.status !== "unpaid") {
    await notice(d, out, acct.userId, `unpaid:${current.id}:${latest ?? ""}`, "unpaid", inv ? inv.amountDue - inv.amountPaid : 0, inv?.hostedInvoiceUrl);
  }
  return { userId: acct.userId, before, after: { plan: s.plan, status: s.status }, subscription: current.id };
}

type InvoiceRow = { amountDue: number; amountPaid: number; hostedInvoiceUrl: string | null; status: string };

/** Writes an invoice as Stripe has it and sends its emails: failed while open after an attempt; recovered once paid, only after a failed one. */
async function upsertInvoice(d: BillingWebhookDeps, out: Outbox, userId: string, inv: Obj): Promise<InvoiceRow> {
  const I = schema.billingInvoices;
  const v = {
    userId, number: inv.number ?? null, status: String(inv.status ?? "draft"), amountDue: Number(inv.amount_due ?? 0), amountPaid: Number(inv.amount_paid ?? 0),
    currency: String(inv.currency ?? "usd"), periodStart: ts(inv.period_start), periodEnd: ts(inv.period_end), hostedInvoiceUrl: inv.hosted_invoice_url ?? null, invoicePdf: inv.invoice_pdf ?? null,
    createdAt: ts(inv.created) ?? d.now, updatedAt: d.now,
  };
  await d.db.insert(I).values({ id: inv.id, ...v }).onConflictDoUpdate({ target: I.id, set: v });
  if (v.status === "open" && Number(inv.attempt_count ?? 0) > 0 && v.amountDue > v.amountPaid) {
    await notice(d, out, userId, `payment_failed:${inv.id}`, "failed", v.amountDue - v.amountPaid, v.hostedInvoiceUrl);
  }
  if (v.status === "paid") {
    const [failed] = await d.db.select().from(schema.billingNotices).where(and(eq(schema.billingNotices.userId, userId), eq(schema.billingNotices.key, `payment_failed:${inv.id}`)));
    if (failed) await notice(d, out, userId, `recovered:${inv.id}`, "recovered", v.amountPaid, v.hostedInvoiceUrl);
  }
  return v;
}

/** An invoice event: under the customer's lock, the invoice and the subscription are read from Stripe and written together. */
async function syncInvoice(d: BillingWebhookDeps, invoiceId: string, customerHint: unknown): Promise<string> {
  const customer = typeof customerHint === "string" ? customerHint : (await d.stripe.getInvoice(invoiceId)).customer;
  if (typeof customer !== "string") return "unknown customer";
  return locked(d, customer, async (dd, out) => {
    const acct = await accountFor(dd.db, customer);
    if (!acct) return "unknown customer";
    const inv = await dd.stripe.getInvoice(invoiceId);
    const row = await upsertInvoice(dd, out, acct.userId, inv);
    await syncLocked(dd, out, customer);
    return row.status;
  });
}

/**
 * One Stripe event. Throws when Stripe or the database cannot be read right now, so the route answers 500 and Stripe
 * retries; an object Stripe does not have (deleted, or from the other mode) is acknowledged and logged, never retried.
 */
export async function handleBillingEvent(d: BillingWebhookDeps, event: { id: string; type: string; data: { object: Obj } }): Promise<string> {
  const o = event.data?.object ?? {};
  try {
    switch (event.type) {
      case "checkout.session.completed": {
        if (o.mode !== "subscription" || typeof o.customer !== "string") return "ignored";
        const userId = o.client_reference_id ?? o.metadata?.revenuedot_user_id;
        const r = await syncCustomer(d, o.customer, typeof userId === "string" ? userId : null);
        if (!r) return "unknown user";
        if (r.enterprise) return "enterprise kept";
        return r.after.plan === "pro" ? "subscribed" : r.after.status;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
      case "customer.subscription.paused":
      case "customer.subscription.resumed": {
        if (typeof o.customer !== "string") return "ignored";
        const r = await syncCustomer(d, o.customer, typeof o.metadata?.revenuedot_user_id === "string" ? o.metadata.revenuedot_user_id : null);
        if (!r) return "unknown customer";
        return r.enterprise ? "enterprise kept" : r.after.status;
      }
      case "invoice.created":
      case "invoice.finalized":
      case "invoice.updated":
      case "invoice.paid":
      case "invoice.payment_failed":
      case "invoice.payment_succeeded":
      case "invoice.voided":
      case "invoice.marked_uncollectible": {
        if (typeof o.id !== "string") return "ignored";
        return await syncInvoice(d, o.id, o.customer);
      }
      default:
        return "ignored";
    }
  } catch (e) {
    if (e instanceof BillingStripeError && e.missing) {
      console.error(`billing: event ${event.type} ${event.id} names an object Stripe does not have: ${e.message}`);
      return "unknown to Stripe";
    }
    throw e;
  }
}

/**
 * The hourly safety net: re-reads accounts that have a Stripe customer and are not settled (a live status, or changed in
 * the last 7 days), so a lost or failed webhook is repaired within the hour. At most `max` accounts a run, in a window that
 * moves every hour, so every account is covered even when there are more than `max`. Returns the accounts read.
 */
export async function reconcileAccounts(d: BillingWebhookDeps, max = 200): Promise<number> {
  const since = new Date(d.now.getTime() - 7 * 86_400_000);
  const rows = await d.db.select({ userId: A.userId, customer: A.stripeCustomerId }).from(A).where(and(
    isNotNull(A.stripeCustomerId), ne(A.plan, "enterprise"),
    or(inArray(A.status, ["active", "past_due", "unpaid", "incomplete", "paused"]), gte(A.updatedAt, since)),
  )).orderBy(asc(A.userId));
  if (!rows.length) return 0;
  const start = rows.length <= max ? 0 : (Math.floor(d.now.getTime() / 3_600_000) * max) % rows.length;
  const batch = rows.length <= max ? rows : [...rows, ...rows].slice(start, start + max);
  let n = 0;
  for (const r of batch) {
    try { await syncCustomer(d, r.customer!, r.userId); n++; }
    catch (e) { console.error(`billing: reconcile of ${r.userId} failed`, e); }
  }
  return n;
}
