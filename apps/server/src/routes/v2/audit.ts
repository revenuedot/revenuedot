import type { MiddlewareHandler } from "hono";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { newId } from "@revenuedot/core";
import { schema } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { listOf, pageParams, paramError, scope, type Principal, type V2Router, type V2Vars } from "./common.js";

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
  blocked_customers: "blocked_customer", verified_metrics: "verified_metrics", brand: "brand", fonts: "font", providers: "auth_provider",
  identities: "auth_identity", settings: "auth_settings",
};
/** One object per project: a POST without an id updates it. */
const SINGLETONS = new Set(["brand", "verified_metrics", "auth_settings"]);
/** Writes that change nothing worth auditing. */
const QUIET = new Set(["verify_credentials", "verify_app_store_connect_key", "preview", "test", "check", "advance", "refresh", "estimate"]);

interface Parsed { actionType: string; targetType: string; targetId: string | null }

/** `POST /v2/projects/p/products/x/actions/archive` becomes product_archive on x. Returns null for paths we do not audit. */
export function parseWrite(method: string, path: string): Parsed | null {
  // Segments are decoded one by one, so an id such as `$RCAnonymousID:…` is logged as the id, not `%24RCAnonymousID%3A…`.
  const seg = path.split("/").filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
  if (seg[0] !== "v2" || seg[1] !== "projects") return null;
  const rest = seg.slice(3);
  if (!seg[2]) return null;
  if (!rest.length) return method === "POST" ? { actionType: "project_updated", targetType: "project", targetId: seg[2] } : null; // deleting the project deletes its log too (a row for it would break the foreign key)
  // Project actions: POST /v2/projects/p/actions/transfer_ownership is project_transfer_ownership.
  if (rest[0] === "actions" && rest[1]) return method === "POST" ? { actionType: `project_${rest[1]}`, targetType: "project", targetId: seg[2] } : null;
  // RevenueDot AI: the setting is project configuration; chats, files and the first-sale card change nothing in the
  // project (the assistant's own writes go through the API's routes and are audited there).
  if (rest[0] === "ai") return rest[1] === "settings" && method === "POST" ? { actionType: "ai_settings_updated", targetType: "project", targetId: seg[2] } : null;
  // Benchmarks: sharing and the category are project configuration (prd/attribution-benchmarks-insights §2).
  if (rest[0] === "benchmarks") return rest[1] === "settings" && method === "POST" ? { actionType: "benchmarks_settings_updated", targetType: "project", targetId: seg[2] } : null;
  let i = 0;
  if (rest[0] === "integrations" || rest[0] === "ads" || rest[0] === "auth") i = 1;
  const coll = rest[i]!;
  let id = rest[i + 1] ?? null;
  const target = SINGULAR[coll] ?? coll.replace(/s$/, "");
  let tail = rest.slice(i + 2);
  // An Auth identity is named by provider and subject.
  if (coll === "identities" && tail.length === 1) { id = `${id}/${tail[0]}`; tail = []; }
  // A collection action: POST /v2/projects/p/experiments/actions/reorder is experiment_reorder on the project.
  if (id === "actions" && tail.length === 1) return method === "POST" && !QUIET.has(tail[0]!) ? { actionType: `${target}_${tail[0]}`, targetType: target, targetId: seg[2] } : null;
  if (tail[0] === "actions" && tail[1]) return QUIET.has(tail[1]) ? null : { actionType: `${target}_${tail[1]}`, targetType: target, targetId: id };
  // A sub-collection's action: POST /v2/projects/p/apps/a/store_products/actions/import is app_store_products_import on a.
  if (tail.length === 3 && tail[1] === "actions") return method === "POST" && !QUIET.has(tail[2]!) ? { actionType: `${target}_${tail[0]}_${tail[2]}`, targetType: target, targetId: id } : null;
  if (tail.length) return method === "POST" ? { actionType: `${target}_${tail.join("_").replace(/s$/, "")}_created`, targetType: target, targetId: id } : null;
  if (method === "POST" && SINGLETONS.has(target)) return { actionType: `${target}_updated`, targetType: target, targetId: seg[2] };
  if (method === "POST") return id ? { actionType: `${target}_updated`, targetType: target, targetId: id } : { actionType: `${target}_created`, targetType: target, targetId: null };
  if (method === "PATCH") return id ? { actionType: `${target}_updated`, targetType: target, targetId: id } : null;
  if (method === "DELETE") return { actionType: `${target}_deleted`, targetType: target, targetId: id };
  return null;
}

/** Who an audit entry names: a user, RevenueDot AI on a user's behalf, an API key or an OAuth client. */
export interface AuditActor { actorType: string; actorIdentifier: string; data: Record<string, unknown> }

export async function auditActor(deps: Deps, p: Principal): Promise<AuditActor> {
  if (p.kind === "user" && p.via === "assistant") {
    // RevenueDot AI acting for a user after they approved the change in the chat (prd/ai-assistant/PRD.md §2).
    return { actorType: "assistant", actorIdentifier: p.userId, data: { actor_display: `assistant on behalf of ${p.email ?? p.userId}`, on_behalf_of: p.userId, conversation_id: p.conversationId } };
  }
  if (p.kind === "user") return { actorType: "user", actorIdentifier: p.userId, data: {} };
  const [k] = await deps.db.select({ name: schema.apiKeys.name }).from(schema.apiKeys).where(eq(schema.apiKeys.id, p.keyId)).limit(1);
  const oauth = !!k?.name.startsWith("OAuth: ");
  return { actorType: oauth ? "oauth_client" : "api_key", actorIdentifier: p.keyId, data: oauth ? { key_id: p.keyId } : {} };
}

/** An audit entry written by a service for one change it made (a store write of the product editor, for example). */
export async function writeAudit(deps: Deps, projectId: string, actor: AuditActor, entry: { actionType: string; targetType: string; targetIdentifier: string; data: Record<string, unknown> }) {
  try {
    await deps.db.insert(schema.auditLogs).values({
      id: newId("log", 12), projectId, actionType: entry.actionType, targetType: entry.targetType, targetIdentifier: entry.targetIdentifier,
      actorType: actor.actorType, actorIdentifier: actor.actorIdentifier, additionalData: { ...entry.data, ...actor.data }, occurredAt: deps.now(),
    });
  } catch (e) {
    console.error("audit log failed", e);
  }
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
      const a = await auditActor(deps, c.get("principal"));
      await deps.db.insert(schema.auditLogs).values({
        id: newId("log", 12), projectId, actionType: parsed.actionType, targetType: parsed.targetType, targetIdentifier: targetId, actorType: a.actorType, actorIdentifier: a.actorIdentifier,
        additionalData: { method, status: c.res.status, ...a.data }, occurredAt: deps.now(),
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
