import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { schema } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { productInfo } from "../../repo/catalog.js";
import { findCustomer, getOrCreateCustomer } from "../../repo/customers.js";
import { createSecretKey } from "../../services/auth.js";
import { applyPurchases } from "../../services/purchases.js";
import { retryDelivery } from "../../services/webhooks.js";
import { V2Error, allows, body, listOf, notFound, pageParams, paginate, paramError, scope, type V2Context, type V2Router } from "./common.js";
import { appleKeyConfigured, customerShape, googleKeyConfigured, loadCatalog, purchaseShape, subscriptionRevenue, subscriptionShape } from "./shapes.js";

/**
 * RevenueDot extensions to API v2. These paths are NOT in RevenueCat's API; they serve our dashboard and use the
 * same auth, scoping, error format and list envelope as the rest of v2:
 *   GET    /v2/projects/{project_id}/transactions                              transaction feed, newest first
 *   GET    /v2/projects/{project_id}/events                                    event log (?type=&customer=&environment=)
 *   GET    /v2/projects/{project_id}/webhooks/{webhook_id}/deliveries          delivery log (?status=)
 *   POST   /v2/projects/{project_id}/webhooks/{webhook_id}/deliveries/{id}/retry
 *   GET    /v2/projects/{project_id}/setup_health                              store notifications, credentials, webhook health
 *   GET    /v2/projects/{project_id}/api_keys                                  secret keys (never the key itself)
 *   POST   /v2/projects/{project_id}/api_keys                                  create; the plaintext key is returned once
 *   DELETE /v2/projects/{project_id}/api_keys/{key_id}
 *   POST   /v2/projects/{project_id}/test_purchases                            simulate a Test Store purchase
 * Scope `project_configuration:api_keys:read(_write)` is ours too.
 */

const Env = z.enum(["sandbox", "production"]).optional();
const KeyCreate = z.object({ name: z.string().trim().min(1).max(100), permissions: z.array(z.string().min(1).max(200)).min(1).max(100).optional() });
const TestPurchase = z.object({
  app_user_id: z.string().min(1).max(100),
  product_id: z.string().min(1),
  app_id: z.string().min(1).optional(),
  price: z.number().min(0).optional(),
  currency: z.string().length(3).optional(),
  purchased_at: z.number().int().optional(),
  presented_offering_id: z.string().optional(),
});

export function extensionRoutes(r: V2Router, deps: Deps) {
  const { db } = deps;
  const P = "/v2/projects/:project_id";
  const envOf = (c: V2Context) => {
    const x = Env.safeParse(c.req.query("environment") || undefined);
    if (!x.success) throw paramError("environment must be sandbox or production.", "environment");
    return x.data;
  };

  // Transactions: every purchase, renewal, trial start and refund, joined with the customer's app user id.
  r.get(`${P}/transactions`, scope("customer_information:purchases:read"), async (c) => {
    const projectId = c.get("projectId");
    const { limit, startingAfter } = pageParams(c);
    const env = envOf(c);
    const T = schema.transactions;
    const conds = [eq(T.projectId, projectId), ...(env ? [eq(T.isSandbox, env === "sandbox")] : [])];
    const customer = c.req.query("customer");
    if (customer) {
      const cu = await findCustomer(db, projectId, customer);
      if (!cu) return c.json(listOf(c, [], null));
      conds.push(eq(T.customerId, cu.id));
    }
    if (startingAfter) {
      const [cur] = await db.select().from(T).where(and(eq(T.projectId, projectId), eq(T.id, startingAfter))).limit(1);
      if (!cur) throw paramError("starting_after does not match a transaction in this project.", "starting_after");
      conds.push(sql`(${T.purchasedAt}, ${T.id}) < (${cur.purchasedAt.toISOString()}::timestamptz, ${cur.id})`);
    }
    const rows = await db.select({ t: T, appUserId: schema.customers.originalAppUserId }).from(T).innerJoin(schema.customers, eq(schema.customers.id, T.customerId))
      .where(and(...conds)).orderBy(desc(T.purchasedAt), desc(T.id)).limit(limit + 1);
    const page = rows.slice(0, limit);
    return c.json(listOf(c, page.map(({ t, appUserId }) => ({
      object: "transaction", id: t.id, customer_id: appUserId, app_id: t.appId, store: t.store, store_transaction_id: t.storeTransactionId,
      product_identifier: t.productIdentifier, kind: t.kind, environment: t.isSandbox ? "sandbox" : "production",
      purchased_at: t.purchasedAt.getTime(), expires_at: t.expiresAt ? t.expiresAt.getTime() : null, revenue_in_usd: t.revenueUsd,
      price: t.priceAmount !== null && t.priceCurrency ? { amount: t.priceAmount, currency: t.priceCurrency } : null, country: t.countryCode,
    })), rows.length > limit ? page[page.length - 1]!.t.id : null));
  });

  // Event log. `body` is the webhook `event` object exactly as webhooks receive it.
  r.get(`${P}/events`, scope("customer_information:customers:read"), async (c) => {
    const projectId = c.get("projectId");
    const { limit, startingAfter } = pageParams(c);
    const env = envOf(c);
    const E = schema.events;
    const conds = [eq(E.projectId, projectId), ...(env ? [eq(E.environment, env)] : [])];
    const types = (c.req.queries("type") ?? []).flatMap((t) => t.split(",")).map((t) => t.trim().toUpperCase()).filter(Boolean);
    if (types.length) conds.push(inArray(E.type, types));
    const customer = c.req.query("customer");
    if (customer) {
      const cu = await findCustomer(db, projectId, customer);
      if (!cu) return c.json(listOf(c, [], null));
      conds.push(eq(E.customerId, cu.id));
    }
    if (startingAfter) {
      const [cur] = await db.select().from(E).where(and(eq(E.projectId, projectId), eq(E.id, startingAfter))).limit(1);
      if (!cur) throw paramError("starting_after does not match an event in this project.", "starting_after");
      conds.push(sql`(${E.eventTimestampMs}, ${E.id}) < (${cur.eventTimestampMs}, ${cur.id})`);
    }
    const rows = await db.select().from(E).where(and(...conds)).orderBy(desc(E.eventTimestampMs), desc(E.id)).limit(limit + 1);
    const page = rows.slice(0, limit);
    return c.json(listOf(c, page.map((e) => {
      const ev = ((e.payload as { event?: Record<string, unknown> }).event ?? {}) as Record<string, unknown>;
      return {
        object: "event", id: e.id, type: e.type, environment: e.environment, app_id: e.appId,
        customer_id: (ev.original_app_user_id as string | undefined) ?? null, app_user_id: (ev.app_user_id as string | undefined) ?? null,
        occurred_at: e.eventTimestampMs, created_at: e.createdAt.getTime(), body: ev,
      };
    }), rows.length > limit ? page[page.length - 1]!.id : null));
  });

  // Webhook delivery log and manual retry.
  const findHook = async (c: V2Context) => {
    const [w] = await db.select().from(schema.webhooks).where(and(eq(schema.webhooks.projectId, c.get("projectId")), eq(schema.webhooks.id, c.req.param("webhook_id")!))).limit(1);
    if (!w) throw notFound("Webhook integration");
    return w;
  };
  const deliveryShape = (d: typeof schema.webhookDeliveries.$inferSelect, eventType: string) => ({
    object: "webhook_delivery", id: d.id, webhook_integration_id: d.webhookId, event_id: d.eventId, event_type: eventType, status: d.status,
    attempts: d.attempts, next_attempt_at: d.status === "pending" ? d.nextAttemptAt.getTime() : null, response_status: d.responseStatus,
    response_ms: d.responseMs, last_error: d.lastError, created_at: d.createdAt.getTime(),
  });

  r.get(`${P}/webhooks/:webhook_id/deliveries`, scope("project_configuration:integrations:read"), async (c) => {
    const w = await findHook(c);
    const { limit, startingAfter } = pageParams(c);
    const D = schema.webhookDeliveries;
    const conds = [eq(D.webhookId, w.id)];
    const status = c.req.query("status");
    if (status) {
      if (!["pending", "delivered", "failed"].includes(status)) throw paramError("status must be pending, delivered or failed.", "status");
      conds.push(eq(D.status, status));
    }
    if (startingAfter) {
      const [cur] = await db.select().from(D).where(and(eq(D.webhookId, w.id), eq(D.id, startingAfter))).limit(1);
      if (!cur) throw paramError("starting_after does not match a delivery of this webhook.", "starting_after");
      conds.push(sql`(${D.createdAt}, ${D.id}) < (${cur.createdAt.toISOString()}::timestamptz, ${cur.id})`);
    }
    const rows = await db.select({ d: D, type: schema.events.type }).from(D).innerJoin(schema.events, eq(schema.events.id, D.eventId))
      .where(and(...conds)).orderBy(desc(D.createdAt), desc(D.id)).limit(limit + 1);
    const page = rows.slice(0, limit);
    return c.json(listOf(c, page.map((x) => deliveryShape(x.d, x.type)), rows.length > limit ? page[page.length - 1]!.d.id : null));
  });

  r.post(`${P}/webhooks/:webhook_id/deliveries/:delivery_id/retry`, scope("project_configuration:integrations:read_write"), async (c) => {
    const w = await findHook(c);
    const D = schema.webhookDeliveries;
    const [d] = await db.select().from(D).where(and(eq(D.webhookId, w.id), eq(D.id, c.req.param("delivery_id")))).limit(1);
    if (!d) throw notFound("Webhook delivery");
    await retryDelivery(db, d.id, deps.now());
    deps.kick?.();
    const [row] = await db.select({ d: D, type: schema.events.type }).from(D).innerJoin(schema.events, eq(schema.events.id, D.eventId)).where(eq(D.id, d.id));
    return c.json(deliveryShape(row!.d, row!.type));
  });

  // Setup health: is each app wired up, and are webhooks getting through?
  r.get(`${P}/setup_health`, scope("project_configuration:apps:read"), async (c) => {
    const projectId = c.get("projectId");
    const now = deps.now();
    const fwdHost = c.req.header("x-forwarded-host");
    const origin = fwdHost ? `${c.req.header("x-forwarded-proto") ?? "https"}://${fwdHost}` : new URL(c.req.url).origin;
    const apps = await db.select().from(schema.apps).where(eq(schema.apps.projectId, projectId));
    const lastNotif = await db.select({ appId: schema.storeNotifications.appId, at: sql<string>`max(${schema.storeNotifications.receivedAt})` }).from(schema.storeNotifications)
      .where(eq(schema.storeNotifications.projectId, projectId)).groupBy(schema.storeNotifications.appId);
    const appItems = apps.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map((a) => {
      const store = a.type === "app_store" || a.type === "mac_app_store" ? "apple" : a.type === "play_store" ? "google" : null;
      const seen = [a.lastNotificationAt?.getTime() ?? null, ...lastNotif.filter((n) => n.appId === a.id).map((n) => (n.at ? new Date(n.at).getTime() : null))].filter((x): x is number => x !== null);
      const cr = a.credentials ?? {};
      const credentials = a.type === "test_store" ? true : store === "apple" ? appleKeyConfigured(cr) : store === "google" ? googleKeyConfigured(cr) : Object.keys(cr).length > 0;
      return {
        id: a.id, name: a.name, type: a.type,
        notification_url: store ? `${origin}/v1/notifications/${store}/${a.id}` : null,
        last_notification_at: seen.length ? Math.max(...seen) : null,
        credentials_configured: credentials,
      };
    });

    const since = new Date(now.getTime() - 86400_000);
    const hooks = await db.select().from(schema.webhooks).where(eq(schema.webhooks.projectId, projectId));
    const D = schema.webhookDeliveries;
    const recent = hooks.length ? await db.select().from(D).where(and(inArray(D.webhookId, hooks.map((h) => h.id)), gte(D.createdAt, since))) : [];
    const attempted = recent.filter((d) => d.attempts > 0);
    const delivered = attempted.filter((d) => d.status === "delivered").length;
    const failing = [];
    for (const h of hooks) {
      const [last] = await db.select().from(D).where(and(eq(D.webhookId, h.id), sql`${D.attempts} > 0`)).orderBy(desc(D.nextAttemptAt), desc(D.createdAt)).limit(1);
      if (last && last.status !== "delivered") {
        failing.push({ id: h.id, name: h.name, url: h.url, last_status: last.responseStatus, last_error: last.lastError, last_attempt_at: last.nextAttemptAt.getTime(), delivery_status: last.status });
      }
    }
    return c.json({
      object: "setup_health", project_id: projectId, checked_at: now.getTime(),
      apps: appItems,
      webhooks: {
        total: hooks.length, attempted_24h: attempted.length, delivered_24h: delivered, failed_24h: attempted.filter((d) => d.status === "failed").length,
        pending: recent.filter((d) => d.status === "pending").length,
        delivered_percent_24h: attempted.length ? Math.round((delivered / attempted.length) * 1000) / 10 : null,
        failing,
      },
      // The SDK version header is not recorded yet; the panel shows app versions until it is.
      sdk_versions: null,
    });
  });

  // Secret API keys.
  const keyShape = (k: typeof schema.apiKeys.$inferSelect) => ({
    object: "api_key", id: k.id, name: k.name, prefix: k.prefix, permissions: k.permissions, created_at: k.createdAt.getTime(), last_used_at: k.lastUsedAt ? k.lastUsedAt.getTime() : null,
  });

  r.get(`${P}/api_keys`, scope("project_configuration:api_keys:read"), async (c) => {
    const rows = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.projectId, c.get("projectId")));
    return c.json(paginate(c, rows, (k) => k.id, (k) => k.createdAt.getTime(), keyShape));
  });

  r.post(`${P}/api_keys`, scope("project_configuration:api_keys:read_write"), async (c) => {
    const b = await body(c, KeyCreate);
    const permissions = b.permissions ?? ["*"];
    // A key can only mint keys with permissions it holds itself.
    const p = c.get("principal");
    const escalates = permissions.filter((x) => (x === "*" || x.endsWith(":*") ? p.kind === "key" && !p.permissions.includes("*") : !allows(p, x)));
    if (escalates.length) throw new V2Error(403, "authorization_error", `You cannot grant permissions you do not have: ${escalates.join(", ")}.`, "permissions");
    const { id, key } = await createSecretKey(db, c.get("projectId"), b.name, permissions);
    const [row] = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, id));
    return c.json({ ...keyShape(row!), key }, 201);
  });

  r.delete(`${P}/api_keys/:key_id`, scope("project_configuration:api_keys:read_write"), async (c) => {
    const [k] = await db.select().from(schema.apiKeys).where(and(eq(schema.apiKeys.projectId, c.get("projectId")), eq(schema.apiKeys.id, c.req.param("key_id")))).limit(1);
    if (!k) throw notFound("API key");
    await db.delete(schema.apiKeys).where(and(eq(schema.apiKeys.projectId, k.projectId), eq(schema.apiKeys.id, k.id)));
    return c.json({ object: "api_key", id: k.id, deleted_at: deps.now().getTime() });
  });

  // Test Store purchase from the dashboard: the same adapter and purchase pipeline as an SDK receipt post.
  r.post(`${P}/test_purchases`, scope("customer_information:purchases:read_write"), async (c) => {
    const projectId = c.get("projectId");
    const b = await body(c, TestPurchase);
    const now = deps.now();
    const apps = await db.select().from(schema.apps).where(and(eq(schema.apps.projectId, projectId), eq(schema.apps.type, "test_store")));
    const app = b.app_id ? apps.find((a) => a.id === b.app_id) : apps[0];
    if (!app) throw paramError(b.app_id ? "app_id does not match a Test Store app in this project." : "This project has no Test Store app.", "app_id");
    const [prod] = await db.select().from(schema.products).where(and(eq(schema.products.projectId, projectId), eq(schema.products.appId, app.id),
      sql`(${schema.products.id} = ${b.product_id} or ${schema.products.storeIdentifier} = ${b.product_id})`)).limit(1);
    if (!prod) throw paramError("product_id does not match a product of the Test Store app.", "product_id");
    const adapter = deps.stores.test_store;
    if (!adapter) throw new V2Error(422, "store_error", "The Test Store is not enabled on this server.");
    const at = b.purchased_at ?? now.getTime();
    const token = `test_${at}_${crypto.randomUUID()}`;
    const purchases = await adapter.verify(app, {
      fetchToken: token, appTransaction: null, transactionId: null, productIds: [prod.storeIdentifier], platformProducts: [],
      price: b.price ?? null, currency: b.price !== undefined ? b.currency ?? "USD" : null, storeCountry: null, normalDuration: null,
      isRestore: false, isSandboxHeader: true, storeUserId: null,
    }, await productInfo(db, app.id));
    const { customer } = await getOrCreateCustomer(db, projectId, b.app_user_id, now);
    const owner = await applyPurchases(db, customer, purchases, { projectId, appId: app.id, appUserId: b.app_user_id, now, presentedOfferingId: b.presented_offering_id ?? null, fromDevice: true });
    deps.kick?.();
    const cat = await loadCatalog(db, projectId);
    const [sub] = await db.select().from(schema.subscriptions).where(and(eq(schema.subscriptions.projectId, projectId), eq(schema.subscriptions.store, "test_store"), eq(schema.subscriptions.storeKey, token)));
    const [one] = await db.select().from(schema.nonSubscriptions).where(and(eq(schema.nonSubscriptions.projectId, projectId), eq(schema.nonSubscriptions.store, "test_store"), eq(schema.nonSubscriptions.storeTransactionId, token)));
    const rev = sub ? await subscriptionRevenue(db, [sub]) : null;
    return c.json({
      object: "test_purchase", store_transaction_id: token,
      customer: await customerShape(db, owner, { now, detail: true }),
      subscription: sub ? subscriptionShape(sub, owner.originalAppUserId, cat, rev!.get(sub.id) ?? 0, now) : null,
      purchase: one ? purchaseShape(one, owner.originalAppUserId, cat) : null,
    }, 201);
  });
}
