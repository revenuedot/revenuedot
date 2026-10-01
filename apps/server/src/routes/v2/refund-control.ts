import { and, asc, desc, eq, lt, or } from "drizzle-orm";
import { z } from "zod";
import { newId } from "@revenuedot/core";
import { schema } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { projectContexts } from "../../services/customer-context.js";
import { PREFERENCES, TEMPLATES, TEMPLATE_RULES, policyCounts, refundStats, settingsOf, type PolicyRow } from "../../services/refunds.js";
import { fieldSupported, OPERATORS, type Rules } from "../../services/targeting.js";
import { body, listOf, pageParams, paramError, scope, type V2Router } from "./common.js";

/** Refund Control (RevenueDot extension; prd/lifecycle/PRD.md): policies, settings, cards and the request log. */

const Cond = z.object({ field: z.string().min(1).max(200), operator: z.string(), value: z.string().max(5000).optional(), currency: z.string().optional() }).strict();
export const RulesIn = z.object({ groups: z.array(z.object({ conditions: z.array(Cond).max(50) }).strict()).max(20) }).strict();
const PolicyIn = z.object({
  id: z.string().optional(), name: z.string().trim().min(1).max(120), template: z.enum(TEMPLATES).default("custom"),
  rules: RulesIn, preference: z.enum(PREFERENCES),
}).strict();
const SaveIn = z.object({
  settings: z.object({ default_preference: z.enum(PREFERENCES).optional(), customer_consented: z.boolean().optional() }).strict().optional(),
  policies: z.array(PolicyIn).max(50).optional(),
}).strict();

/** Every field and operator must be one this server evaluates, so a policy never silently matches nobody. */
export function checkRules(rules: Rules, at = "rules") {
  for (const [gi, g] of rules.groups.entries()) for (const [ci, c] of g.conditions.entries()) {
    const p = `${at}.groups.${gi}.conditions.${ci}`;
    if (!fieldSupported(c.field)) throw paramError(`${p}.field: ${c.field} is not supported by this server.`, `${p}.field`);
    if (!OPERATORS.has(c.operator)) throw paramError(`${p}.operator: unknown operator ${c.operator}.`, `${p}.operator`);
  }
}

export function refundControlRoutes(r: V2Router, deps: Deps) {
  const { db } = deps;
  const P = "/v2/projects/:project_id";

  const view = async (projectId: string) => {
    const [p] = await db.select({ s: schema.projects.refundSettings }).from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1);
    const rows = await db.select().from(schema.refundPolicies).where(eq(schema.refundPolicies.projectId, projectId)).orderBy(asc(schema.refundPolicies.position));
    const now = deps.now();
    const policies: PolicyRow[] = rows.map((x) => ({ id: x.id, name: x.name, rules: x.rules as Rules, preference: x.preference, position: x.position }));
    const { items, truncated } = await projectContexts(db, projectId, now);
    const counts = policyCounts(policies, items.map((i) => i.ctx), now.getTime());
    return {
      object: "refund_control" as const,
      settings: settingsOf(p?.s ?? null),
      default_policy: { customer_count: counts.default },
      policies: rows.map((x) => ({
        object: "refund_policy" as const, id: x.id, name: x.name, template: x.template, rules: x.rules, preference: x.preference, position: x.position,
        customer_count: counts.byPolicy[x.id] ?? 0, created_at: x.createdAt.getTime(), updated_at: x.updatedAt ? x.updatedAt.getTime() : null,
      })),
      templates: Object.fromEntries(Object.entries(TEMPLATE_RULES).map(([k, v]) => [k, v])),
      counts_are_approximate: truncated,
    };
  };

  r.get(`${P}/refund_control`, scope("project_configuration:projects:read"), async (c) => c.json(await view(c.get("projectId"))));

  // Save replaces the settings and the ordered list of policies (the dashboard's Save; Cancel simply reloads).
  r.post(`${P}/refund_control`, scope("project_configuration:projects:read_write"), async (c) => {
    const projectId = c.get("projectId");
    const b = await body(c, SaveIn);
    const now = deps.now();
    // Everything is checked before anything is written, and the write is one transaction: a stale tab or a bad rule
    // never leaves half a save behind.
    const existing = await db.select().from(schema.refundPolicies).where(eq(schema.refundPolicies.projectId, projectId));
    if (b.policies) {
      b.policies.forEach((p, i) => checkRules(p.rules, `policies.${i}.rules`));
      for (const [i, p] of b.policies.entries()) {
        if (p.id && !existing.some((e) => e.id === p.id)) throw paramError(`policies.${i}.id: no policy ${p.id} in this project. Reload the page and try again.`, `policies.${i}.id`);
      }
      const ids = b.policies.map((p) => p.id).filter(Boolean);
      if (new Set(ids).size !== ids.length) throw paramError("policies: a policy id appears twice.", "policies");
    }
    await db.transaction(async (raw) => {
      const tx = raw as unknown as typeof db;
      if (b.settings) {
        const [p] = await tx.select({ s: schema.projects.refundSettings }).from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1);
        await tx.update(schema.projects).set({ refundSettings: { ...settingsOf(p?.s ?? null), ...b.settings } }).where(eq(schema.projects.id, projectId));
      }
      if (b.policies) {
        const keep = new Set(b.policies.map((p) => p.id).filter(Boolean));
        for (const e of existing) if (!keep.has(e.id)) await tx.delete(schema.refundPolicies).where(eq(schema.refundPolicies.id, e.id));
        for (const [i, p] of b.policies.entries()) {
          const values = { name: p.name, template: p.template, rules: p.rules, preference: p.preference, position: i };
          if (p.id) await tx.update(schema.refundPolicies).set({ ...values, updatedAt: now }).where(and(eq(schema.refundPolicies.id, p.id), eq(schema.refundPolicies.projectId, projectId)));
          else await tx.insert(schema.refundPolicies).values({ id: newId("rfp_", 12), projectId, ...values, createdAt: now });
        }
      }
    });
    return c.json(await view(projectId));
  });

  r.get(`${P}/refund_control/stats`, scope("customer_information:customers:read"), async (c) => {
    const days = Math.min(365, Math.max(1, Math.trunc(Number(c.req.query("days") ?? 28)) || 28));
    const env = c.req.query("environment") ?? "production";
    if (env !== "production" && env !== "sandbox") throw paramError("environment must be production or sandbox.", "environment");
    return c.json(await refundStats(db, c.get("projectId"), { days, sandbox: env === "sandbox", now: deps.now() }));
  });

  r.get(`${P}/refund_requests`, scope("customer_information:customers:read"), async (c) => {
    const projectId = c.get("projectId");
    const { limit, startingAfter } = pageParams(c);
    const rr = schema.refundRequests;
    let cursor: { at: Date; id: string } | null = null;
    if (startingAfter) {
      const [x] = await db.select().from(rr).where(and(eq(rr.projectId, projectId), eq(rr.id, startingAfter))).limit(1);
      if (!x) throw paramError("starting_after does not match an object in this list.", "starting_after");
      cursor = { at: x.requestedAt, id: x.id };
    }
    const rows = await db.select().from(rr).where(and(eq(rr.projectId, projectId), cursor ? or(lt(rr.requestedAt, cursor.at), and(eq(rr.requestedAt, cursor.at), lt(rr.id, cursor.id))) : undefined))
      .orderBy(desc(rr.requestedAt), desc(rr.id)).limit(limit + 1);
    const page = rows.slice(0, limit);
    return c.json(listOf(c, page.map((x) => ({
      object: "refund_request" as const, id: x.id, app_id: x.appId, app_user_id: x.appUserId, store: x.store, environment: x.isSandbox ? "sandbox" : "production",
      transaction_id: x.transactionId, original_transaction_id: x.originalTransactionId, product_id: x.productId, amount_in_usd: x.amountUsd, reason: x.reason,
      requested_at: x.requestedAt.getTime(), deadline_at: x.deadlineAt ? x.deadlineAt.getTime() : null, policy_id: x.policyId, policy_name: x.policyName, preference: x.preference,
      consumption_status: x.consumptionStatus, consumption: x.consumption, attempts: x.attempts, last_error: x.lastError, sent_at: x.sentAt ? x.sentAt.getTime() : null,
      outcome: x.outcome, outcome_at: x.outcomeAt ? x.outcomeAt.getTime() : null,
    })), rows.length > limit ? page[page.length - 1]!.id : null));
  });
}
