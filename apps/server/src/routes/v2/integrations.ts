import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { newId } from "@revenuedot/core";
import { schema } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { body, notFound, paginate, paramError, scope, type V2Router } from "./common.js";

/** RevenueCat's v2 event type names (lower case). We store the webhook payload names (upper case). */
export const WEBHOOK_EVENT_TYPES = [
  "initial_purchase", "renewal", "product_change", "cancellation", "billing_issue", "non_renewing_purchase", "uncancellation", "transfer",
  "subscription_paused", "expiration", "subscription_extended", "invoice_issuance", "temporary_entitlement_grant", "refund_reversed", "virtual_currency_transaction",
] as const;
/** The dashboard also filters on the other RevenueCat event types (TEST, experiment, redemption, alias, price consent). */
export const ALL_WEBHOOK_EVENT_TYPES = [
  ...WEBHOOK_EVENT_TYPES, "test", "experiment_enrollment", "purchase_redeemed", "subscriber_alias", "price_increase_consent_required", "price_increase_consent_approved",
  // RevenueDot funnel events (prd/web-billing/PRD.md §5): opt-in, sent only where the filter names them.
  "funnel_viewed", "funnel_step_completed", "funnel_purchase",
] as const;

const url = z.string().url().refine((u) => /^https?:\/\//i.test(u), "must be an http(s) URL").refine((u) => u.length <= 2048, "is too long");
const Env = z.enum(["production", "sandbox"]).nullable().optional();
const Create = z.object({
  name: z.string().trim().min(1).max(255), url, authorization_header: z.string().max(2048).nullable().optional(),
  environment: Env, event_types: z.array(z.enum(ALL_WEBHOOK_EVENT_TYPES)).optional(), app_id: z.string().min(1).nullable().optional(),
});
/**
 * `enabled` is a RevenueDot extension (RevenueCat's v2 integration has no such field): false pauses deliveries without
 * deleting the integration. Events recorded while it is off are not sent; retries already queued resume when it is on again.
 * The response keeps RevenueCat's shape; GET /v2/projects/{project_id}/webhooks (extensions.ts) reads `enabled`.
 */
const Update = Create.partial().extend({ enabled: z.boolean().optional() });

type Row = typeof schema.webhooks.$inferSelect;

/** `signing_secret` is only included in the response that creates the integration. */
export function webhookShape(w: Row, withSecret = false) {
  return {
    object: "webhook_integration" as const, id: w.id, project_id: w.projectId, name: w.name, url: w.url,
    environment: w.environment === "both" ? null : w.environment,
    event_types: (w.eventTypes ?? []).map((t) => t.toLowerCase()),
    app_id: w.appId ?? null, created_at: w.createdAt.getTime(),
    ...(withSecret ? { signing_secret: w.signingSecret } : {}),
  };
}

const secret = () => `whsec_${Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("")}`;

export function integrationRoutes(r: V2Router, deps: Deps) {
  const { db } = deps;
  const P = "/v2/projects/:project_id/integrations/webhooks";
  const find = async (projectId: string, id: string) => {
    const [w] = await db.select().from(schema.webhooks).where(and(eq(schema.webhooks.projectId, projectId), eq(schema.webhooks.id, id))).limit(1);
    if (!w) throw notFound("Webhook integration");
    return w;
  };
  const checkApp = async (projectId: string, appId: string | null | undefined) => {
    if (!appId) return;
    const [a] = await db.select({ id: schema.apps.id }).from(schema.apps).where(and(eq(schema.apps.projectId, projectId), eq(schema.apps.id, appId))).limit(1);
    if (!a) throw paramError("app_id does not match an app in this project.", "app_id");
  };
  const types = (t: readonly string[] | undefined) => (t === undefined ? undefined : t.length ? t.map((x) => x.toUpperCase()) : null);

  r.get(P, scope("project_configuration:integrations:read"), async (c) => {
    const rows = await db.select().from(schema.webhooks).where(eq(schema.webhooks.projectId, c.get("projectId")));
    return c.json(paginate(c, rows, (w) => w.id, (w) => w.createdAt.getTime(), (w) => webhookShape(w)));
  });

  r.post(P, scope("project_configuration:integrations:read_write"), async (c) => {
    const b = await body(c, Create);
    const projectId = c.get("projectId");
    await checkApp(projectId, b.app_id);
    const [row] = await db.insert(schema.webhooks).values({
      id: newId("wh_", 16), projectId, name: b.name, url: b.url, authorizationHeader: b.authorization_header ?? null, signingSecret: secret(),
      environment: b.environment ?? "both", appId: b.app_id ?? null, eventTypes: types(b.event_types) ?? null, createdAt: deps.now(),
    }).returning();
    return c.json(webhookShape(row!, true), 201);
  });

  r.get(`${P}/:webhook_integration_id`, scope("project_configuration:integrations:read"), async (c) => c.json(webhookShape(await find(c.get("projectId"), c.req.param("webhook_integration_id")))));

  r.post(`${P}/:webhook_integration_id`, scope("project_configuration:integrations:read_write"), async (c) => {
    const w = await find(c.get("projectId"), c.req.param("webhook_integration_id"));
    const b = await body(c, Update);
    await checkApp(w.projectId, b.app_id);
    const et = types(b.event_types);
    const [row] = await db.update(schema.webhooks).set({
      ...(b.name !== undefined ? { name: b.name } : {}), ...(b.url !== undefined ? { url: b.url } : {}),
      ...(b.authorization_header !== undefined ? { authorizationHeader: b.authorization_header } : {}),
      ...(b.environment !== undefined ? { environment: b.environment ?? "both" } : {}),
      ...(b.app_id !== undefined ? { appId: b.app_id } : {}), ...(et !== undefined ? { eventTypes: et } : {}),
      ...(b.enabled !== undefined ? { enabled: b.enabled } : {}),
    }).where(and(eq(schema.webhooks.projectId, w.projectId), eq(schema.webhooks.id, w.id))).returning();
    return c.json(webhookShape(row!));
  });

  // Pending deliveries go with it (FK cascade).
  r.delete(`${P}/:webhook_integration_id`, scope("project_configuration:integrations:read_write"), async (c) => {
    const w = await find(c.get("projectId"), c.req.param("webhook_integration_id"));
    await db.delete(schema.webhooks).where(and(eq(schema.webhooks.projectId, w.projectId), eq(schema.webhooks.id, w.id)));
    return c.json({ object: "webhook_integration", id: w.id, deleted_at: deps.now().getTime() });
  });
}
