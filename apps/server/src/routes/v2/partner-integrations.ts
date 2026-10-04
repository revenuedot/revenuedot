import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { newId, webhookStore, type Store } from "@revenuedot/core";
import { CONCEPTS, INTEGRATIONS, integrationSpec, partnerDef, type IntegrationField, type IntegrationKind, type IntegrationSpec } from "@revenuedot/core/integrations";
import { schema } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { aliasesOf, findCustomer } from "../../repo/customers.js";
import { depsSecretKey, mergeSecrets } from "../../services/secrets.js";
import { integrationCurl, requeueIntegrationDelivery } from "../../services/integrations/deliver.js";
import { ATTEMPT_LOG_DAYS } from "../../services/webhooks.js";
import { outboundUrlProblem } from "../../services/outbound.js";
import { V2Error, allows, body, listOf, notFound, pageParams, paginate, paramError, scope, type V2Router } from "./common.js";
import { ALL_WEBHOOK_EVENT_TYPES } from "./integrations.js";

/**
 * Third-party integrations (RevenueDot extension; RevenueCat's API v2 only exposes webhook integrations):
 *   GET    /v2/projects/{project_id}/integrations/catalog                                    what each integration needs
 *   GET    /v2/projects/{project_id}/integrations/partners                                   list
 *   POST   /v2/projects/{project_id}/integrations/partners                                   create
 *   GET    /v2/projects/{project_id}/integrations/partners/{integration_id}
 *   POST   /v2/projects/{project_id}/integrations/partners/{integration_id}                  update (also enables and disables)
 *   DELETE /v2/projects/{project_id}/integrations/partners/{integration_id}
 *   POST   /v2/projects/{project_id}/integrations/partners/{integration_id}/test             queue a TEST event to this integration
 *   GET    /v2/projects/{project_id}/integrations/partners/{integration_id}/deliveries       delivery log (?status=)
 *   GET    /v2/projects/{project_id}/integrations/partners/{integration_id}/deliveries/{delivery_id}   one delivery: every attempt, cURL
 *   POST   /v2/projects/{project_id}/integrations/partners/{integration_id}/deliveries/{delivery_id}/retry
 *   POST   /v2/projects/{project_id}/integrations/partners/{integration_id}/actions/replay   queue failed or skipped deliveries again
 * `settings` takes every field of the catalogue entry; secret fields are sealed (services/secrets.ts) and come back
 * only as `{ configured, hint }` under `secrets`. A secret set to null or "" is removed; a missing one is kept.
 */

const Env = z.enum(["production", "sandbox"]).nullable().optional();
const Names = z.record(z.enum(CONCEPTS as [string, ...string[]]), z.string().trim().max(100));
const Create = z.object({
  type: z.enum(INTEGRATIONS.map((s) => s.kind) as [IntegrationKind, ...IntegrationKind[]]),
  name: z.string().trim().min(1).max(255).optional(), enabled: z.boolean().optional(), environment: Env, app_id: z.string().min(1).nullable().optional(),
  event_types: z.array(z.enum(ALL_WEBHOOK_EVENT_TYPES)).optional(), settings: z.record(z.unknown()).optional(), event_names: Names.optional(),
}).strict();
const Update = Create.omit({ type: true }).partial().strict();
const Test = z.object({ app_user_id: z.string().min(1).max(256).optional(), environment: z.enum(["production", "sandbox"]).optional(), product_id: z.string().min(1).max(256).optional() }).strict();
const Replay = z.object({ status: z.enum(["failed", "skipped", "failed_and_skipped"]).optional(), since: z.number().int().optional(), until: z.number().int().optional() }).strict();

type Row = typeof schema.integrations.$inferSelect;

export function integrationShape(i: Row) {
  const spec = integrationSpec(i.kind);
  const secrets: Record<string, { configured: boolean; hint: string | null }> = {};
  for (const f of spec?.fields ?? []) if (f.type === "secret") secrets[f.key] = { configured: f.key in i.secretHints, hint: i.secretHints[f.key] ?? null };
  return {
    object: "integration" as const, id: i.id, project_id: i.projectId, type: i.kind, name: i.name, enabled: i.enabled,
    environment: i.environment === "both" ? null : i.environment, app_id: i.appId ?? null,
    event_types: (i.eventTypes ?? []).map((t) => t.toLowerCase()), settings: i.settings, secrets, event_names: i.eventNames,
    status: { last_delivered_at: i.lastDeliveredAt?.getTime() ?? null, last_error: i.lastError, consecutive_failures: i.consecutiveFailures, failed_deliveries_in_row: i.failedDeliveriesInRow },
    created_at: i.createdAt.getTime(), updated_at: i.updatedAt?.getTime() ?? null,
  };
}

/** Splits a settings write into plain settings and secrets, validated against the catalogue entry. */
function splitSettings(spec: IntegrationSpec, input: Record<string, unknown>) {
  const plain: Record<string, unknown> = {}, secrets: Record<string, string | null> = {};
  const fields = new Map(spec.fields.map((f) => [f.key, f]));
  for (const [k, v] of Object.entries(input)) {
    const f = fields.get(k);
    const at = `settings.${k}`;
    if (!f) throw paramError(`${at}: ${spec.name} has no setting ${k}.`, at);
    if (f.type === "secret") {
      if (v !== null && typeof v !== "string") throw paramError(`${at}: must be a string or null.`, at);
      if (typeof v === "string" && v.length > 20_000) throw paramError(`${at}: is too long.`, at);
      secrets[k] = v === null ? null : (v as string).trim();
      continue;
    }
    if (v === null || v === "") { plain[k] = null; continue; }
    plain[k] = checkField(f, v, at);
  }
  return { plain, secrets };
}

function checkField(f: IntegrationField, v: unknown, at: string): unknown {
  if (f.type === "boolean") { if (typeof v !== "boolean") throw paramError(`${at}: must be true or false.`, at); return v; }
  if (f.type === "select") {
    if (typeof v !== "string" || !f.options!.some((o) => o.value === v)) throw paramError(`${at}: must be one of ${f.options!.map((o) => o.value).join(", ")}.`, at);
    return v;
  }
  if (f.type === "tokens") {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw paramError(`${at}: must map lifecycle steps to tokens.`, at);
    const out: Record<string, string> = {};
    for (const [step, tok] of Object.entries(v as Record<string, unknown>)) {
      if (!CONCEPTS.includes(step as never)) throw paramError(`${at}.${step}: unknown step. Steps: ${CONCEPTS.join(", ")}.`, `${at}.${step}`);
      if (tok === null || tok === "") continue;
      if (typeof tok !== "string" || tok.length > 100) throw paramError(`${at}.${step}: must be a token string.`, `${at}.${step}`);
      out[step] = tok.trim();
    }
    return out;
  }
  if (typeof v !== "string" || v.length > 2000) throw paramError(`${at}: must be a string of at most 2,000 characters.`, at);
  return v.trim();
}

/** Required fields and cross-field rules, on the merged result. */
function checkComplete(spec: IntegrationSpec, settings: Record<string, unknown>, secrets: Record<string, string>, strictUrls: boolean) {
  for (const f of spec.fields) {
    if (!f.required) continue;
    const has = f.type === "secret" ? !!secrets[f.key] : settings[f.key] !== undefined && settings[f.key] !== null && settings[f.key] !== "";
    if (!has) throw paramError(`settings.${f.key}: ${f.label} is required for ${spec.name}.`, `settings.${f.key}`);
  }
  // Slack only issues https URLs. A self-hosted server may also post to its own network (a local test receiver);
  // RevenueDot Cloud refuses private addresses (services/outbound.ts).
  if (spec.kind === "slack" && secrets.webhook_url) {
    const problem = outboundUrlProblem(secrets.webhook_url, strictUrls) ?? (strictUrls || /^https:/i.test(secrets.webhook_url) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(secrets.webhook_url) ? null : "must be an https URL");
    if (problem) throw paramError(`settings.webhook_url: ${problem}.`, "settings.webhook_url");
  }
  if (spec.kind === "posthog" && settings.region === "custom") {
    const host = String(settings.host ?? "");
    let problem = /^https?:\/\/[^/]+/i.test(host) ? outboundUrlProblem(host, strictUrls) : "enter your PostHog URL, such as https://posthog.example.com";
    if (!problem && (host.includes("?") || host.includes("#"))) problem = "must be the PostHog address only, without ? or #";
    if (problem) throw paramError(`settings.host: ${problem}.`, "settings.host");
  }
  if (spec.kind === "bigquery" && secrets.service_account_json) {
    let j: Record<string, unknown> | null = null;
    try { j = JSON.parse(secrets.service_account_json); } catch { j = null; }
    if (!j || typeof j.client_email !== "string" || typeof j.private_key !== "string") throw paramError("settings.service_account_json: paste the service account's JSON key (with client_email and private_key).", "settings.service_account_json");
    if (!settings.project_id && typeof j.project_id !== "string") throw paramError("settings.project_id: set the BigQuery project.", "settings.project_id");
  }
  if (spec.kind === "firebase" && !(settings.ios_firebase_app_id && secrets.ios_api_secret) && !(settings.android_firebase_app_id && secrets.android_api_secret)) {
    throw paramError("settings: set a Firebase app ID and its API secret for iOS, Android or both.", "settings");
  }
  if (spec.kind === "appsflyer" && !settings.ios_app_id && !settings.android_app_id && !settings.web_app_id) throw paramError("settings: set the AppsFlyer app ID for iOS, Android, the web, or several.", "settings");
  if (spec.kind === "adjust" && !settings.ios_app_token && !settings.android_app_token) throw paramError("settings: set the Adjust app token for iOS, Android or both.", "settings");
  // Fields the server will call (a Discord webhook, a Tag Manager server container, a partner's webhook URL).
  for (const f of spec.fields) {
    if (!f.url) continue;
    const v = f.type === "secret" ? secrets[f.key] : settings[f.key];
    if (typeof v !== "string" || !v) continue;
    const problem = outboundUrlProblem(v, strictUrls) ?? (strictUrls && !/^https:/i.test(v) ? "must be an https URL" : null);
    if (problem) throw paramError(`settings.${f.key}: ${problem}.`, `settings.${f.key}`);
  }
  const bad = partnerDef(spec.kind)?.validate?.(settings, secrets);
  if (bad) throw paramError(`${bad.param}: ${bad.message}`, bad.param);
}

export function partnerIntegrationRoutes(r: V2Router, deps: Deps) {
  const { db } = deps;
  const P = "/v2/projects/:project_id/integrations/partners";
  const key = () => depsSecretKey(deps);
  const find = async (projectId: string, id: string) => {
    const [i] = await db.select().from(schema.integrations).where(and(eq(schema.integrations.projectId, projectId), eq(schema.integrations.id, id))).limit(1);
    if (!i) throw notFound("Integration");
    return i;
  };
  const checkApp = async (projectId: string, appId: string | null | undefined) => {
    if (!appId) return;
    const [a] = await db.select({ id: schema.apps.id }).from(schema.apps).where(and(eq(schema.apps.projectId, projectId), eq(schema.apps.id, appId))).limit(1);
    if (!a) throw paramError("app_id does not match an app in this project.", "app_id");
  };
  const types = (t: readonly string[] | undefined) => (t === undefined ? undefined : t.length ? t.map((x) => x.toUpperCase()) : null);

  r.get("/v2/projects/:project_id/integrations/catalog", scope("project_configuration:integrations:read"), (c) =>
    c.json(listOf(c, INTEGRATIONS.map((s) => ({ object: "integration_type" as const, type: s.kind, name: s.name, category: s.category, description: s.text, default_environment: s.environment === "both" ? null : s.environment, event_names: s.eventNames, fields: s.fields, docs_url: s.docs, api: s.api ?? "documented", connection: !!s.connection })), null)));

  r.get(P, scope("project_configuration:integrations:read"), async (c) => {
    const rows = await db.select().from(schema.integrations).where(eq(schema.integrations.projectId, c.get("projectId")));
    const type = c.req.query("type");
    return c.json(paginate(c, type ? rows.filter((x) => x.kind === type) : rows, (x) => x.id, (x) => x.createdAt.getTime(), integrationShape));
  });

  r.post(P, scope("project_configuration:integrations:read_write"), async (c) => {
    const b = await body(c, Create);
    const projectId = c.get("projectId");
    const spec = integrationSpec(b.type)!;
    await checkApp(projectId, b.app_id);
    const { plain, secrets } = splitSettings(spec, b.settings ?? {});
    const settings = Object.fromEntries(Object.entries(plain).filter(([, v]) => v !== null));
    const merged = await mergeSecrets(null, secrets, await key());
    checkComplete(spec, settings, merged.values, deps.edition === "cloud");
    const now = deps.now();
    const [row] = await db.insert(schema.integrations).values({
      id: newId("intg_", 14), projectId, kind: b.type, name: b.name ?? spec.name, enabled: b.enabled ?? true,
      environment: b.environment === undefined ? spec.environment : b.environment ?? "both", appId: b.app_id ?? null, eventTypes: types(b.event_types) ?? null,
      settings, secrets: merged.sealed, secretHints: merged.hints, eventNames: cleanNames(b.event_names), createdAt: now, updatedAt: now,
    }).returning();
    return c.json(integrationShape(row!), 201);
  });

  r.get(`${P}/:integration_id`, scope("project_configuration:integrations:read"), async (c) => c.json(integrationShape(await find(c.get("projectId"), c.req.param("integration_id")))));

  r.post(`${P}/:integration_id`, scope("project_configuration:integrations:read_write"), async (c) => {
    const i = await find(c.get("projectId"), c.req.param("integration_id"));
    const b = await body(c, Update);
    const spec = integrationSpec(i.kind)!;
    await checkApp(i.projectId, b.app_id);
    const { plain, secrets } = splitSettings(spec, b.settings ?? {});
    const settings: Record<string, unknown> = { ...i.settings };
    for (const [k, v] of Object.entries(plain)) { if (v === null) delete settings[k]; else settings[k] = v; }
    const merged = await mergeSecrets(i.secrets, secrets, await key());
    checkComplete(spec, settings, merged.values, deps.edition === "cloud");
    const et = types(b.event_types);
    const [row] = await db.update(schema.integrations).set({
      ...(b.name !== undefined ? { name: b.name } : {}), ...(b.enabled !== undefined ? { enabled: b.enabled } : {}),
      ...(b.environment !== undefined ? { environment: b.environment ?? "both" } : {}), ...(b.app_id !== undefined ? { appId: b.app_id } : {}),
      ...(et !== undefined ? { eventTypes: et } : {}), ...(b.event_names !== undefined ? { eventNames: cleanNames(b.event_names) } : {}),
      ...(b.enabled === true ? { consecutiveFailures: 0, failedDeliveriesInRow: 0 } : {}),
      settings, secrets: merged.sealed, secretHints: merged.hints, updatedAt: deps.now(),
    }).where(eq(schema.integrations.id, i.id)).returning();
    if (b.enabled === true) deps.kick?.();
    return c.json(integrationShape(row!));
  });

  // Queued deliveries go with it (FK cascade).
  r.delete(`${P}/:integration_id`, scope("project_configuration:integrations:read_write"), async (c) => {
    const i = await find(c.get("projectId"), c.req.param("integration_id"));
    await db.delete(schema.integrations).where(eq(schema.integrations.id, i.id));
    return c.json({ object: "integration", id: i.id, deleted_at: deps.now().getTime() });
  });

  // A TEST event for this integration only. With app_user_id the customer's attributes go with it, so attribution
  // partners (which need $appsflyerId, $adjustId, $fbAnonId ...) can be tested end to end.
  r.post(`${P}/:integration_id/test`, scope("project_configuration:integrations:read_write"), async (c) => {
    const projectId = c.get("projectId");
    const i = await find(projectId, c.req.param("integration_id"));
    if (!i.enabled) throw new V2Error(422, "unprocessable_entity_error", "This integration is turned off. Turn it on to send a test event.", "enabled");
    const b = await body(c, Test);
    const now = deps.now();
    const apps = await db.select().from(schema.apps).where(eq(schema.apps.projectId, projectId));
    const app = (i.appId ? apps.find((x) => x.id === i.appId) : apps.filter((x) => x.type !== "test_store").sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime())[0] ?? apps[0]) ?? null;
    const environment = (b.environment ?? (i.environment === "sandbox" ? "sandbox" : "production")).toUpperCase();
    let user = `$RCAnonymousID:${crypto.randomUUID().replace(/-/g, "")}`, original = user, aliases = [user], customerId: string | null = null;
    const subscriber_attributes: Record<string, { value: string | null; updated_at_ms: number }> = {};
    if (b.app_user_id) {
      const cu = await findCustomer(db, projectId, b.app_user_id);
      if (!cu) throw paramError("app_user_id does not match a customer in this project.", "app_user_id");
      user = b.app_user_id; original = cu.originalAppUserId; aliases = await aliasesOf(db, cu.id); customerId = cu.id;
      for (const a of await db.select().from(schema.customerAttributes).where(eq(schema.customerAttributes.customerId, cu.id))) subscriber_attributes[a.key] = { value: a.value, updated_at_ms: a.updatedAtMs };
    }
    const id = crypto.randomUUID().toUpperCase();
    const event = {
      id, type: "TEST", event_timestamp_ms: now.getTime(), app_id: app?.id ?? null, app_user_id: user, original_app_user_id: original, aliases,
      product_id: b.product_id ?? "test_product", period_type: "NORMAL", purchased_at_ms: now.getTime(), expiration_at_ms: now.getTime() + 30 * 86400_000, environment,
      entitlement_id: null, entitlement_ids: null, presented_offering_id: null, transaction_id: "test_transaction_id", original_transaction_id: "test_original_transaction_id",
      is_family_share: false, country_code: "US", currency: "USD", price: 0, price_in_purchased_currency: 0, subscriber_attributes,
      store: webhookStore((app?.type === "test_store" || !app ? "app_store" : app.type) as Store), takehome_percentage: 1, tax_percentage: 0, commission_percentage: 0, offer_code: null,
    };
    await db.insert(schema.events).values({ id, projectId, customerId, type: "TEST", environment: environment.toLowerCase(), appId: app?.id ?? null, payload: { api_version: "1.0", event }, eventTimestampMs: now.getTime(), createdAt: now });
    const [d] = await db.insert(schema.integrationDeliveries).values({ id: crypto.randomUUID(), integrationId: i.id, eventId: id, nextAttemptAt: now, createdAt: now }).returning();
    deps.kick?.();
    return c.json(deliveryShape(d!, "TEST"), 201);
  });

  r.get(`${P}/:integration_id/deliveries`, scope("project_configuration:integrations:read"), async (c) => {
    const i = await find(c.get("projectId"), c.req.param("integration_id"));
    const { limit, startingAfter } = pageParams(c);
    const D = schema.integrationDeliveries;
    const conds = [eq(D.integrationId, i.id)];
    const status = c.req.query("status");
    if (status) {
      if (!["pending", "delivered", "failed", "skipped"].includes(status)) throw paramError("status must be pending, delivered, failed or skipped.", "status");
      // A delivery being sent right now ("sending", leased by a tick) is still pending to the API.
      conds.push(status === "pending" ? inArray(D.status, ["pending", "sending"]) : eq(D.status, status));
    }
    if (startingAfter) {
      const [cur] = await db.select().from(D).where(and(eq(D.integrationId, i.id), eq(D.id, startingAfter))).limit(1);
      if (!cur) throw paramError("starting_after does not match a delivery of this integration.", "starting_after");
      conds.push(sql`(${D.createdAt}, ${D.id}) < (${cur.createdAt.toISOString()}::timestamptz, ${cur.id})`);
    }
    const rows = await db.select({ d: D, type: schema.events.type }).from(D).innerJoin(schema.events, eq(schema.events.id, D.eventId))
      .where(and(...conds)).orderBy(desc(D.createdAt), desc(D.id)).limit(limit + 1);
    const page = rows.slice(0, limit);
    // Request and response bodies can hold customer data: Viewers get the log without them.
    const full = allows(c.get("principal"), "project_configuration:integrations:read_write");
    return c.json(listOf(c, page.map((x) => ({ ...deliveryShape(x.d, x.type), ...(full ? {} : { request_body: null, response_body: null }) })), rows.length > limit ? page[page.length - 1]!.d.id : null));
  });

  // One delivery with every attempt's answer and a cURL of the request (credentials are never stored). Admins and Developers only.
  r.get(`${P}/:integration_id/deliveries/:delivery_id`, scope("project_configuration:integrations:read_write"), async (c) => {
    const i = await find(c.get("projectId"), c.req.param("integration_id"));
    const D = schema.integrationDeliveries;
    const [row] = await db.select({ d: D, type: schema.events.type }).from(D).innerJoin(schema.events, eq(schema.events.id, D.eventId))
      .where(and(eq(D.integrationId, i.id), eq(D.id, c.req.param("delivery_id")))).limit(1);
    if (!row) throw notFound("Integration delivery");
    return c.json({
      ...deliveryShape(row.d, row.type),
      curl: integrationCurl(row.d.request, row.d.requestBody),
      attempt_log: (row.d.attemptLog ?? []).map((a) => ({ attempted_at: a.at, response_status: a.status, response_ms: a.ms, error: a.error, response_body: a.response_body, request: a.request ?? null })),
      attempt_log_kept_days: ATTEMPT_LOG_DAYS,
    });
  });

  r.post(`${P}/:integration_id/deliveries/:delivery_id/retry`, scope("project_configuration:integrations:read_write"), async (c) => {
    const i = await find(c.get("projectId"), c.req.param("integration_id"));
    const D = schema.integrationDeliveries;
    const [d] = await db.select().from(D).where(and(eq(D.integrationId, i.id), eq(D.id, c.req.param("delivery_id")))).limit(1);
    if (!d) throw notFound("Integration delivery");
    if (!(await requeueIntegrationDelivery(db, d.id, deps.now()))) {
      throw new V2Error(409, "resource_locked_error", "This delivery is being sent right now. Try again in a minute.", undefined, true);
    }
    deps.kick?.();
    const [row] = await db.select({ d: D, type: schema.events.type }).from(D).innerJoin(schema.events, eq(schema.events.id, D.eventId)).where(eq(D.id, d.id));
    return c.json(deliveryShape(row!.d, row!.type));
  });

  r.post(`${P}/:integration_id/actions/replay`, scope("project_configuration:integrations:read_write"), async (c) => {
    const i = await find(c.get("projectId"), c.req.param("integration_id"));
    const b = await body(c, Replay);
    const D = schema.integrationDeliveries;
    const statuses = b.status === "skipped" ? ["skipped"] : b.status === "failed_and_skipped" ? ["failed", "skipped"] : ["failed"];
    const conds = [eq(D.integrationId, i.id), inArray(D.status, statuses)];
    if (b.since !== undefined) conds.push(gte(D.createdAt, new Date(b.since)));
    if (b.until !== undefined) conds.push(lte(D.createdAt, new Date(b.until)));
    // A replay starts a fresh retry schedule.
    const rows = await db.update(D).set({ status: "pending", nextAttemptAt: deps.now(), attempts: 0 }).where(and(...conds)).returning({ id: D.id });
    deps.kick?.();
    return c.json({ object: "integration_replay", integration_id: i.id, statuses, queued: rows.length });
  });
}

const cleanNames = (n: Record<string, string> | undefined) => Object.fromEntries(Object.entries(n ?? {}).filter(([, v]) => v.trim() !== ""));

export function deliveryShape(d: typeof schema.integrationDeliveries.$inferSelect, eventType: string) {
  return {
    object: "integration_delivery" as const, id: d.id, integration_id: d.integrationId, event_id: d.eventId, event_type: eventType, status: d.status === "sending" ? "pending" : d.status,
    attempts: d.attempts, sent_as: d.sentAs, next_attempt_at: d.status === "pending" || d.status === "sending" ? d.nextAttemptAt.getTime() : null, request: d.request, request_body: d.requestBody,
    response_status: d.responseStatus, response_ms: d.responseMs, response_body: d.responseBody, last_error: d.lastError, created_at: d.createdAt.getTime(),
  };
}
