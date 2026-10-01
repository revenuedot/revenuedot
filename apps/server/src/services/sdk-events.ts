import { schema, type DB } from "@revenuedot/db";
import { findCustomer } from "../repo/customers.js";

/**
 * POST /v1/events: the SDKs batch paywall events (`paywall_impression`, `paywall_close`, `paywall_cancel`,
 * `paywall_purchase_initiated` …), Customer Center events (`customer_center_impression`,
 * `customer_center_survey_option_chosen`) and ad events (`rc_ads_ad_displayed`, `rc_ads_ad_revenue` …) as
 * `{ "events": [ { id, type, app_user_id, timestamp | timestamp_ms, … } ] }` with snake_case keys (iOS
 * `FeatureEventsRequest`, `AdEventsRequest`; Android `BackendEvent`). We keep them for the paywall, ad and Customer
 * Center charts. The SDK resends a batch until it gets a 2xx, so the endpoint never fails because of a bad event:
 * malformed ones are skipped and duplicates (same event id) are stored once.
 */
const MAX_EVENTS = 500;
const MAX_PAYLOAD = 8_000;

export async function storeSdkEvents(db: DB, opts: { projectId: string; app: { id: string | null; type: string } | null; body: unknown; now: Date }): Promise<number> {
  const raw = (opts.body as { events?: unknown } | null)?.events;
  if (!Array.isArray(raw)) return 0;
  const customers = new Map<string, string | null>();
  const rows: (typeof schema.sdkEvents.$inferInsert)[] = [];
  for (const e of raw.slice(0, MAX_EVENTS)) {
    if (!e || typeof e !== "object") continue;
    const ev = e as Record<string, unknown>;
    const type = typeof ev.type === "string" ? ev.type.slice(0, 64) : null;
    if (!type) continue;
    const appUserId = typeof ev.app_user_id === "string" ? ev.app_user_id.slice(0, 100) : null;
    const ms = Number(ev.timestamp_ms ?? ev.timestamp);
    // Timestamps in the future (a wrong device clock) or before 2015 are replaced by the time we received the event.
    const at = Number.isFinite(ms) && ms > 1_420_070_400_000 && ms <= opts.now.getTime() + 86_400_000 ? new Date(ms) : opts.now;
    if (appUserId !== null && !customers.has(appUserId)) customers.set(appUserId, (await findCustomer(db, opts.projectId, appUserId))?.id ?? null);
    let payload = ev;
    if (JSON.stringify(ev).length > MAX_PAYLOAD) payload = Object.fromEntries(Object.entries(ev).filter(([, v]) => typeof v !== "object" || v === null));
    rows.push({
      projectId: opts.projectId, id: typeof ev.id === "string" && ev.id ? ev.id.slice(0, 64) : crypto.randomUUID(), appId: opts.app?.id ?? null,
      customerId: appUserId !== null ? customers.get(appUserId) ?? null : null, appUserId, type,
      isSandbox: typeof ev.is_sandbox === "boolean" ? ev.is_sandbox : opts.app?.type === "test_store", occurredAt: at, payload, receivedAt: opts.now,
    });
  }
  if (rows.length) await db.insert(schema.sdkEvents).values(rows).onConflictDoNothing();
  return rows.length;
}
