import { json, revenueUsd, skip, type BuildInput, type OutRequest, type Plan } from "./common.js";

/**
 * BigQuery: every event as one row through the streaming insert API, `tabledata.insertAll`
 * (https://cloud.google.com/bigquery/docs/reference/rest/v2/tabledata/insertAll). `insertId` is the event id, so
 * BigQuery's best-effort deduplication drops a retried row. The adapter signs in with the service account
 * (secret `service_account_json`, scope bigquery.insertdata) and creates the table with BIGQUERY_SCHEMA when it is missing.
 * Settings: `project_id` (defaults to the service account's project), `dataset_id`, `table_id` (default revenuedot_events), `reporting`.
 * Every event type is sent, sandbox included (filter on the `environment` column).
 */

export const BIGQUERY_API = "https://bigquery.googleapis.com/bigquery/v2";
export const BIGQUERY_SCOPE = "https://www.googleapis.com/auth/bigquery";

/** Column, type, mode. TIMESTAMP values are RFC 3339 strings; `payload` is the whole webhook event as JSON. */
export const BIGQUERY_SCHEMA: [string, string, "NULLABLE" | "REQUIRED" | "REPEATED"][] = [
  ["id", "STRING", "REQUIRED"], ["type", "STRING", "REQUIRED"], ["event_timestamp", "TIMESTAMP", "REQUIRED"],
  ["app_user_id", "STRING", "NULLABLE"], ["original_app_user_id", "STRING", "NULLABLE"], ["aliases", "STRING", "REPEATED"],
  ["app_id", "STRING", "NULLABLE"], ["environment", "STRING", "NULLABLE"], ["store", "STRING", "NULLABLE"],
  ["product_id", "STRING", "NULLABLE"], ["new_product_id", "STRING", "NULLABLE"], ["period_type", "STRING", "NULLABLE"],
  ["purchased_at", "TIMESTAMP", "NULLABLE"], ["expiration_at", "TIMESTAMP", "NULLABLE"],
  ["entitlement_ids", "STRING", "REPEATED"], ["presented_offering_id", "STRING", "NULLABLE"],
  ["transaction_id", "STRING", "NULLABLE"], ["original_transaction_id", "STRING", "NULLABLE"],
  ["country_code", "STRING", "NULLABLE"], ["currency", "STRING", "NULLABLE"], ["price_in_purchased_currency", "FLOAT", "NULLABLE"],
  ["price_usd", "FLOAT", "NULLABLE"], ["revenue_usd", "FLOAT", "NULLABLE"], ["is_trial_conversion", "BOOLEAN", "NULLABLE"],
  ["cancel_reason", "STRING", "NULLABLE"], ["expiration_reason", "STRING", "NULLABLE"], ["payload", "JSON", "NULLABLE"],
];

const ts = (ms: unknown) => (typeof ms === "number" && Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : null);

export function bigQueryRow(e: Record<string, any>, reporting: unknown) {
  return {
    id: String(e.id), type: String(e.type), event_timestamp: ts(e.event_timestamp_ms),
    app_user_id: e.app_user_id ?? null, original_app_user_id: e.original_app_user_id ?? null, aliases: Array.isArray(e.aliases) ? e.aliases : [],
    app_id: e.app_id ?? null, environment: e.environment ?? null, store: e.store ?? null, product_id: e.product_id ?? null,
    new_product_id: e.new_product_id ?? null, period_type: e.period_type ?? null, purchased_at: ts(e.purchased_at_ms), expiration_at: ts(e.expiration_at_ms),
    entitlement_ids: Array.isArray(e.entitlement_ids) ? e.entitlement_ids : [], presented_offering_id: e.presented_offering_id ?? null,
    transaction_id: e.transaction_id ?? null, original_transaction_id: e.original_transaction_id ?? null, country_code: e.country_code ?? null,
    currency: e.currency ?? null, price_in_purchased_currency: typeof e.price_in_purchased_currency === "number" ? e.price_in_purchased_currency : null,
    price_usd: typeof e.price === "number" ? e.price : null, revenue_usd: typeof e.price === "number" ? revenueUsd(e, reporting) : null,
    is_trial_conversion: typeof e.is_trial_conversion === "boolean" ? e.is_trial_conversion : null,
    cancel_reason: e.cancel_reason ?? null, expiration_reason: e.expiration_reason ?? null, payload: JSON.stringify(e),
  };
}

export const bigQueryTablePath = (s: Record<string, any>) =>
  `/projects/${encodeURIComponent(s.project_id)}/datasets/${encodeURIComponent(s.dataset_id)}/tables/${encodeURIComponent(s.table_id || "revenuedot_events")}`;

/** `tables.insert` with RevenueDot's schema, partitioned by day on event_timestamp. */
export function bigQueryCreateTable(s: Record<string, any>, accessToken: string): OutRequest {
  const body = {
    tableReference: { projectId: s.project_id, datasetId: s.dataset_id, tableId: s.table_id || "revenuedot_events" },
    description: "RevenueDot purchase events (one row per event). https://revenuedot.app/docs/guides/integrations#bigquery",
    schema: { fields: BIGQUERY_SCHEMA.map(([name, type, mode]) => ({ name, type, mode })) },
    timePartitioning: { type: "DAY", field: "event_timestamp" },
  };
  return {
    method: "POST", url: `${BIGQUERY_API}/projects/${encodeURIComponent(s.project_id)}/datasets/${encodeURIComponent(s.dataset_id)}/tables`,
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` }, body: json(body),
  };
}

export async function buildBigQuery(i: BuildInput): Promise<Plan> {
  const s = i.settings;
  if (!s.project_id || !s.dataset_id) return skip("Set the BigQuery project and dataset.");
  const token = i.context?.accessToken;
  if (!token) return skip("No BigQuery service account is saved.");
  const body = { kind: "bigquery#tableDataInsertAllRequest", skipInvalidRows: false, ignoreUnknownValues: true, rows: [{ insertId: String(i.event.id), json: bigQueryRow(i.event, s.reporting) }] };
  return {
    name: String(i.event.type),
    requests: [{ method: "POST", url: `${BIGQUERY_API}${bigQueryTablePath(s)}/insertAll`, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: json(body) }],
    redact: [token],
  };
}
