import { desc, eq } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";
import { trySend, type Mailer } from "../../mail/index.js";
import { billingPaymentEmail } from "../../mail/templates.js";

/**
 * Stripe events of RevenueDot's own account (prd/cloud-billing/PRD.md): the subscription decides the plan and the dunning
 * status, invoices are kept for the Billing page, and failed or recovered payments email the owner once per invoice.
 * Nothing here changes how a customer's apps work: plan and payment status never touch SDK, REST or webhook behaviour.
 */

const A = schema.billingAccounts;
type Obj = Record<string, any>;
export interface BillingWebhookDeps { db: DB; now: Date; mailer?: Mailer; publicUrl?: string }

const ts = (s: unknown) => (typeof s === "number" && s > 0 ? new Date(s * 1000) : null);

async function accountFor(db: DB, customer: unknown, userId?: unknown) {
  if (typeof customer === "string") {
    const [a] = await db.select().from(A).where(eq(A.stripeCustomerId, customer));
    if (a) return a;
  }
  if (typeof userId === "string") {
    const [a] = await db.select().from(A).where(eq(A.userId, userId));
    if (a) return a;
  }
  return null;
}

/** active / past_due keep Standard; unpaid and canceled put the account back on Free. */
export function statusOf(stripeStatus: string): { status: string; plan: "standard" | "free" } | null {
  switch (stripeStatus) {
    case "active": case "trialing": return { status: "active", plan: "standard" };
    case "past_due": return { status: "past_due", plan: "standard" };
    case "unpaid": return { status: "unpaid", plan: "free" };
    case "canceled": case "incomplete_expired": return { status: "canceled", plan: "free" };
    default: return null;
  }
}

async function notice(d: BillingWebhookDeps, userId: string, key: string, kind: "failed" | "unpaid" | "recovered", amountCents: number, invoiceUrl?: string | null) {
  const [won] = await d.db.insert(schema.billingNotices).values({ userId, key, sentAt: d.now }).onConflictDoNothing().returning();
  if (!won) return;
  const [u] = await d.db.select().from(schema.users).where(eq(schema.users.id, userId));
  if (!u) return;
  await trySend(d.mailer, { to: u.email, ...billingPaymentEmail({ base: (d.publicUrl ?? "https://app.revenuedot.app").replace(/\/+$/, ""), kind, amount: amountCents / 100, invoiceUrl }) });
}

export async function handleBillingEvent(d: BillingWebhookDeps, event: { id: string; type: string; data: { object: Obj } }): Promise<string> {
  const o = event.data?.object ?? {};
  const { db, now } = d;
  switch (event.type) {
    case "checkout.session.completed": {
      const userId = o.client_reference_id ?? o.metadata?.revenuedot_user_id;
      if (typeof userId !== "string" || o.mode !== "subscription") return "ignored";
      const [user] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, userId));
      if (!user) return "unknown user";
      // Enterprise is set by RevenueDot staff under a contract; Stripe events never change it (it decides features and audit retention).
      const [had] = await db.select({ plan: A.plan }).from(A).where(eq(A.userId, userId));
      if (had?.plan === "enterprise") return "enterprise kept";
      const set = { plan: "standard", status: "active", stripeCustomerId: o.customer, stripeSubscriptionId: o.subscription, updatedAt: now };
      await db.insert(A).values({ userId, ...set, createdAt: now }).onConflictDoUpdate({ target: A.userId, set });
      await db.update(schema.users).set({ plan: "standard" }).where(eq(schema.users.id, userId));
      return "subscribed";
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const acct = await accountFor(db, o.customer, o.metadata?.revenuedot_user_id);
      if (!acct) return "unknown customer";
      // An older subscription's events do not change a newer one.
      if (acct.stripeSubscriptionId && o.id !== acct.stripeSubscriptionId && event.type !== "customer.subscription.created") return "other subscription";
      const s = statusOf(event.type === "customer.subscription.deleted" ? "canceled" : String(o.status));
      if (!s) return "ignored status";
      if (acct.plan === "enterprise") return "enterprise kept";
      const periodEnd = ts(o.current_period_end) ?? ts(o.items?.data?.[0]?.current_period_end);
      const cancelAt = ts(o.cancel_at) ?? (o.cancel_at_period_end ? periodEnd : null);
      await db.update(A).set({ plan: s.plan, status: s.status, stripeSubscriptionId: o.id, currentPeriodEnd: periodEnd, cancelAt: s.status === "canceled" ? null : cancelAt, updatedAt: now }).where(eq(A.userId, acct.userId));
      await db.update(schema.users).set({ plan: s.plan }).where(eq(schema.users.id, acct.userId));
      if (s.status === "unpaid" && acct.status !== "unpaid") {
        const [inv] = await db.select().from(schema.billingInvoices).where(eq(schema.billingInvoices.userId, acct.userId)).orderBy(desc(schema.billingInvoices.createdAt)).limit(1);
        await notice(d, acct.userId, `unpaid:${o.id}:${inv?.id ?? ""}`, "unpaid", inv ? inv.amountDue - inv.amountPaid : 0, inv?.hostedInvoiceUrl);
      }
      return s.status;
    }
    case "invoice.created":
    case "invoice.finalized":
    case "invoice.updated":
    case "invoice.paid":
    case "invoice.payment_failed":
    case "invoice.voided":
    case "invoice.marked_uncollectible": {
      const acct = await accountFor(db, o.customer);
      if (!acct || typeof o.id !== "string") return "unknown customer";
      const I = schema.billingInvoices;
      const v = {
        userId: acct.userId, number: o.number ?? null, status: String(o.status ?? "draft"), amountDue: Number(o.amount_due ?? 0), amountPaid: Number(o.amount_paid ?? 0),
        currency: String(o.currency ?? "usd"), periodStart: ts(o.period_start), periodEnd: ts(o.period_end), hostedInvoiceUrl: o.hosted_invoice_url ?? null, invoicePdf: o.invoice_pdf ?? null,
        createdAt: ts(o.created) ?? now, updatedAt: now,
      };
      await db.insert(I).values({ id: o.id, ...v }).onConflictDoUpdate({ target: I.id, set: v });
      if (event.type === "invoice.payment_failed") {
        if (acct.status === "active") await db.update(A).set({ status: "past_due", updatedAt: now }).where(eq(A.userId, acct.userId));
        await notice(d, acct.userId, `payment_failed:${o.id}`, "failed", v.amountDue, v.hostedInvoiceUrl);
      }
      if (event.type === "invoice.paid" && acct.status === "past_due") {
        await db.update(A).set({ status: "active", updatedAt: now }).where(eq(A.userId, acct.userId));
        await notice(d, acct.userId, `recovered:${o.id}`, "recovered", v.amountPaid, v.hostedInvoiceUrl);
      }
      return v.status;
    }
    default:
      return "ignored";
  }
}
