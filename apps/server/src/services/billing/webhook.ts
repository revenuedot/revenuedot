import { and, eq, gte, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";
import { trySend, type Mailer } from "../../mail/index.js";
import { billingPaymentEmail } from "../../mail/templates.js";
import { BillingStripeError, type billingStripe } from "./stripe.js";

/**
 * Stripe events of RevenueDot's own account (prd/cloud-billing/PRD.md, "Stripe is the source of truth"). Stripe delivers
 * events at least once and in no set order, so an event only says which customer changed: the handler then reads that
 * customer's subscriptions and the invoice from Stripe and writes what Stripe says now. A late, repeated or out-of-order
 * event therefore always ends in the current state. Payment emails follow the invoice's real status, once per invoice.
 * Nothing here changes how a customer's apps work: plan and payment status never touch SDK, REST or webhook behaviour.
 */

const A = schema.billingAccounts;
type Obj = Record<string, any>;
type Stripe = ReturnType<typeof billingStripe>;
export interface BillingWebhookDeps { db: DB; now: Date; stripe: Stripe; mailer?: Mailer; publicUrl?: string }

const ts = (s: unknown) => (typeof s === "number" && s > 0 ? new Date(s * 1000) : null);
const LIVE = ["active", "trialing", "past_due", "unpaid", "incomplete", "paused"];
/** Statuses that bill the meter: a second one of these on the same customer would bill the same usage twice. */
const BILLING = ["active", "trialing", "past_due"];

/** Stripe's subscription status as the account's plan and status. */
export function statusOf(stripeStatus: string): { status: string; plan: "standard" | "free" } {
  switch (stripeStatus) {
    case "active": case "trialing": return { status: "active", plan: "standard" };
    case "past_due": return { status: "past_due", plan: "standard" };
    case "unpaid": return { status: "unpaid", plan: "free" };
    case "incomplete": return { status: "incomplete", plan: "free" };
    case "paused": return { status: "paused", plan: "free" };
    default: return { status: "canceled", plan: "free" };
  }
}

/** The subscription that decides the account: the one on file if still live, else the oldest live, else the newest ended. */
export function currentSubscription(subs: Obj[], onFile: string | null | undefined): { current: Obj | null; duplicates: Obj[] } {
  const live = subs.filter((s) => LIVE.includes(s.status)).sort((a, b) => (a.created ?? 0) - (b.created ?? 0));
  const current = live.find((s) => s.id === onFile) ?? live[0] ?? [...subs].sort((a, b) => (b.created ?? 0) - (a.created ?? 0))[0] ?? null;
  const duplicates = current && BILLING.includes(current.status) ? live.filter((s) => s.id !== current.id && BILLING.includes(s.status)) : [];
  return { current, duplicates };
}

async function accountFor(db: DB, customer: unknown, userId?: unknown) {
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

async function notice(d: Pick<BillingWebhookDeps, "db" | "now" | "mailer" | "publicUrl">, userId: string, key: string, kind: "failed" | "unpaid" | "recovered", amountCents: number, invoiceUrl?: string | null) {
  const [won] = await d.db.insert(schema.billingNotices).values({ userId, key, sentAt: d.now }).onConflictDoNothing().returning();
  if (!won) return false;
  const [u] = await d.db.select().from(schema.users).where(eq(schema.users.id, userId));
  if (!u) return false;
  await trySend(d.mailer, { to: u.email, ...billingPaymentEmail({ base: (d.publicUrl ?? "https://app.revenuedot.app").replace(/\/+$/, ""), kind, amount: amountCents / 100, invoiceUrl }) });
  return true;
}

export interface SyncResult { userId: string; before: { plan: string; status: string }; after: { plan: string; status: string }; subscription: string | null }

/**
 * Reads the customer's subscriptions from Stripe and writes the account's plan, status, subscription, period end and end
 * date. Cancels a duplicate billing subscription. `userId` links a customer the account does not know yet (Checkout).
 */
export async function syncCustomer(d: BillingWebhookDeps, customer: string, userId?: string | null): Promise<SyncResult | null> {
  // One sync per customer at a time, reading Stripe inside the lock: Checkout alone fires about ten events at once, and two
  // syncs that read Stripe in one order and write in the other would leave the older state. Whoever holds the lock last read
  // Stripe last, so the final write is always the freshest.
  return d.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`billing:${customer}`}))`);
    return syncLocked({ ...d, db: tx as unknown as DB }, customer, userId);
  });
}

async function syncLocked(d: BillingWebhookDeps, customer: string, userId?: string | null): Promise<SyncResult | null> {
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
  // Enterprise is set by hand and billed by contract: Stripe never moves it.
  if (acct.plan === "enterprise") return { userId: acct.userId, before: { plan: acct.plan, status: acct.status }, after: { plan: acct.plan, status: acct.status }, subscription: acct.stripeSubscriptionId };
  const subs = await d.stripe.listSubscriptions(customer);
  const { current, duplicates } = currentSubscription(subs, acct.stripeSubscriptionId);
  for (const dup of duplicates) {
    try { await d.stripe.cancelSubscription(dup.id); console.warn(`billing: cancelled duplicate subscription ${dup.id} of ${customer} (kept ${current?.id})`); }
    catch (e) { console.error(`billing: DUPLICATE subscription ${dup.id} of ${customer} could not be cancelled; it bills the meter twice`, e); }
  }
  const before = { plan: acct.plan, status: acct.status };
  if (!current) {
    // A customer with no subscription at all: Checkout started but not finished. Nothing to change.
    return { userId: acct.userId, before, after: before, subscription: null };
  }
  const s = statusOf(String(current.status));
  const item = current.items?.data?.[0];
  const periodEnd = ts(item?.current_period_end) ?? ts(current.current_period_end);
  const cancelAt = s.status === "canceled" ? null : ts(current.cancel_at) ?? (current.cancel_at_period_end ? periodEnd : null);
  await db.update(A).set({ plan: s.plan, status: s.status, stripeCustomerId: customer, stripeSubscriptionId: current.id, currentPeriodEnd: periodEnd, cancelAt, updatedAt: now }).where(eq(A.userId, acct.userId));
  await db.update(schema.users).set({ plan: s.plan }).where(eq(schema.users.id, acct.userId));
  if (s.status === "unpaid" && before.status !== "unpaid") {
    const latest = typeof current.latest_invoice === "string" ? current.latest_invoice : current.latest_invoice?.id ?? "";
    const [inv] = latest ? await db.select().from(schema.billingInvoices).where(eq(schema.billingInvoices.id, latest)) : [];
    await notice(d, acct.userId, `unpaid:${current.id}:${latest}`, "unpaid", inv ? inv.amountDue - inv.amountPaid : 0, inv?.hostedInvoiceUrl);
  }
  return { userId: acct.userId, before, after: { plan: s.plan, status: s.status }, subscription: current.id };
}

async function syncInvoice(d: BillingWebhookDeps, invoiceId: string): Promise<string> {
  const { db, now } = d;
  const inv = await d.stripe.getInvoice(invoiceId);
  const customer = typeof inv.customer === "string" ? inv.customer : inv.customer?.id;
  const acct = await accountFor(db, customer);
  if (!acct) return "unknown customer";
  const I = schema.billingInvoices;
  const v = {
    userId: acct.userId, number: inv.number ?? null, status: String(inv.status ?? "draft"), amountDue: Number(inv.amount_due ?? 0), amountPaid: Number(inv.amount_paid ?? 0),
    currency: String(inv.currency ?? "usd"), periodStart: ts(inv.period_start), periodEnd: ts(inv.period_end), hostedInvoiceUrl: inv.hosted_invoice_url ?? null, invoicePdf: inv.invoice_pdf ?? null,
    createdAt: ts(inv.created) ?? now, updatedAt: now,
  };
  await db.insert(I).values({ id: inv.id, ...v }).onConflictDoUpdate({ target: I.id, set: v });
  // The subscription's status (past due, active again, unpaid) comes from the subscription itself.
  if (customer) await syncCustomer(d, customer);
  // Emails from the invoice as Stripe has it now: failed while it is open after an attempt; recovered once it is paid,
  // only if the failed email went out. A late payment_failed for a paid invoice sends nothing.
  if (v.status === "open" && Number(inv.attempt_count ?? 0) > 0 && v.amountDue > v.amountPaid) {
    await notice(d, acct.userId, `payment_failed:${inv.id}`, "failed", v.amountDue - v.amountPaid, v.hostedInvoiceUrl);
  }
  if (v.status === "paid") {
    const [failed] = await db.select().from(schema.billingNotices).where(and(eq(schema.billingNotices.userId, acct.userId), eq(schema.billingNotices.key, `payment_failed:${inv.id}`)));
    if (failed) await notice(d, acct.userId, `recovered:${inv.id}`, "recovered", v.amountPaid, v.hostedInvoiceUrl);
  }
  return v.status;
}

/**
 * One Stripe event. Throws a BillingStripeError when Stripe cannot be read, so the route answers 500 and Stripe retries;
 * an object Stripe no longer knows (404) is ignored.
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
        return r.after.plan === "standard" ? "subscribed" : r.after.status;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
      case "customer.subscription.paused":
      case "customer.subscription.resumed": {
        if (typeof o.customer !== "string") return "ignored";
        const r = await syncCustomer(d, o.customer, typeof o.metadata?.revenuedot_user_id === "string" ? o.metadata.revenuedot_user_id : null);
        return r ? r.after.status : "unknown customer";
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
        return await syncInvoice(d, o.id);
      }
      default:
        return "ignored";
    }
  } catch (e) {
    if (e instanceof BillingStripeError && e.status === 404) return "unknown to Stripe";
    throw e;
  }
}

/**
 * The hourly safety net: re-reads every account that has a Stripe customer and is not settled (a live status, or changed
 * in the last 7 days), so a lost or failed webhook delivery is repaired within the hour. Returns the accounts read.
 */
export async function reconcileAccounts(d: BillingWebhookDeps, max = 200): Promise<number> {
  const since = new Date(d.now.getTime() - 7 * 86_400_000);
  const rows = await d.db.select({ userId: A.userId, customer: A.stripeCustomerId }).from(A).where(and(
    isNotNull(A.stripeCustomerId), ne(A.plan, "enterprise"),
    or(inArray(A.status, ["active", "past_due", "unpaid", "incomplete", "paused"]), gte(A.updatedAt, since)),
  )).limit(max);
  let n = 0;
  for (const r of rows) {
    try { await syncCustomer(d, r.customer!, r.userId); n++; }
    catch (e) { console.error(`billing: reconcile of ${r.userId} failed`, e); }
  }
  return n;
}
