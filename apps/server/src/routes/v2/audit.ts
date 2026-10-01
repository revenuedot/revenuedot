import type { MiddlewareHandler } from "hono";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { newId } from "@revenuedot/core";
import { schema } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { listOf, pageParams, paramError, scope, type V2Router, type V2Vars } from "./common.js";

/**
 * Audit log: who changed what in a project. A middleware records every successful write on `/v2/projects/{id}/...`
 * (never reads, never request bodies, which can carry secrets) and `GET .../audit_logs` lists them, newest first.
 */

const SINGULAR: Record<string, string> = {
  apps: "app", products: "product", entitlements: "entitlement", offerings: "offering", packages: "package", customers: "customer",
  subscriptions: "subscription", purchases: "purchase", webhooks: "webhook_integration", api_keys: "api_key", virtual_currencies: "virtual_currency",
  invites: "invite", collaborators: "collaborator", paywalls: "paywall", audiences: "audience", discounts: "discount", experiments: "experiment",
  customer_center_config: "customer_center", test_purchases: "test_purchase", partners: "integration", exports: "data_export",
  refund_control: "refund_control", retention_offers: "retention_offer", support_tickets: "support_ticket", winback_campaigns: "winback_campaign",
};
/** Writes that change nothing worth auditing. */
const QUIET = new Set(["verify_credentials", "preview", "test", "check"]);

interface Parsed { actionType: string; targetType: string; targetId: string | null }

/** `POST /v2/projects/p/products/x/actions/archive` becomes product_archive on x. Returns null for paths we do not audit. */
export function parseWrite(method: string, path: string): Parsed | null {
  const seg = path.split("/").filter(Boolean);
  if (seg[0] !== "v2" || seg[1] !== "projects") return null;
  const rest = seg.slice(3);
  if (!seg[2]) return null;
  if (!rest.length) return method === "POST" ? { actionType: "project_updated", targetType: "project", targetId: seg[2] } : null; // deleting the project deletes its log too (a row for it would break the foreign key)
  let i = 0;
  if (rest[0] === "integrations" || rest[0] === "ads") i = 1;
  const coll = rest[i]!;
  const id = rest[i + 1] ?? null;
  const target = SINGULAR[coll] ?? coll.replace(/s$/, "");
  const tail = rest.slice(i + 2);
  if (tail[0] === "actions" && tail[1]) return QUIET.has(tail[1]) ? null : { actionType: `${target}_${tail[1]}`, targetType: target, targetId: id };
  if (tail.length) return method === "POST" ? { actionType: `${target}_${tail.join("_").replace(/s$/, "")}_created`, targetType: target, targetId: id } : null;
  if (method === "POST") return id ? { actionType: `${target}_updated`, targetType: target, targetId: id } : { actionType: `${target}_created`, targetType: target, targetId: null };
  if (method === "DELETE") return { actionType: `${target}_deleted`, targetType: target, targetId: id };
  return null;
}

export function auditMiddleware(deps: Deps): MiddlewareHandler<{ Variables: V2Vars }> {
  return async (c, next) => {
    await next();
    const method = c.req.method;
    if (method === "GET" || method === "HEAD" || method === "OPTIONS" || c.res.status >= 300) return;
    const projectId = c.req.param("project_id");
    if (!projectId) return;
    const parsed = parseWrite(method, new URL(c.req.url).pathname);
    if (!parsed) return;
    try {
      let targetId = parsed.targetId;
      if (!targetId) {
        const j = (await c.res.clone().json().catch(() => null)) as { id?: string; code?: string } | null;
        targetId = j?.id ?? j?.code ?? projectId;
      }
      const p = c.get("principal");
      let actorType = "user";
      let actor = "unknown";
      if (p.kind === "user") actor = p.userId;
      else {
        const [k] = await deps.db.select({ name: schema.apiKeys.name }).from(schema.apiKeys).where(eq(schema.apiKeys.id, p.keyId)).limit(1);
        actorType = k?.name.startsWith("OAuth: ") ? "oauth_client" : "api_key";
        actor = p.keyId;
      }
      await deps.db.insert(schema.auditLogs).values({
        id: newId("log", 12), projectId, actionType: parsed.actionType, targetType: parsed.targetType, targetIdentifier: targetId, actorType, actorIdentifier: actor,
        additionalData: { method, status: c.res.status, ...(actorType === "oauth_client" && p.kind === "key" ? { key_id: p.keyId } : {}) }, occurredAt: deps.now(),
      });
    } catch (e) {
      // An audit failure must never fail the write it describes.
      console.error("audit log failed", e);
    }
  };
}

export function auditRoutes(r: V2Router, deps: Deps) {
  const { db } = deps;
  r.get("/v2/projects/:project_id/audit_logs", scope("project_configuration:audit_logs:read"), async (c) => {
    const projectId = c.get("projectId");
    const { limit, startingAfter } = pageParams(c);
    const A = schema.auditLogs;
    const conds = [eq(A.projectId, projectId)];
    const day = (name: string) => {
      const v = c.req.query(name);
      if (v === undefined) return null;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw paramError(`${name} must be a date such as 2026-01-31.`, name);
      return new Date(`${v}T00:00:00Z`);
    };
    const from = day("start_date"), to = day("end_date");
    if (from) conds.push(gte(A.occurredAt, from));
    if (to) conds.push(lt(A.occurredAt, new Date(to.getTime() + 86400_000)));
    if (startingAfter) {
      const [cur] = await db.select().from(A).where(and(eq(A.projectId, projectId), eq(A.id, startingAfter))).limit(1);
      if (!cur) throw paramError("starting_after does not match a log entry in this project.", "starting_after");
      conds.push(sql`(${A.occurredAt}, ${A.id}) < (${cur.occurredAt.toISOString()}::timestamptz, ${cur.id})`);
    }
    const rows = await db.select().from(A).where(and(...conds)).orderBy(desc(A.occurredAt), desc(A.id)).limit(limit + 1);
    const page = rows.slice(0, limit);
    return c.json(listOf(c, page.map((x) => ({
      object: "audit_log" as const, id: x.id, project_id: x.projectId, action_type: x.actionType, target_type: x.targetType, target_identifier: x.targetIdentifier,
      actor_type: x.actorType, actor_identifier: x.actorIdentifier, occurred_at: x.occurredAt.getTime(), additional_data: x.additionalData,
    })), rows.length > limit ? page[page.length - 1]!.id : null));
  });
}
