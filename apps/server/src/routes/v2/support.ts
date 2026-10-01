import { and, desc, eq, lt, or } from "drizzle-orm";
import { z } from "zod";
import { schema } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { findCustomer } from "../../repo/customers.js";
import { customersByEmail, supportSummary, ticketShape } from "../../services/support.js";
import { publicOrigin } from "../oauth.js";
import { body, listOf, notFound, pageParams, paramError, scope, type V2Router } from "./common.js";

/** Support (RevenueDot extension; prd/lifecycle/PRD.md): Customer Center tickets and the help desk summary. */
export function supportRoutes(r: V2Router, deps: Deps) {
  const { db } = deps;
  const P = "/v2/projects/:project_id";
  const t = schema.supportTickets;

  r.get(`${P}/support_tickets`, scope("customer_information:customers:read"), async (c) => {
    const projectId = c.get("projectId");
    const status = c.req.query("status") ?? "all";
    if (!["open", "closed", "all"].includes(status)) throw paramError("status must be open, closed or all.", "status");
    const { limit, startingAfter } = pageParams(c);
    let cursor: { at: Date; id: string } | null = null;
    if (startingAfter) {
      const [x] = await db.select().from(t).where(and(eq(t.projectId, projectId), eq(t.id, startingAfter))).limit(1);
      if (!x) throw paramError("starting_after does not match an object in this list.", "starting_after");
      cursor = { at: x.createdAt, id: x.id };
    }
    const rows = await db.select().from(t).where(and(eq(t.projectId, projectId), status === "all" ? undefined : eq(t.status, status),
      cursor ? or(lt(t.createdAt, cursor.at), and(eq(t.createdAt, cursor.at), lt(t.id, cursor.id))) : undefined))
      .orderBy(desc(t.createdAt), desc(t.id)).limit(limit + 1);
    const page = rows.slice(0, limit);
    return c.json(listOf(c, page.map(ticketShape), rows.length > limit ? page[page.length - 1]!.id : null));
  });

  r.post(`${P}/support_tickets/:ticket_id`, scope("customer_information:customers:read_write"), async (c) => {
    const b = await body(c, z.object({ status: z.enum(["open", "closed"]) }).strict());
    const [x] = await db.select().from(t).where(and(eq(t.projectId, c.get("projectId")), eq(t.id, c.req.param("ticket_id")))).limit(1);
    if (!x) throw notFound("Support ticket");
    const [u] = await db.update(t).set({ status: b.status, closedAt: b.status === "closed" ? deps.now() : null }).where(eq(t.id, x.id)).returning();
    return c.json(ticketShape(u!));
  });

  r.get(`${P}/customers/:customer_id/support_summary`, scope("customer_information:customers:read"), async (c) => {
    const projectId = c.get("projectId");
    const id = c.req.param("customer_id");
    const customer = await findCustomer(db, projectId, id);
    if (!customer) throw notFound("Customer");
    return c.json(await supportSummary(db, projectId, customer, id, deps.now(), deps.publicUrl ?? publicOrigin(c)));
  });

  // Help desks know the email, not the app user id: Intercom and Zendesk sidebars look customers up by `$email`.
  r.get(`${P}/support_summaries`, scope("customer_information:customers:read"), async (c) => {
    const projectId = c.get("projectId");
    const email = c.req.query("email")?.trim();
    if (!email) throw paramError("email is required.", "email");
    const found = await customersByEmail(db, projectId, email);
    const base = deps.publicUrl ?? publicOrigin(c);
    const items = [];
    for (const cu of found) {
      const aliases = await db.select({ a: schema.customerAliases.appUserId }).from(schema.customerAliases).where(eq(schema.customerAliases.customerId, cu.id));
      const id = aliases.map((x) => x.a).find((a) => !a.startsWith("$RCAnonymousID:")) ?? cu.originalAppUserId;
      items.push(await supportSummary(db, projectId, cu, id, deps.now(), base));
    }
    return c.json(listOf(c, items, null));
  });
}
