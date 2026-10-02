import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { newId } from "@revenuedot/core";
import { schema, type DB } from "@revenuedot/db";
import type { Deps } from "../context.js";
import { supportTicketEmail } from "../mail/templates.js";
import { isEmailAddress, trySend } from "../mail/index.js";
import { findCustomer, type CustomerRow } from "../repo/customers.js";
import { contextsFor, subActive, type LoadedContext } from "./customer-context.js";
import { supportSettingsFor } from "./customer-center.js";
import { hit } from "./rate-limit.js";

/**
 * Support (prd/lifecycle/PRD.md): Customer Center tickets (`POST /v1/customercenter/support/create-ticket`) are stored,
 * emailed to the support address with the customer's details, and listed in the dashboard; help desks read a customer's
 * subscription state from the support summary.
 */

/** Ticket limits per hour: per customer, per caller IP, and per project (what the support inbox receives at most). */
export const TICKET_LIMITS = { perCustomer: 5, perIp: 20, perProject: 100 };
/** What the email shows when the project has not chosen (RevenueCat's customer_details keys). */
const DEFAULT_DETAILS: Record<string, boolean> = { appUserId: true, activeEntitlements: true, country: true, lastSeenAppVersion: true, totalSpent: true, userSince: true, lastOpened: true, deviceVersion: true };

export interface TicketInput { app_user_id?: unknown; customer_email?: unknown; issue_description?: unknown }

/** The SDK's create-ticket call. `sent: false` tells the SDK to fall back to its email link. */
export async function createTicket(deps: Deps, app: { id: string | null; projectId: string; name?: string | null }, b: TicketInput, origin: string, ip = "unknown"): Promise<{ sent: boolean }> {
  const { db } = deps;
  const now = deps.now();
  const appUserId = typeof b.app_user_id === "string" ? b.app_user_id.trim().slice(0, 512) : "";
  const email = typeof b.customer_email === "string" ? b.customer_email.trim() : "";
  const description = typeof b.issue_description === "string" ? b.issue_description.trim().slice(0, 5000) : "";
  if (!appUserId || !isEmailAddress(email) || !description) return { sent: false };
  const settings = await supportSettingsFor(db, app.projectId);
  const who = settings.tickets?.customer_type ?? "all";
  if ((settings.tickets && !settings.tickets.allow_creation) || who === "none") return { sent: false };
  // The public SDK key is in every copy of the app: limit by caller and by project too, not only by the (free-form) app user id.
  const hour = 3600_000;
  if (!(await hit(db, `ticket:ip:${app.projectId}:${ip}`, TICKET_LIMITS.perIp, hour, now))) return { sent: false };
  if (!(await hit(db, `ticket:${app.projectId}:${appUserId}`, TICKET_LIMITS.perCustomer, hour, now))) return { sent: false };
  const customer = await findCustomer(db, app.projectId, appUserId);
  const loaded = customer ? (await contextsFor(db, app.projectId, [customer], now))[0]! : null;
  // customer_type: who may open a ticket (active subscribers, everyone else, or all).
  const active = loaded ? loaded.ctx.status === "active" || loaded.ctx.status === "trialing" || loaded.ctx.activeEntitlements.length > 0 : false;
  if ((who === "active" && !active) || (who === "not_active" && active)) return { sent: false };
  if (!(await hit(db, `ticket:project:${app.projectId}`, TICKET_LIMITS.perProject, hour, now))) return { sent: false };
  const id = newId("tkt_", 16);
  const to = isEmailAddress(settings.email) && !settings.email.endsWith("@example.com") ? settings.email : null;
  await db.insert(schema.supportTickets).values({ id, projectId: app.projectId, appId: app.id, customerId: customer?.id ?? null, appUserId, customerEmail: email, description, emailedTo: to, createdAt: now });
  if (to) {
    const [project] = await db.select({ name: schema.projects.name }).from(schema.projects).where(eq(schema.projects.id, app.projectId));
    const base = deps.publicUrl ?? origin;
    const details = ticketDetails(loaded, appUserId, settings.tickets?.customer_details ?? DEFAULT_DETAILS);
    const mail = supportTicketEmail({ base, projectName: project?.name ?? "your project", appName: app.name ?? null, customerEmail: email, description, details, url: `${base}/projects/${app.projectId}/lifecycle/support?ticket=${id}` });
    const sent = await trySend(deps.mailer, { to, ...mail, replyTo: email });
    if (sent) await db.update(schema.supportTickets).set({ emailed: true }).where(eq(schema.supportTickets.id, id));
  }
  return { sent: true };
}

/** The customer facts the project allows in ticket emails (`support.support_tickets.customer_details`). */
function ticketDetails(loaded: LoadedContext | null, appUserId: string, allow: Record<string, boolean>): [string, string][] {
  const out: [string, string][] = [];
  if (allow.appUserId) out.push(["App user ID", appUserId]);
  if (!loaded) return out;
  const { ctx, data } = loaded;
  const customer = data.customer;
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

/**
 * Customers with this address (case-insensitive), at most 10: first those whose `$email` attribute is it, then those who
 * gave it on a Customer Center ticket. Help desks look people up by the address they wrote from, which apps often never
 * save as `$email`.
 */
export async function customersByEmail(db: DB, projectId: string, email: string): Promise<CustomerRow[]> {
  const address = email.toLowerCase();
  const byAttribute = await db.select({ c: schema.customerAttributes.customerId }).from(schema.customerAttributes)
    .innerJoin(schema.customers, eq(schema.customers.id, schema.customerAttributes.customerId))
    .where(and(eq(schema.customers.projectId, projectId), eq(schema.customerAttributes.key, "$email"), sql`lower(${schema.customerAttributes.value}) = ${address}`)).limit(10);
  const byTicket = await db.select({ c: schema.supportTickets.customerId }).from(schema.supportTickets)
    .where(and(eq(schema.supportTickets.projectId, projectId), sql`lower(${schema.supportTickets.customerEmail}) = ${address}`, sql`${schema.supportTickets.customerId} is not null`))
    .orderBy(desc(schema.supportTickets.createdAt)).limit(10);
  const ids = [...new Set([...byAttribute, ...byTicket].map((r) => r.c!))].slice(0, 10);
  if (!ids.length) return [];
  const rows = await db.select().from(schema.customers).where(inArray(schema.customers.id, ids));
  return ids.map((id) => rows.find((r) => r.id === id)).filter((r): r is CustomerRow => !!r);
}

