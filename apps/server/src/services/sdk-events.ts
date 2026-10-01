import { and, eq, inArray } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";

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

export async function storeSdkEvents(db: DB, opts: { projectId: string; app: { id: string | null; type: string } | null; body: unknown; now: Date; sandboxHeader?: boolean }): Promise<number> {
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

  const rows: (typeof schema.sdkEvents.$inferInsert)[] = events.map((ev) => {
    const appUserId = appUserIdOf(ev);
    const ms = Number(ev.timestamp_ms ?? ev.timestamp);
    // Timestamps in the future (a wrong device clock) or before 2015 are replaced by the time we received the event.
    const at = Number.isFinite(ms) && ms > 1_420_070_400_000 && ms <= opts.now.getTime() + 86_400_000 ? new Date(ms) : opts.now;
    return {
      projectId: opts.projectId, id: typeof ev.id === "string" && clean(ev.id, 64) ? clean(ev.id, 64) : crypto.randomUUID(), appId: opts.app?.id ?? null,
      customerId: appUserId !== null ? customers.get(appUserId) ?? null : null, appUserId, type: clean(ev.type as string, 64),
      // iOS sends X-Is-Sandbox for sandbox and TestFlight builds; events never say it themselves.
      isSandbox: typeof ev.is_sandbox === "boolean" ? ev.is_sandbox : !!opts.sandboxHeader || opts.app?.type === "test_store",
      occurredAt: at, payload: payloadOf(ev), receivedAt: opts.now,
    };
  });
  await db.insert(schema.sdkEvents).values(rows).onConflictDoNothing();
  return rows.length;
}
