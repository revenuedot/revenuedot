import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { schema } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { findCustomer, getOrCreateCustomer } from "../../repo/customers.js";
import { accessOf } from "../../repo/access.js";
import { createSecretKey } from "../../services/auth.js";
import { CONVERTIBLE_CURRENCIES } from "../../services/fx.js";
import { applyPurchases } from "../../services/purchases.js";
import { recordDueExpirations } from "../../services/tick.js";
import { TEST_SCENARIOS, testStoreScenario } from "../../stores/test-store.js";
import { apiDeliveryStatus, ATTEMPT_LOG_DAYS, retryDelivery, webhookRequest } from "../../services/webhooks.js";
import { HISTORY_METRICS, metricHistory, type HistoryMetric } from "../../services/metric-history.js";
import { customerSummary } from "../../services/customer-summary.js";
import { sdkVersionsOf } from "../../services/sdk-versions.js";
import { notificationHealth } from "./notification-health.js";
import { V2Error, allows, body, listOf, notFound, pageParams, paginate, paramError, scope, type V2Context, type V2Router } from "./common.js";
import { customerShape, loadCatalog, notificationStoreOf, storeCredentialsConfigured, purchaseShape, subscriptionRevenue, subscriptionShape } from "./shapes.js";
import { requestOrigin } from "../../services/account-email.js";

/**
 * RevenueDot extensions to API v2. These paths are NOT in RevenueCat's API; they serve our dashboard and use the
 * same auth, scoping, error format and list envelope as the rest of v2:
 *   GET    /v2/projects/{project_id}/transactions                              transaction feed, newest first
 *   GET    /v2/projects/{project_id}/events                                    event log (?type=&customer=&environment=)
 *   GET    /v2/projects/{project_id}/webhooks                                  whether each webhook integration is enabled
 *   GET    /v2/projects/{project_id}/webhooks/{webhook_id}/deliveries          delivery log (?status=)
 *   GET    /v2/projects/{project_id}/webhooks/{webhook_id}/deliveries/{id}         one delivery: request, every attempt, cURL
 *   POST   /v2/projects/{project_id}/webhooks/{webhook_id}/deliveries/{id}/retry
 *   GET    /v2/projects/{project_id}/setup_health                              store notifications, credentials, webhook health
 *   GET    /v2/projects/{project_id}/api_keys                                  secret keys (never the key itself)
 *   POST   /v2/projects/{project_id}/api_keys                                  create; the plaintext key is returned once
 *   DELETE /v2/projects/{project_id}/api_keys/{key_id}
 *   POST   /v2/projects/{project_id}/test_purchases                            simulate a Test Store purchase or lifecycle (scenario, offset_days)
 *   GET    /v2/projects/{project_id}/metrics/history?metric=&days=&environment= daily history behind an Overview card
 *   GET    /v2/projects/{project_id}/customer_summaries?ids=a,b               revenue, entitlement names, prices per customer
 * Scope `project_configuration:api_keys:read(_write)` is ours too.
 */

const Env = z.enum(["sandbox", "production"]).optional();
const KeyCreate = z.object({ name: z.string().trim().min(1).max(100), permissions: z.array(z.string().min(1).max(200)).min(1).max(100).optional() });
const TestPurchase = z.object({
  app_user_id: z.string().min(1).max(100),
  product_id: z.string().min(1),
  app_id: z.string().min(1).optional(),
  price: z.number().min(0).optional(),
  currency: z.string().length(3).transform((c) => c.toUpperCase())
    .refine((c) => CONVERTIBLE_CURRENCIES.has(c), "is not a currency RevenueDot can convert to USD; use an ISO 4217 code such as USD or EUR").optional(),
  purchased_at: z.number().int().optional(),
  presented_offering_id: z.string().optional(),
  /** A lifecycle to simulate (see stores/test-store.ts testStoreScenario); default purchase. */
  scenario: z.enum(TEST_SCENARIOS).optional(),
  /** How many days ago the scenario starts (default depends on the scenario). */
  offset_days: z.number().min(0).max(730).optional(),
  country_code: z.string().regex(/^[A-Z]{2}$/).optional(),
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
    object: "webhook_delivery", id: d.id, webhook_integration_id: d.webhookId, event_id: d.eventId, event_type: eventType, status: apiDeliveryStatus(d.status),
    attempts: d.attempts, next_attempt_at: d.status === "pending" || d.status === "sending" ? d.nextAttemptAt.getTime() : null, response_status: d.responseStatus,
    response_ms: d.responseMs, last_error: d.lastError, created_at: d.createdAt.getTime(),
  });

  // `enabled` is set with RevenueCat's update call (POST …/integrations/webhooks/{id}); RevenueCat's integration object has
  // no such field, so it is read here and the integration responses keep RevenueCat's exact shape.
  r.get(`${P}/webhooks`, scope("project_configuration:integrations:read"), async (c) => {
    const rows = await db.select({ id: schema.webhooks.id, enabled: schema.webhooks.enabled }).from(schema.webhooks)
      .where(eq(schema.webhooks.projectId, c.get("projectId"))).orderBy(schema.webhooks.createdAt, schema.webhooks.id);
    return c.json(listOf(c, rows.map((w) => ({ object: "webhook_state" as const, id: w.id, enabled: w.enabled })), null));
  });

  r.get(`${P}/webhooks/:webhook_id/deliveries`, scope("project_configuration:integrations:read"), async (c) => {
    const w = await findHook(c);
    const { limit, startingAfter } = pageParams(c);
    const D = schema.webhookDeliveries;
    const conds = [eq(D.webhookId, w.id)];
    const status = c.req.query("status");
    if (status) {
      if (!["pending", "delivered", "failed"].includes(status)) throw paramError("status must be pending, delivered or failed.", "status");
      // A delivery being sent right now ("sending", claimed by a job run) is still pending to the API.
      conds.push(status === "pending" ? inArray(D.status, ["pending", "sending"]) : eq(D.status, status));
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

  // One delivery with what was sent and every attempt's answer. Bodies can hold customer data, so Admins and Developers only.
  r.get(`${P}/webhooks/:webhook_id/deliveries/:delivery_id`, scope("project_configuration:integrations:read_write"), async (c) => {
    const w = await findHook(c);
    const D = schema.webhookDeliveries;
    const [row] = await db.select({ d: D, e: schema.events }).from(D).innerJoin(schema.events, eq(schema.events.id, D.eventId))
      .where(and(eq(D.webhookId, w.id), eq(D.id, c.req.param("delivery_id")))).limit(1);
    if (!row) throw notFound("Webhook delivery");
    const log = row.d.attemptLog ?? [];
    const { curl, ...request } = webhookRequest(w, row.e.payload, log.at(-1)?.signature ?? null);
    return c.json({
      ...deliveryShape(row.d, row.e.type), request, curl,
      attempt_log: log.map((a) => ({ attempted_at: a.at, response_status: a.status, response_ms: a.ms, error: a.error, response_body: a.response_body, signature: a.signature ?? null })),
      attempt_log_kept_days: ATTEMPT_LOG_DAYS,
    });
  });

  r.post(`${P}/webhooks/:webhook_id/deliveries/:delivery_id/retry`, scope("project_configuration:integrations:read_write"), async (c) => {
    const w = await findHook(c);
    const D = schema.webhookDeliveries;
    const [d] = await db.select().from(D).where(and(eq(D.webhookId, w.id), eq(D.id, c.req.param("delivery_id")))).limit(1);
    if (!d) throw notFound("Webhook delivery");
    if (!(await retryDelivery(db, d.id, deps.now()))) {
      throw new V2Error(409, "resource_locked_error", "This delivery is being sent right now. Try again in a minute.", undefined, true);
    }
    deps.kick?.();
    const [row] = await db.select({ d: D, type: schema.events.type }).from(D).innerJoin(schema.events, eq(schema.events.id, D.eventId)).where(eq(D.id, d.id));
    return c.json(deliveryShape(row!.d, row!.type));
  });

  // Setup health: is each app wired up, and are webhooks getting through?
  r.get(`${P}/setup_health`, scope("project_configuration:apps:read"), async (c) => {
    const projectId = c.get("projectId");
    const now = deps.now();
    const origin = requestOrigin(c.req.url, (n) => c.req.header(n));
    const apps = await db.select().from(schema.apps).where(eq(schema.apps.projectId, projectId));
    const appItems = [];
    for (const a of apps.sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime())) {
      const store = notificationStoreOf(a.type);
      const credentials = storeCredentialsConfigured(a);
      appItems.push({
        id: a.id, name: a.name, type: a.type,
        notification_url: store ? `${origin}/v1/notifications/${store}/${a.id}` : null,
        ...(await notificationHealth(db, a)),
        credentials_configured: credentials,
      });
    }

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
        failing.push({ id: h.id, name: h.name, url: h.url, last_status: last.responseStatus, last_error: last.lastError, last_attempt_at: last.nextAttemptAt.getTime(), delivery_status: apiDeliveryStatus(last.status) });
      }
    }
    return c.json({
      object: "setup_health", project_id: projectId, checked_at: now.getTime(),
      apps: appItems,
      webhooks: {
        total: hooks.length, attempted_24h: attempted.length, delivered_24h: delivered, failed_24h: attempted.filter((d) => d.status === "failed").length,
        pending: recent.filter((d) => d.status === "pending" || d.status === "sending").length,
        delivered_percent_24h: attempted.length ? Math.round((delivered / attempted.length) * 1000) / 10 : null,
        failing,
      },
      // Which SDK builds call the SDK endpoints (X-Platform, X-Version, X-Platform-Flavor ...), newest first.
      sdk_versions: await sdkVersionsOf(db, projectId, now),
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
    // RevenueDot Cloud: secret keys need a confirmed email address (prd/account-email/PRD.md).
    const who = c.get("principal");
    if (who.kind === "user" && deps.edition === "cloud") {
      const [u] = await db.select({ v: schema.users.emailVerifiedAt }).from(schema.users).where(eq(schema.users.id, who.userId));
      if (!u?.v) throw new V2Error(403, "authorization_error", "Confirm your email address before creating secret API keys. We sent you a link when you signed up; you can send a new one from the banner.");
    }
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
    if (!deps.stores.test_store) throw new V2Error(422, "store_error", "The Test Store is not enabled on this server.");
    if (b.purchased_at !== undefined && b.offset_days !== undefined) throw paramError("Send purchased_at or offset_days, not both.", "offset_days");
    const start = b.purchased_at !== undefined ? new Date(b.purchased_at) : b.offset_days !== undefined ? new Date(now.getTime() - b.offset_days * 86400_000) : null;
    const scenario = b.scenario ?? "purchase";
    const token = `test_${(start ?? now).getTime()}_${crypto.randomUUID()}`;
    let steps;
    try {
      steps = testStoreScenario({
        scenario, token, productId: prod.storeIdentifier, productType: prod.type, duration: prod.duration, start, now,
        // Without a price, the product's Test Store price from the catalog (what the SDK shows), as for SDK receipts.
        price: b.price !== undefined ? { amount: b.price, currency: b.currency ?? "USD" }
          : prod.testStorePriceMicros !== null && prod.testStorePriceCurrency ? { amount: prod.testStorePriceMicros / 1_000_000, currency: prod.testStorePriceCurrency } : null,
        countryCode: b.country_code ?? null,
      });
    } catch (e) {
      throw paramError(e instanceof Error ? e.message : String(e), start && start > now ? "purchased_at" : "scenario");
    }
    // Each state is applied at the time it happened, through the same pipeline as a receipt post, so events, the
    // transaction ledger and webhooks come out as they would have. A customer created here was first seen at the first purchase.
    const { customer, created } = await getOrCreateCustomer(db, projectId, b.app_user_id, now);
    let owner = customer;
    for (const [i, step] of steps.entries()) {
      owner = await applyPurchases(db, owner, [step.purchase], {
        projectId, appId: app.id, appUserId: b.app_user_id, now: step.at, presentedOfferingId: b.presented_offering_id ?? null,
        fromDevice: i === 0, customerCreated: i === 0 && created, fetch: deps.fetch,
      });
    }
    const [chain] = await db.select().from(schema.subscriptions).where(and(eq(schema.subscriptions.projectId, projectId), eq(schema.subscriptions.store, "test_store"), eq(schema.subscriptions.storeKey, token)));
    const accessEnd = chain?.expiresDate ? Math.max(chain.expiresDate.getTime(), chain.gracePeriodExpiresDate?.getTime() ?? 0) : null;
    if (chain && !chain.refundedAt && accessEnd !== null && accessEnd <= now.getTime()) {
      await recordDueExpirations(db, new Date(accessEnd), { projectId, store: "test_store", storeKey: token });
    }
    deps.kick?.();
    const cat = await loadCatalog(db, projectId);
    const [sub] = await db.select().from(schema.subscriptions).where(and(eq(schema.subscriptions.projectId, projectId), eq(schema.subscriptions.store, "test_store"), eq(schema.subscriptions.storeKey, token)));
    const [one] = await db.select().from(schema.nonSubscriptions).where(and(eq(schema.nonSubscriptions.projectId, projectId), eq(schema.nonSubscriptions.store, "test_store"), eq(schema.nonSubscriptions.storeTransactionId, token)));
    const rev = sub ? await subscriptionRevenue(db, [sub]) : null;
    const recorded = await db.select({ type: schema.events.type }).from(schema.events)
      .where(and(eq(schema.events.projectId, projectId), sql`${schema.events.payload}->'event'->>'original_transaction_id' = ${token}`)).orderBy(asc(schema.events.eventTimestampMs), asc(schema.events.createdAt));
    return c.json({
      object: "test_purchase", scenario, store_transaction_id: token, event_types: recorded.map((r) => r.type),
      customer: await customerShape(db, owner, { now, detail: true }),
      subscription: sub ? subscriptionShape(sub, owner.originalAppUserId, cat, rev!.get(sub.id) ?? 0, now, await accessOf(db, owner)) : null,
      purchase: one ? purchaseShape(one, owner.originalAppUserId, cat) : null,
    }, 201);
  });

  // Overview card history (sparklines, deltas and the 7D / 28D / 90D / 12M periods).
  r.get(`${P}/metrics/history`, scope("charts_metrics:overview:read"), async (c) => {
    const metric = c.req.query("metric") as HistoryMetric | undefined;
    if (!metric || !HISTORY_METRICS.includes(metric)) throw paramError(`metric must be one of ${HISTORY_METRICS.join(", ")}.`, "metric");
    const days = c.req.query("days") === undefined ? 28 : Number(c.req.query("days"));
    if (!Number.isInteger(days) || days < 1 || days > 366) throw paramError("days must be a whole number from 1 to 366.", "days");
    const environment = envOf(c) ?? "production";
    const now = deps.now();
    const { metric: _, ...h } = await metricHistory(db, c.get("projectId"), now, metric, days, environment);
    return c.json({ object: "metric_history", id: metric, currency: "USD", days, environment, resolution: "day", ...h, last_updated_at: now.getTime() });
  });

  // Dashboard rows for customers, by any of their app user ids (missing ids are left out).
  r.get(`${P}/customer_summaries`, scope("customer_information:customers:read"), async (c) => {
    const ids = [...new Set((c.req.queries("ids") ?? []).flatMap((x) => x.split(",")).map((x) => x.trim()).filter(Boolean))];
    if (!ids.length) throw paramError("ids is required.", "ids");
    if (ids.length > 100) throw paramError("ids takes at most 100 app user ids.", "ids");
    const projectId = c.get("projectId");
    const now = deps.now();
    const items = [];
    for (const id of ids) {
      const cust = await findCustomer(db, projectId, id);
      if (cust) items.push(await customerSummary(db, cust, id, now));
    }
    return c.json(listOf(c, items, null));
  });
}
