import { and, eq, inArray } from "drizzle-orm";
import { PAYWALL_WEBHOOK_TYPES } from "@revenuedot/core";
import { PAYWALL_EVENT_FIELDS } from "@revenuedot/core/integrations";
import { schema, type DB } from "@revenuedot/db";
import { queueDeliveries } from "./events.js";

/**
 * POST /v1/events: the SDKs batch paywall events (`paywall_impression`, `paywall_close`, `paywall_cancel`,
 * `paywall_purchase_initiated` …), Customer Center events (`customer_center_impression`,
 * `customer_center_survey_option_chosen`) and ad events (`rc_ads_ad_displayed`, `rc_ads_ad_revenue` …) as
 * `{ "events": [ { id, type, app_user_id, timestamp | timestamp_ms, … } ] }` with snake_case keys (iOS
 * `FeatureEventsRequest`, `AdEventsRequest`; Android `BackendEvent`). We keep them for the paywall, ad and Customer
 * Center charts. The SDK resends a batch until it gets a 2xx, so the endpoint never fails because of a bad event:
 * malformed ones are skipped and duplicates (same event id) are stored once.
 *
 * The endpoint takes a public app key, so anyone holding one can post here: batches, events and payloads are capped.
 *
 * Paywall events also go to webhooks and integrations whose event filter names their type (PAYWALL_IMPRESSION …, opt-in;
 * forwardPaywallEvents below). Nothing else is forwarded.
 */
export const MAX_BODY_BYTES = 512_000;
const MAX_EVENTS = 500;
const MAX_PAYLOAD = 8_000;
const MAX_STRING = 500;

/** Postgres rejects NUL in text and jsonb. */
const clean = (s: string, max: number) => s.replace(/\u0000/g, "").slice(0, max);

/** A JSON value safe for jsonb: no NUL characters, strings capped, nesting limited. */
function sanitize(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return clean(v, MAX_STRING);
  if (v === null || typeof v === "number" || typeof v === "boolean") return v;
  if (depth >= 4 || typeof v !== "object") return null;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => sanitize(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v).slice(0, 100)) out[clean(k, 100)] = sanitize(x, depth + 1);
  return out;
}

/** The payload kept for one event: the event itself, without nested objects when it is too large, else only its scalars' first characters. */
function payloadOf(ev: Record<string, unknown>): Record<string, unknown> {
  let p = sanitize(ev) as Record<string, unknown>;
  if (JSON.stringify(p).length <= MAX_PAYLOAD) return p;
  p = Object.fromEntries(Object.entries(p).filter(([, v]) => typeof v !== "object" || v === null));
  if (JSON.stringify(p).length <= MAX_PAYLOAD) return p;
  return Object.fromEntries(Object.entries(p).slice(0, 40).map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 100) : v]));
}

export async function storeSdkEvents(db: DB, opts: {
  projectId: string; app: { id: string | null; type: string } | null; body: unknown; now: Date; sandboxHeader?: boolean;
  /** Runs the paywall forwarding after the response (deps.defer); without it the forwarding is awaited. */
  defer?: (task: () => Promise<unknown>) => void;
}): Promise<number> {
  const raw = (opts.body as { events?: unknown } | null)?.events;
  if (!Array.isArray(raw)) return 0;
  const events: Record<string, unknown>[] = raw.slice(0, MAX_EVENTS).filter((e): e is Record<string, unknown> => !!e && typeof e === "object" && !Array.isArray(e) && typeof (e as Record<string, unknown>).type === "string" && !!(e as Record<string, unknown>).type);
  if (!events.length) return 0;
  const appUserIdOf = (ev: Record<string, unknown>) => (typeof ev.app_user_id === "string" && ev.app_user_id ? clean(ev.app_user_id, 100) : null);

  // One lookup for every app user id in the batch.
  const ids = [...new Set(events.map(appUserIdOf).filter((x): x is string => x !== null))];
  const customers = new Map<string, string>();
  if (ids.length) {
    const A = schema.customerAliases;
    const rows = await db.select({ appUserId: A.appUserId, customerId: A.customerId }).from(A).where(and(eq(A.projectId, opts.projectId), inArray(A.appUserId, ids)));
    for (const r of rows) customers.set(r.appUserId, r.customerId);
  }

  // Only events with the SDK's own id are forwarded (both SDKs always send one): a resend then maps to the same row.
  const sdkIds = new Set<string>();
  const rows: (typeof schema.sdkEvents.$inferInsert)[] = events.map((ev) => {
    const appUserId = appUserIdOf(ev);
    const ms = Number(ev.timestamp_ms ?? ev.timestamp);
    // Timestamps in the future (a wrong device clock) or before 2015 are replaced by the time we received the event.
    const at = Number.isFinite(ms) && ms > 1_420_070_400_000 && ms <= opts.now.getTime() + 86_400_000 ? new Date(ms) : opts.now;
    return {
      projectId: opts.projectId, id: typeof ev.id === "string" && clean(ev.id, 64) ? (sdkIds.add(clean(ev.id, 64)), clean(ev.id, 64)) : crypto.randomUUID(), appId: opts.app?.id ?? null,
      customerId: appUserId !== null ? customers.get(appUserId) ?? null : null, appUserId, type: clean(ev.type as string, 64),
      // iOS sends X-Is-Sandbox for sandbox and TestFlight builds; events never say it themselves.
      isSandbox: typeof ev.is_sandbox === "boolean" ? ev.is_sandbox : !!opts.sandboxHeader || opts.app?.type === "test_store",
      occurredAt: at, payload: payloadOf(ev), receivedAt: opts.now,
    };
  });
  await db.insert(schema.sdkEvents).values(rows).onConflictDoNothing();
  // Forwarding never fails the batch (the SDK would resend it forever) and runs after the response when it can.
  const forward = () => forwardPaywallEvents(db, opts, rows.filter((r) => sdkIds.has(r.id))).catch((e) => console.error("Forwarding paywall events failed", e));
  if (opts.defer) opts.defer(forward); else await forward();
  return rows.length;
}

/** SDK type (`paywall_impression`) → webhook type (`PAYWALL_IMPRESSION`). */
const PAYWALL_TYPE = new Map<string, string>(PAYWALL_WEBHOOK_TYPES.map((t) => [t.toLowerCase(), t]));

/**
 * The `events` row id of a forwarded SDK event: a UUID derived from the project and the SDK's event id, so a batch the
 * SDK sends again finds its rows already there and queues nothing twice.
 */
async function forwardedId(projectId: string, sdkId: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`paywall-event:${projectId}:${sdkId}`)));
  d[6] = (d[6]! & 0x0f) | 0x50;
  d[8] = (d[8]! & 0x3f) | 0x80;
  const h = Array.from(d.slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`.toUpperCase();
}

const scalar = (v: unknown) => (typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : undefined);

/**
 * Writes an `events` row for each paywall event whose type an enabled webhook or integration of the project names in its
 * filter, and queues its deliveries. The event body follows the webhook shape (id, type, event_timestamp_ms, app_id,
 * app_user_id, original_app_user_id, aliases, environment, store, subscriber_attributes) plus the paywall's fields.
 * Paywall events carry no transaction, price or revenue. One query decides whether anything in the project wants
 * paywall events at all; customers, attributes and paywall names are read only then.
 */
async function forwardPaywallEvents(db: DB, opts: { projectId: string; app: { id: string | null; type: string } | null; now: Date }, rows: (typeof schema.sdkEvents.$inferInsert)[]) {
  const candidates = rows.filter((r) => PAYWALL_TYPE.has(r.type));
  if (!candidates.length) return;
  const [hooks, ints] = await Promise.all([
    db.select({ t: schema.webhooks.eventTypes }).from(schema.webhooks).where(and(eq(schema.webhooks.projectId, opts.projectId), eq(schema.webhooks.enabled, true))),
    db.select({ t: schema.integrations.eventTypes }).from(schema.integrations).where(and(eq(schema.integrations.projectId, opts.projectId), eq(schema.integrations.enabled, true))),
  ]);
  const wanted = new Set([...hooks, ...ints].flatMap((x) => x.t ?? []));
  const todo = candidates.filter((r) => wanted.has(PAYWALL_TYPE.get(r.type)!));
  if (!todo.length) return;

  const customerIds = [...new Set(todo.map((r) => r.customerId).filter((x): x is string => !!x))];
  const paywallIdOf = (p: Record<string, any>): unknown => p.paywall_id ?? p.presented_offering_context?.paywall_id;
  const paywallIds = [...new Set(todo.map((r) => paywallIdOf(r.payload as Record<string, unknown>)).filter((x): x is string => typeof x === "string" && !!x))];
  const [customers, aliases, attrs, paywalls] = customerIds.length || paywallIds.length ? await Promise.all([
    customerIds.length ? db.select({ id: schema.customers.id, original: schema.customers.originalAppUserId, sdk: schema.customers.lastSeenSdkVersion, os: schema.customers.lastSeenPlatformVersion }).from(schema.customers).where(inArray(schema.customers.id, customerIds)) : [],
    customerIds.length ? db.select({ c: schema.customerAliases.customerId, a: schema.customerAliases.appUserId }).from(schema.customerAliases).where(inArray(schema.customerAliases.customerId, customerIds)) : [],
    customerIds.length ? db.select().from(schema.customerAttributes).where(inArray(schema.customerAttributes.customerId, customerIds)) : [],
    paywallIds.length ? db.select({ id: schema.paywalls.id, name: schema.paywalls.name }).from(schema.paywalls).where(and(eq(schema.paywalls.projectId, opts.projectId), inArray(schema.paywalls.id, paywallIds))) : [],
  ]) : [[], [], [], []];
  const customer = new Map(customers.map((c) => [c.id, c]));
  const attrsOf = new Map<string, typeof attrs>();
  for (const a of attrs) attrsOf.set(a.customerId, [...(attrsOf.get(a.customerId) ?? []), a]);
  const names = new Map(paywalls.map((p) => [p.id, p.name]));
  const store = opts.app?.type ? opts.app.type.toUpperCase() : null;

  for (const r of todo) {
    try { await forwardOne(r); } catch (e) { console.error(`Forwarding paywall event ${r.id} failed`, e); }
  }

  async function forwardOne(r: (typeof todo)[number]) {
    const type = PAYWALL_TYPE.get(r.type)!;
    const p = r.payload as Record<string, unknown>;
    const c = r.customerId ? customer.get(r.customerId) : undefined;
    const subscriber_attributes: Record<string, { value: string | null; updated_at_ms: number }> = {};
    for (const a of (r.customerId ? attrsOf.get(r.customerId) : undefined) ?? []) subscriber_attributes[a.key] = { value: a.value, updated_at_ms: a.updatedAtMs };
    // The SDK nests the placement and targeting under presented_offering_context; integrations get them flat.
    const ctx = (p.presented_offering_context && typeof p.presented_offering_context === "object" ? p.presented_offering_context : {}) as Record<string, unknown>;
    const fields: Record<string, unknown> = { ...ctx, ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== null && v !== undefined)) };
    if (typeof fields.paywall_id === "string" && names.get(fields.paywall_id)) fields.paywall_name = names.get(fields.paywall_id);
    const paywall: Record<string, unknown> = {};
    for (const k of PAYWALL_EVENT_FIELDS) { const v = scalar(fields[k]); if (v !== undefined) paywall[k] = v; }
    const id = await forwardedId(opts.projectId, r.id);
    const environment = r.isSandbox ? "SANDBOX" : "PRODUCTION";
    const event: Record<string, unknown> = {
      id, type, event_timestamp_ms: r.occurredAt.getTime(), app_id: r.appId ?? null, app_user_id: r.appUserId ?? null,
      original_app_user_id: c?.original ?? r.appUserId ?? null,
      aliases: r.customerId ? aliases.filter((a) => a.c === r.customerId).map((a) => a.a) : r.appUserId ? [r.appUserId] : [],
      environment, store, ...paywall,
      ...(c?.sdk ? { sdk_version: c.sdk } : {}), ...(c?.os ? { platform_version: c.os } : {}),
      subscriber_attributes,
    };
    const inserted = await db.insert(schema.events).values({
      id, projectId: opts.projectId, customerId: r.customerId ?? null, type, environment: environment.toLowerCase(), appId: r.appId ?? null,
      payload: { api_version: "1.0", event }, eventTimestampMs: r.occurredAt.getTime(), createdAt: opts.now,
    }).onConflictDoNothing().returning({ id: schema.events.id });
    if (!inserted.length) return;
    await queueDeliveries(db, opts.projectId, id, type, environment.toLowerCase(), r.appId ?? null, opts.now, event);
  }
}
