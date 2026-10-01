import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { newId } from "@revenuedot/core";
import { schema, type DB } from "@revenuedot/db";
import type { Deps } from "../context.js";
import { supportTicketEmail } from "../mail/templates.js";
import { trySend } from "../mail/index.js";
import { findCustomer, type CustomerRow } from "../repo/customers.js";
import { contextsFor, subActive } from "./customer-context.js";
import { supportSettingsFor } from "./customer-center.js";
import { hit } from "./rate-limit.js";

/**
 * Support (prd/lifecycle/PRD.md): Customer Center tickets (`POST /v1/customercenter/support/create-ticket`) are stored,
 * emailed to the support address with the customer's details, and listed in the dashboard; help desks read a customer's
 * subscription state from the support summary.
 */

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const TICKETS_PER_HOUR = 5;
/** What the email shows when the project has not chosen (RevenueCat's customer_details keys). */
const DEFAULT_DETAILS: Record<string, boolean> = { appUserId: true, activeEntitlements: true, country: true, lastSeenAppVersion: true, totalSpent: true, userSince: true, lastOpened: true, deviceVersion: true };

export interface TicketInput { app_user_id?: unknown; customer_email?: unknown; issue_description?: unknown }

/** The SDK's create-ticket call. `sent: false` tells the SDK to fall back to its email link. */
export async function createTicket(deps: Deps, app: { id: string | null; projectId: string; name?: string | null }, b: TicketInput, origin: string): Promise<{ sent: boolean }> {
  const { db } = deps;
  const now = deps.now();
  const appUserId = typeof b.app_user_id === "string" ? b.app_user_id.trim().slice(0, 512) : "";
  const email = typeof b.customer_email === "string" ? b.customer_email.trim().slice(0, 320) : "";
  const description = typeof b.issue_description === "string" ? b.issue_description.trim().slice(0, 5000) : "";
  if (!appUserId || !EMAIL.test(email) || !description) return { sent: false };
  const settings = await supportSettingsFor(db, app.projectId);
  if (settings.tickets && !settings.tickets.allow_creation) return { sent: false };
  if (!(await hit(db, `ticket:${app.projectId}:${appUserId}`, TICKETS_PER_HOUR, 3600_000, now))) return { sent: false };
  const customer = await findCustomer(db, app.projectId, appUserId);
  const id = newId("tkt_", 16);
  const to = EMAIL.test(settings.email) && !settings.email.endsWith("@example.com") ? settings.email : null;
  await db.insert(schema.supportTickets).values({ id, projectId: app.projectId, appId: app.id, customerId: customer?.id ?? null, appUserId, customerEmail: email, description, emailedTo: to, createdAt: now });
  if (to) {
    const [project] = await db.select({ name: schema.projects.name }).from(schema.projects).where(eq(schema.projects.id, app.projectId));
    const base = deps.publicUrl ?? origin;
    const details = await ticketDetails(db, app.projectId, customer, appUserId, settings.tickets?.customer_details ?? DEFAULT_DETAILS, now);
    const mail = supportTicketEmail({ base, projectName: project?.name ?? "your project", appName: app.name ?? null, customerEmail: email, description, details, url: `${base}/projects/${app.projectId}/lifecycle/support?ticket=${id}` });
    const sent = await trySend(deps.mailer, { to, ...mail, replyTo: email });
    if (sent) await db.update(schema.supportTickets).set({ emailed: true }).where(eq(schema.supportTickets.id, id));
  }
  return { sent: true };
}

/** The customer facts the project allows in ticket emails (`support.support_tickets.customer_details`). */
async function ticketDetails(db: DB, projectId: string, customer: CustomerRow | null, appUserId: string, allow: Record<string, boolean>, now: Date): Promise<[string, string][]> {
  const out: [string, string][] = [];
  if (allow.appUserId) out.push(["App user ID", appUserId]);
  if (!customer) return out;
  const [{ ctx, data }] = await contextsFor(db, projectId, [customer], now) as [Awaited<ReturnType<typeof contextsFor>>[number]];
  const a = data.attributes;
  if (allow.activeEntitlements) out.push(["Active entitlements", ctx.activeEntitlements.join(", ") || "None"]);
  if (allow.totalSpent) out.push(["Total spent", `$${ctx.totalSpent.toFixed(2)}`]);
  if (allow.userSince) out.push(["Customer since", customer.firstSeen.toISOString().slice(0, 10)]);
  if (allow.lastOpened) out.push(["Last opened", customer.lastSeen.toISOString().replace("T", " ").slice(0, 16) + " UTC"]);
  if (allow.lastSeenAppVersion && customer.lastSeenAppVersion) out.push(["App version", customer.lastSeenAppVersion]);
  if (allow.country && customer.lastSeenCountry) out.push(["Country", customer.lastSeenCountry.toUpperCase()]);
  if (allow.deviceVersion && a.$deviceVersion) out.push(["Device", a.$deviceVersion]);
  if (allow.email && a.$email) out.push(["Email on file", a.$email]);
  if (allow.ipAddress && a.$ip) out.push(["IP address", a.$ip]);
  if (allow.idfa && a.$idfa) out.push(["IDFA", a.$idfa]);
  if (allow.idfv && a.$idfv) out.push(["IDFV", a.$idfv]);
  if (allow.attConsent && a.$attConsentStatus) out.push(["Tracking consent", a.$attConsentStatus]);
  if (allow.facebookAnonId && a.$fbAnonId) out.push(["Facebook anonymous ID", a.$fbAnonId]);
  return out;
}

export const ticketShape = (t: typeof schema.supportTickets.$inferSelect) => ({
  object: "support_ticket" as const, id: t.id, app_id: t.appId, app_user_id: t.appUserId, customer_email: t.customerEmail, description: t.description,
  status: t.status, emailed_to: t.emailedTo, emailed: t.emailed, created_at: t.createdAt.getTime(), closed_at: t.closedAt ? t.closedAt.getTime() : null,
});

/**
 * What a help desk sidebar (Intercom, Zendesk) shows next to a conversation: who the customer is, whether they pay, what
 * renews when, refunds and open tickets, and a link to the customer in the dashboard.
 */
export async function supportSummary(db: DB, projectId: string, customer: CustomerRow, requestedId: string, now: Date, dashboardBase: string) {
  const [{ ctx, data }] = await contextsFor(db, projectId, [customer], now) as [Awaited<ReturnType<typeof contextsFor>>[number]];
  const tickets = await db.select().from(schema.supportTickets).where(and(eq(schema.supportTickets.customerId, customer.id), eq(schema.supportTickets.status, "open"))).orderBy(desc(schema.supportTickets.createdAt)).limit(10);
  const refunds = await db.select().from(schema.refundRequests).where(eq(schema.refundRequests.customerId, customer.id)).orderBy(desc(schema.refundRequests.requestedAt)).limit(10);
  const sandboxSpent = Math.round(data.tx.filter((t) => t.sandbox).reduce((s, t) => s + t.usd, 0) * 100) / 100;
  const subs = data.subs.filter((s) => s.store !== "promotional").sort((a, b) => b.purchaseDate.getTime() - a.purchaseDate.getTime());
  return {
    object: "support_summary" as const,
    app_user_id: requestedId,
    original_app_user_id: customer.originalAppUserId,
    aliases: [...data.aliases].sort(),
    email: data.attributes.$email ?? null,
    display_name: data.attributes.$displayName ?? null,
    status: ctx.status,
    active_entitlements: ctx.activeEntitlements,
    subscriptions: subs.map((s) => ({
      product_id: s.productIdentifier, store: s.store, environment: s.isSandbox ? "sandbox" : "production", active: subActive(s, now),
      period_type: s.periodType, auto_renew: !s.unsubscribeDetectedAt && !s.refundedAt, billing_issue: !!s.billingIssuesDetectedAt,
      purchased_at: s.purchaseDate.getTime(), expires_at: s.expiresDate ? s.expiresDate.getTime() : null, refunded_at: s.refundedAt ? s.refundedAt.getTime() : null,
    })),
    purchases: data.ones.map((o) => ({ product_id: o.productIdentifier, store: o.store, purchased_at: o.purchaseDate.getTime(), refunded_at: o.refundedAt ? o.refundedAt.getTime() : null })),
    total_spent_in_usd: ctx.totalSpent,
    sandbox_spent_in_usd: sandboxSpent,
    first_seen_at: customer.firstSeen.getTime(),
    last_seen_at: customer.lastSeen.getTime(),
    country: customer.lastSeenCountry?.toUpperCase() ?? null,
    platform: customer.lastSeenPlatform,
    app_version: customer.lastSeenAppVersion,
    refund_requests: refunds.map((r) => ({ product_id: r.productId, store: r.store, outcome: r.outcome, requested_at: r.requestedAt.getTime() })),
    open_tickets: tickets.map(ticketShape),
    dashboard_url: `${dashboardBase}/projects/${projectId}/customers/${encodeURIComponent(requestedId)}`,
  };
}

/** Customers whose `$email` attribute is this address (case-insensitive), at most 10. */
export async function customersByEmail(db: DB, projectId: string, email: string): Promise<CustomerRow[]> {
  const rows = await db.select({ c: schema.customerAttributes.customerId }).from(schema.customerAttributes)
    .innerJoin(schema.customers, eq(schema.customers.id, schema.customerAttributes.customerId))
    .where(and(eq(schema.customers.projectId, projectId), eq(schema.customerAttributes.key, "$email"), sql`lower(${schema.customerAttributes.value}) = ${email.toLowerCase()}`)).limit(10);
  const ids = rows.map((r) => r.c);
  return ids.length ? db.select().from(schema.customers).where(inArray(schema.customers.id, ids)) : [];
}

