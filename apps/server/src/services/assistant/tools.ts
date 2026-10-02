import { z } from "zod/v4";
import { CHARTS, parseStoreKitConfig } from "@revenuedot/core";
import { RevenueDotApiError, type RevenueDotClient } from "./client.js";

/**
 * RevenueDot AI's tools (prd/ai-assistant/PRD.md §2), in the MCP server's format (revenuedot/mcp `src/tools.ts`): name,
 * title, description, zod input shape, annotations, the API v2 scopes the tool needs, and `run(client, args)` built from
 * REST API v2 calls. Names and behaviour match the MCP tools where one exists (get-metrics, get-customer, list-customers,
 * grant-customer-entitlement ...), so one module can serve both later. Differences: there is no `project_id` argument
 * (a conversation belongs to one project), and results are compacted for the model (`compactResult`).
 */

export interface ToolAnnotations { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean }

export interface ToolDefinition<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: S;
  annotations: ToolAnnotations;
  /** API v2 permissions the tool needs. A tool whose scopes the user's role lacks is not offered. */
  scopes: string[];
  run(client: RevenueDotClient, args: z.infer<z.ZodObject<S>>): Promise<unknown>;
}

const define = <S extends z.ZodRawShape>(t: ToolDefinition<S>) => t as unknown as ToolDefinition;

const READ: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const CREATE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const ATTACH: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const DESTROY: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

/** A write tool changes something and always asks the user first. */
export const isWriteTool = (t: Pick<ToolDefinition, "annotations">) => !t.annotations.readOnlyHint;

const limit = z.number().int().min(1).max(100).optional().describe("Page size, 1 to 100 (default 20).");
const startingAfter = z.string().optional().describe("Cursor: the id of the last item of the previous page (from next_page).");
const environment = z.enum(["production", "sandbox"]).optional().describe("Only this environment (default: production for metrics, both for lists).");
const customerArg = z.string().min(1).describe("The app user id (any alias works).");
const enc = encodeURIComponent;
const P = async (c: RevenueDotClient) => `/v2/projects/${enc(await c.project())}`;

/** Timestamps: milliseconds since epoch, an ISO 8601 date, or a duration from now such as "30d", "12h", "1y". Same as the MCP server's. */
export function toEpochMs(v: number | string, now = Date.now()): number {
  if (typeof v === "number") return v < 1e11 ? v * 1000 : v;
  const s = v.trim();
  const d = /^(\d+)\s*(h|d|w|m|y)$/i.exec(s);
  if (d) {
    const n = Number(d[1]);
    const unit = d[2]!.toLowerCase();
    if (unit === "m" || unit === "y") { const t = new Date(now); t.setUTCMonth(t.getUTCMonth() + n * (unit === "y" ? 12 : 1)); return t.getTime(); }
    return now + n * { h: 3600_000, d: 86400_000, w: 7 * 86400_000 }[unit as "h" | "d" | "w"];
  }
  if (/^\d+$/.test(s)) return toEpochMs(Number(s), now);
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new RevenueDotApiError(400, "parameter_error", `expires_at: cannot read "${v}" as a date. Use milliseconds, an ISO date or a duration such as 30d.`, "expires_at");
  return t;
}

/** Entitlements may be named by id (entl...) or lookup key ("pro"); the API takes ids. */
async function entitlementId(c: RevenueDotClient, base: string, idOrKey: string) {
  if (/^entl/.test(idOrKey)) return idOrKey;
  const list = await c.request<{ items: { id: string; lookup_key: string }[] }>("GET", `${base}/entitlements`, { query: { limit: 100 } });
  return list.items.find((e) => e.id === idOrKey || e.lookup_key === idOrKey)?.id ?? idOrKey;
}

/** Offerings may be named by id (ofrng...) or lookup key. */
async function offeringId(c: RevenueDotClient, base: string, idOrKey: string) {
  if (/^ofrng/.test(idOrKey)) return idOrKey;
  const list = await c.request<{ items: { id: string; lookup_key: string }[] }>("GET", `${base}/offerings`, { query: { limit: 100 } });
  const o = list.items.find((e) => e.id === idOrKey || e.lookup_key === idOrKey);
  if (!o) throw new RevenueDotApiError(404, "resource_missing", `No offering with id or lookup key "${idOrKey}".`, "offering_id");
  return o.id;
}

const CHART_NAMES = CHARTS.map((c) => c.name) as [string, ...string[]];

/** A chart response cut to what a model needs: metadata, the summary, and at most 60 rows (newest last). */
export function compactChart(body: Record<string, any>, maxRows = 60) {
  const measures: { display_name: string; unit: string }[] = body.measures ?? [];
  const base = {
    chart: body.display_name, description: body.description, resolution: body.resolution, start_date: body.start_date, end_date: body.end_date,
    currency: body.yaxis_currency, measures: measures.map((m) => `${m.display_name} (${m.unit})`), summary: body.summary,
  };
  const iso = (secs: number) => new Date(secs * 1000).toISOString().slice(0, 10);
  const values: { cohort: number; measure?: number; segment?: number; period?: number; value: number | null; incomplete?: boolean }[] = body.values ?? [];
  if (body.periods) {
    const rows = new Map<number, Record<string, unknown>>();
    for (const v of values) {
      const r = rows.get(v.cohort) ?? { cohort: iso(v.cohort) };
      r[body.periods[v.period ?? 0]?.display_name ?? `period ${v.period}`] = v.value;
      rows.set(v.cohort, r);
    }
    return { ...base, rows: [...rows.values()].slice(-maxRows) };
  }
  if (body.segments) {
    const segs: { display_name: string }[] = body.segments;
    const rows = new Map<string, Record<string, unknown>>();
    for (const v of values) {
      if ((v.measure ?? 0) !== 0) continue;
      const key = `${v.cohort}`;
      const r = rows.get(key) ?? { date: iso(v.cohort) };
      r[segs[v.segment ?? 0]?.display_name ?? `segment ${v.segment}`] = v.value;
      rows.set(key, r);
    }
    return { ...base, segmented_by: segs.map((s) => s.display_name), rows: [...rows.values()].slice(-maxRows) };
  }
  const rows = new Map<number, Record<string, unknown>>();
  for (const v of values) {
    const r = rows.get(v.cohort) ?? { date: iso(v.cohort) };
    r[measures[v.measure ?? 0]?.display_name ?? `measure ${v.measure}`] = v.value;
    if (v.incomplete) r.incomplete = true;
    rows.set(v.cohort, r);
  }
  return { ...base, rows: [...rows.values()].slice(-maxRows) };
}

export const tools: ToolDefinition[] = [
  // ---- Read: metrics and charts
  define({
    name: "get-metrics", title: "Get revenue metrics",
    description: "Without metric: the overview cards (MRR, revenue, active subscriptions, active trials, new customers, active customers, last 28 days, USD). With metric: that metric's daily history over `days` days. Start here for questions about how the business is doing.",
    inputSchema: {
      metric: z.enum(["active_trials", "active_subscriptions", "mrr", "revenue", "new_customers", "active_users"]).optional().describe("Leave out for the overview."),
      days: z.number().int().min(1).max(366).optional().describe("History length in days (default 28). Only with metric."),
      environment: z.enum(["production", "sandbox"]).optional().describe("Default production; sandbox shows Test Store and sandbox purchases."),
    },
    annotations: READ, scopes: ["charts_metrics:overview:read"],
    run: async (c, a) => {
      const base = await P(c);
      return a.metric
        ? c.request("GET", `${base}/metrics/history`, { query: { metric: a.metric, days: a.days, environment: a.environment } })
        : c.request("GET", `${base}/metrics/overview`, { query: { environment: a.environment } });
    },
  }),
  define({
    name: "list-charts", title: "List charts",
    description: "The 43 charts the project has (name, group, what each measures). Use a name with get-chart.",
    inputSchema: {}, annotations: READ, scopes: ["charts_metrics:charts:read"],
    run: async () => ({ object: "list", items: CHARTS.map((ch) => ({ name: ch.name, display_name: ch.display_name, group: ch.group, description: ch.description, segments: ch.segmentable ? ch.dims : [] })) }),
  }),
  define({
    name: "get-chart", title: "Get chart",
    description: "One chart's data (production, USD unless asked): a summary (average and total) and up to 60 rows. Use for trends, cohorts, conversion, churn and segment comparisons. Dates are YYYY-MM-DD.",
    inputSchema: {
      chart: z.enum(CHART_NAMES).describe("Chart name, e.g. mrr, revenue, trial_conversion_rate, churn, actives, subscription_retention."),
      start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("First day (default: 30 days ago; 12 months for cohort tables)."),
      end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Last day (default today)."),
      resolution: z.enum(["day", "week", "month", "quarter", "year"]).optional(),
      segment: z.string().optional().describe("Split by app, store, product, product_duration, offering, country, platform or app_version."),
      environment,
      currency: z.string().length(3).optional().describe("ISO 4217 display currency, default USD."),
    },
    annotations: READ, scopes: ["charts_metrics:charts:read"],
    run: async (c, a) => compactChart(await c.request<Record<string, unknown>>("GET", `${await P(c)}/charts/${enc(a.chart)}`, {
      query: { start_date: a.start_date, end_date: a.end_date, resolution: a.resolution, segment: a.segment, environment: a.environment, currency: a.currency, limit_num_segments: a.segment ? 6 : undefined },
    })),
  }),

  // ---- Read: customers
  define({
    name: "list-customers", title: "Find customers",
    description: "Newest customers first, or a search: an exact app user id, the $email attribute, or a store transaction id. Use it to find who a support request is about, then call get-customer.",
    inputSchema: { search: z.string().optional().describe("App user id, email or store transaction id (exact match)."), limit, starting_after: startingAfter },
    annotations: READ, scopes: ["customer_information:customers:read"],
    run: async (c, a) => c.request("GET", `${await P(c)}/customers`, { query: { search: a.search, limit: a.limit ?? 20, starting_after: a.starting_after } }),
  }),
  define({
    name: "get-customer", title: "Get customer",
    description: "Looks up a customer by app user id: active entitlements, attributes, subscriptions (gives_access says whether each one grants access now) and one-time purchases.",
    inputSchema: { customer_id: customerArg },
    annotations: READ, scopes: ["customer_information:customers:read"],
    run: async (c, a) => {
      const base = `${await P(c)}/customers/${enc(a.customer_id)}`;
      const customer = await c.request<Record<string, unknown>>("GET", base, { query: { expand: "attributes" } });
      const optional = async (path: string) => {
        try { return (await c.request<{ items: unknown[] }>("GET", `${base}/${path}`, { query: { limit: 100 } })).items; }
        catch (e) { if (e instanceof RevenueDotApiError && e.status === 403) return { error: e.message }; throw e; }
      };
      return { ...customer, subscriptions: await optional("subscriptions"), purchases: await optional("purchases") };
    },
  }),
  define({
    name: "list-events", title: "List events",
    description: "The event log, newest first: the same events webhooks send (INITIAL_PURCHASE, RENEWAL, CANCELLATION, BILLING_ISSUE, EXPIRATION ...). Filter by customer to read a customer's history and see why they lost access.",
    inputSchema: {
      customer_id: z.string().optional().describe("Only this app user id."),
      types: z.array(z.string()).max(20).optional().describe("Only these event types, e.g. [\"CANCELLATION\", \"EXPIRATION\"]."), environment, limit, starting_after: startingAfter,
    },
    annotations: READ, scopes: ["customer_information:customers:read"],
    run: async (c, a) => c.request("GET", `${await P(c)}/events`, { query: { customer: a.customer_id, type: a.types, environment: a.environment, limit: a.limit ?? 20, starting_after: a.starting_after } }),
  }),
  define({
    name: "list-transactions", title: "List transactions",
    description: "Every purchase, renewal, trial start and refund, newest first, with price and USD revenue. Optionally one customer's or one environment's.",
    inputSchema: { customer_id: z.string().optional().describe("Only this app user id."), environment, limit, starting_after: startingAfter },
    annotations: READ, scopes: ["customer_information:purchases:read"],
    run: async (c, a) => c.request("GET", `${await P(c)}/transactions`, { query: { customer: a.customer_id, environment: a.environment, limit: a.limit ?? 20, starting_after: a.starting_after } }),
  }),

  // ---- Read: catalog
  define({
    name: "list-apps", title: "List apps",
    description: "Lists the project's apps (one per store: app_store, play_store, test_store, stripe ...), with their ids. Product creation needs an app id.",
    inputSchema: {}, annotations: READ, scopes: ["project_configuration:apps:read"],
    run: async (c) => c.request("GET", `${await P(c)}/apps`, { query: { limit: 100 } }),
  }),
  define({
    name: "list-products", title: "List products",
    description: "Lists the project's products (store product ids per app), optionally for one app.",
    inputSchema: { app_id: z.string().optional().describe("Only this app's products."), limit, starting_after: startingAfter },
    annotations: READ, scopes: ["project_configuration:products:read"],
    run: async (c, a) => c.request("GET", `${await P(c)}/products`, { query: { app_id: a.app_id, limit: a.limit ?? 100, starting_after: a.starting_after } }),
  }),
  define({
    name: "list-entitlements", title: "List entitlements",
    description: "Lists the project's entitlements (access levels such as pro) with the products that unlock each one.",
    inputSchema: {}, annotations: READ, scopes: ["project_configuration:entitlements:read"],
    run: async (c) => c.request("GET", `${await P(c)}/entitlements`, { query: { limit: 100, expand: "items.product" } }),
  }),
  define({
    name: "list-offerings", title: "List offerings",
    description: "Lists the project's offerings with their packages and each package's products. The current offering (is_current) is what the SDK shows by default.",
    inputSchema: {}, annotations: READ, scopes: ["project_configuration:offerings:read", "project_configuration:packages:read"],
    run: async (c) => c.request("GET", `${await P(c)}/offerings`, { query: { limit: 100, expand: "items.package.product" } }),
  }),

  // ---- Read: paywalls, targeting, experiments
  define({
    name: "list-paywalls", title: "List paywalls",
    description: "The project's paywalls: name, the offering each one is attached to, and whether and when it was published.",
    inputSchema: {}, annotations: READ, scopes: ["project_configuration:offerings:read"],
    run: async (c) => c.request("GET", `${await P(c)}/paywalls`, { query: { limit: 100 } }),
  }),
  define({
    name: "list-targeting-rules", title: "List targeting rules",
    description: "Targeting rules in priority order: which audience sees which offering, on which placements, with schedule and state.",
    inputSchema: {}, annotations: READ, scopes: ["project_configuration:offerings:read"],
    run: async (c) => c.request("GET", `${await P(c)}/targeting_rules`, { query: { limit: 100 } }),
  }),
  define({
    name: "list-experiments", title: "List experiments",
    description: "Offering A/B experiments with status (draft, running, paused, stopped), the two offerings and the enrollment percent.",
    inputSchema: {}, annotations: READ, scopes: ["project_configuration:offerings:read"],
    run: async (c) => c.request("GET", `${await P(c)}/experiments`, { query: { limit: 100 } }),
  }),
  define({
    name: "get-experiment-results", title: "Get experiment results",
    description: "An experiment's results per variant: enrolled customers, trials, conversions, revenue and the chance each variant is better.",
    inputSchema: { experiment_id: z.string().describe("Experiment id (see list-experiments).") },
    annotations: READ, scopes: ["project_configuration:offerings:read"],
    run: async (c, a) => c.request("GET", `${await P(c)}/experiments/${enc(a.experiment_id)}/results`),
  }),

  // ---- Read: health and delivery
  define({
    name: "get-project-health", title: "Get project health",
    description: "Setup health in one call: for each app whether the store credentials work and notifications arrive, plus whether webhooks are being delivered. Use it first when something looks wrong.",
    inputSchema: {}, annotations: READ, scopes: ["project_configuration:apps:read"],
    run: async (c) => c.request("GET", `${await P(c)}/setup_health`),
  }),
  define({
    name: "list-webhook-integrations", title: "List webhooks",
    description: "Lists the project's webhook integrations (URL, environment and event filters).",
    inputSchema: {}, annotations: READ, scopes: ["project_configuration:integrations:read"],
    run: async (c) => c.request("GET", `${await P(c)}/integrations/webhooks`, { query: { limit: 100 } }),
  }),
  define({
    name: "list-webhook-deliveries", title: "List webhook deliveries",
    description: "Delivery attempts for one webhook, newest first, with status, attempts, HTTP status and last error. Filter by status to find failures.",
    inputSchema: {
      webhook_id: z.string().describe("Webhook integration id (see list-webhook-integrations)."),
      status: z.enum(["pending", "delivered", "failed"]).optional().describe("Only deliveries in this state."), limit, starting_after: startingAfter,
    },
    annotations: READ, scopes: ["project_configuration:integrations:read"],
    run: async (c, a) => c.request("GET", `${await P(c)}/webhooks/${enc(a.webhook_id)}/deliveries`, { query: { status: a.status, limit: a.limit ?? 20, starting_after: a.starting_after } }),
  }),
  define({
    name: "list-integrations", title: "List integrations",
    description: "Partner integrations (Slack, Segment, Amplitude, Mixpanel, PostHog, Firebase, BigQuery, AppsFlyer, Adjust, Meta) with their recent delivery health. Credentials show only whether they are set.",
    inputSchema: {}, annotations: READ, scopes: ["project_configuration:integrations:read"],
    run: async (c) => {
      const base = await P(c);
      const list = await c.request<{ items: { id: string; type: string; name: string; enabled: boolean }[] }>("GET", `${base}/integrations/partners`, { query: { limit: 100 } });
      const items = [];
      for (const i of list.items) {
        const d = await c.request<{ items: { status: string; created_at: number; last_error?: string | null }[] }>("GET", `${base}/integrations/partners/${enc(i.id)}/deliveries`, { query: { limit: 50 } });
        const failed = d.items.filter((x) => x.status === "failed");
        items.push({ ...i, recent_deliveries: d.items.length, recent_failed: failed.length, last_error: failed[0]?.last_error ?? null });
      }
      return { object: "list", items };
    },
  }),
  define({
    name: "get-import-status", title: "Get import status",
    description: "After `npx revenuedot import` from RevenueCat: how many customers and subscriptions the project holds, and how many Google Play subscriptions still wait for a purchase token (per app).",
    inputSchema: {}, annotations: READ, scopes: ["customer_information:customers:read"],
    run: async (c) => c.request("GET", `${await P(c)}/import/status`),
  }),

  // ---- Write: customers (approval required)
  define({
    name: "grant-customer-entitlement", title: "Grant entitlement to customer",
    description: "Grants a customer time-limited access to an entitlement until expires_at, for support or goodwill. The access ends by itself and can be revoked with revoke-customer-entitlement. The customer is created if new. The user approves it in the chat first.",
    inputSchema: {
      customer_id: z.string().min(1).describe("The app user id."),
      entitlement_id: z.string().describe("Entitlement id (entl...) or lookup key such as pro."),
      expires_at: z.union([z.number(), z.string()]).describe("When access ends: milliseconds since epoch, an ISO 8601 date, or a duration from now such as 7d, 1m or 1y."),
    },
    annotations: { ...CREATE, idempotentHint: true }, scopes: ["customer_information:customers:read_write"],
    run: async (c, a) => {
      const pbase = await P(c);
      const id = await entitlementId(c, pbase, a.entitlement_id);
      const grant = () => c.request("POST", `${pbase}/customers/${enc(a.customer_id)}/actions/grant_entitlement`, { body: { entitlement_id: id, expires_at: toEpochMs(a.expires_at) } });
      try {
        return await grant();
      } catch (e) {
        if (!(e instanceof RevenueDotApiError && e.status === 404 && /^Customer/.test(e.message))) throw e;
        await c.request("POST", `${pbase}/customers`, { body: { id: a.customer_id } });
        return grant();
      }
    },
  }),
  define({
    name: "revoke-customer-entitlement", title: "Revoke granted entitlement",
    description: "Ends promotional access that was granted to a customer (with grant-customer-entitlement or the dashboard). Store purchases are not affected.",
    inputSchema: { customer_id: customerArg, entitlement_id: z.string().describe("Entitlement id (entl...) or lookup key.") },
    annotations: DESTROY, scopes: ["customer_information:customers:read_write"],
    run: async (c, a) => {
      const pbase = await P(c);
      const id = await entitlementId(c, pbase, a.entitlement_id);
      return c.request("POST", `${pbase}/customers/${enc(a.customer_id)}/actions/revoke_granted_entitlement`, { body: { entitlement_id: id } });
    },
  }),

  // ---- Write: catalog
  define({
    name: "create-product", title: "Create product",
    description: "Creates a product for one app. store_identifier is the product id in the store (App Store product id, Play subscription id such as pro:monthly, or any id for the Test Store). Set subscription_duration for subscriptions.",
    inputSchema: {
      app_id: z.string().describe("The app the product belongs to (see list-apps)."),
      store_identifier: z.string().min(1).describe("The store's product id, e.g. pro_monthly."),
      type: z.enum(["subscription", "one_time", "consumable", "non_consumable", "non_renewing_subscription"]).describe("Product type. Use subscription for auto-renewing plans."),
      display_name: z.string().optional().describe("Name shown in the dashboard."),
      subscription_duration: z.string().optional().describe("ISO 8601 period for subscriptions: P1W, P1M, P3M, P6M, P1Y."),
    },
    annotations: CREATE, scopes: ["project_configuration:products:read_write"],
    run: async (c, a) => c.request("POST", `${await P(c)}/products`, {
      body: { app_id: a.app_id, store_identifier: a.store_identifier, type: a.type, display_name: a.display_name, ...(a.subscription_duration ? { subscription: { duration: a.subscription_duration } } : {}) },
    }),
  }),
  define({
    name: "attach-products-to-entitlement", title: "Attach products to entitlement",
    description: "Makes products unlock an entitlement. Attach every store's version of a plan (iOS, Android, Test Store).",
    inputSchema: { entitlement_id: z.string().describe("Entitlement id (entl...) or lookup key."), product_ids: z.array(z.string()).min(1).max(50).describe("Product ids (prod...).") },
    annotations: ATTACH, scopes: ["project_configuration:entitlements:read_write"],
    run: async (c, a) => {
      const base = await P(c);
      const id = await entitlementId(c, base, a.entitlement_id);
      return c.request("POST", `${base}/entitlements/${enc(id)}/actions/attach_products`, { body: { product_ids: a.product_ids } });
    },
  }),
  define({
    name: "attach-products-to-package", title: "Attach products to package",
    description: "Puts products in a package, at most one per app (e.g. the iOS, Android and Test Store monthly products in $rc_monthly).",
    inputSchema: {
      package_id: z.string().describe("Package id (pkge...)."),
      product_ids: z.array(z.string()).min(1).max(50).describe("Product ids (prod...)."),
      eligibility_criteria: z.enum(["all", "google_sdk_lt_6", "google_sdk_ge_6"]).optional().describe("Google Play SDK eligibility; default all."),
    },
    annotations: ATTACH, scopes: ["project_configuration:packages:read_write"],
    run: async (c, a) => c.request("POST", `${await P(c)}/packages/${enc(a.package_id)}/actions/attach_products`, {
      body: { products: a.product_ids.map((product_id) => ({ product_id, eligibility_criteria: a.eligibility_criteria ?? "all" })) },
    }),
  }),
  define({
    name: "set-current-offering", title: "Set current offering",
    description: "Makes an offering the current one: the offering apps show by default when no targeting rule or experiment applies.",
    inputSchema: { offering_id: z.string().describe("Offering id (ofrng...) or lookup key.") },
    annotations: ATTACH, scopes: ["project_configuration:offerings:read_write"],
    run: async (c, a) => {
      const base = await P(c);
      const id = await offeringId(c, base, a.offering_id);
      return c.request("POST", `${base}/offerings/${enc(id)}`, { body: { is_current: true } });
    },
  }),
  define({
    name: "import-storekit-products", title: "Import StoreKit products",
    description: "Creates catalog products on an App Store app from a StoreKit configuration file the user attached (file_id from the attachment). Products that already exist on the app are skipped. Optionally only some product ids.",
    inputSchema: {
      app_id: z.string().describe("The App Store (or Test Store) app to create the products on (see list-apps)."),
      file_id: z.string().describe("The attached .storekit file's id (aif...)."),
      product_ids: z.array(z.string()).max(200).optional().describe("Only these StoreKit product ids. Default: all of them."),
    },
    annotations: CREATE, scopes: ["project_configuration:products:read_write"],
    run: async (c, a) => {
      const base = await P(c);
      const file = await c.request<{ text: string }>("GET", `${base}/ai/files/${enc(a.file_id)}`, { query: { format: "text" } });
      const parsed = parseStoreKitConfig(file.text);
      const have = new Set<string>();
      let after: string | undefined;
      for (let page = 0; page < 50; page++) {
        const existing = await c.request<{ items: { id: string; store_identifier: string }[]; next_page: string | null }>("GET", `${base}/products`, { query: { app_id: a.app_id, limit: 100, starting_after: after } });
        for (const p of existing.items) have.add(p.store_identifier);
        if (!existing.next_page || !existing.items.length) break;
        after = existing.items[existing.items.length - 1]!.id;
      }
      const want = a.product_ids?.length ? parsed.products.filter((p) => a.product_ids!.includes(p.productId)) : parsed.products;
      const created: string[] = [], skipped: string[] = [];
      for (const p of want) {
        if (have.has(p.productId)) { skipped.push(p.productId); continue; }
        await c.request("POST", `${base}/products`, {
          body: { app_id: a.app_id, store_identifier: p.productId, type: p.type, display_name: p.displayName ?? p.referenceName, ...(p.duration ? { subscription: { duration: p.duration } } : {}) },
        });
        created.push(p.productId);
      }
      return { object: "storekit_import", app_id: a.app_id, created, skipped_existing: skipped, warnings: parsed.warnings };
    },
  }),

  // ---- Write: experiments
  define({
    name: "start-experiment", title: "Start experiment",
    description: "Starts (or resumes) an offering experiment: new customers in its audience are enrolled and split between the two offerings.",
    inputSchema: { experiment_id: z.string().describe("Experiment id (see list-experiments).") },
    annotations: CREATE, scopes: ["project_configuration:offerings:read_write"],
    run: async (c, a) => c.request("POST", `${await P(c)}/experiments/${enc(a.experiment_id)}/actions/start`),
  }),
  define({
    name: "pause-experiment", title: "Pause experiment",
    description: "Pauses a running experiment: no new customers are enrolled; enrolled customers keep their variant.",
    inputSchema: { experiment_id: z.string().describe("Experiment id (see list-experiments).") },
    annotations: { ...ATTACH, destructiveHint: true }, scopes: ["project_configuration:offerings:read_write"],
    run: async (c, a) => c.request("POST", `${await P(c)}/experiments/${enc(a.experiment_id)}/actions/pause`),
  }),

  // ---- Write: webhook deliveries
  define({
    name: "retry-webhook-delivery", title: "Retry webhook delivery",
    description: "Sends a failed or pending webhook delivery again now.",
    inputSchema: { webhook_id: z.string().describe("Webhook integration id."), delivery_id: z.string().describe("Delivery id from list-webhook-deliveries.") },
    annotations: { ...ATTACH, openWorldHint: true }, scopes: ["project_configuration:integrations:read_write"],
    run: async (c, a) => c.request("POST", `${await P(c)}/webhooks/${enc(a.webhook_id)}/deliveries/${enc(a.delivery_id)}/retry`),
  }),
  define({
    name: "replay-failed-webhook-deliveries", title: "Replay failed webhook deliveries",
    description: "Sends every failed delivery of one webhook from the last `days` days again (at most 100).",
    inputSchema: { webhook_id: z.string().describe("Webhook integration id."), days: z.number().int().min(1).max(30).optional().describe("How far back, default 7.") },
    annotations: { ...ATTACH, openWorldHint: true }, scopes: ["project_configuration:integrations:read_write"],
    run: async (c, a) => {
      const base = await P(c);
      const since = Date.now() - (a.days ?? 7) * 86400_000;
      const retried: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 5 && retried.length < 100; page++) {
        const list = await c.request<{ items: { id: string; created_at: number }[]; next_page: string | null }>("GET", `${base}/webhooks/${enc(a.webhook_id)}/deliveries`, { query: { status: "failed", limit: 100, starting_after: cursor } });
        const fresh = list.items.filter((d) => d.created_at >= since);
        for (const d of fresh) {
          if (retried.length >= 100) break;
          await c.request("POST", `${base}/webhooks/${enc(a.webhook_id)}/deliveries/${enc(d.id)}/retry`);
          retried.push(d.id);
        }
        if (!list.next_page || fresh.length < list.items.length) break;
        cursor = list.items[list.items.length - 1]!.id;
      }
      return { object: "webhook_replay", webhook_id: a.webhook_id, retried: retried.length, delivery_ids: retried };
    },
  }),
];

export const toolsByName = new Map(tools.map((t) => [t.name, t]));

const SECRET_KEY = /(secret|password|passwd|private[_-]?key|credential|token|api[_-]?key|signing|authorization|shared[_-]?key|service[_-]?account|cookie|session)/i;
/** Keys that only say whether a secret is set, or show its last characters (`{ configured, hint }`): kept. */
const SAFE_KEY = /^(configured|hint|is_set|has_[a-z_]+|[a-z_]+_(configured|set))$/i;
/** Values that are secrets whatever their key: API keys and tokens with well-known prefixes, PEM keys, JWTs, Slack hooks, URL passwords. */
const SECRET_VALUE = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(sk|rk)_(live|test)_[A-Za-z0-9]{8,}/, /\bsk_[A-Za-z0-9_-]{16,}/, /\bwhsec_[A-Za-z0-9]{16,}/, /\brdat_[A-Za-z0-9_-]{16,}/,
  /\bsk-(ant-|proj-)?[A-Za-z0-9_-]{20,}/, /\bxox[abposr]-[A-Za-z0-9-]{10,}/, /\bgh[pousr]_[A-Za-z0-9]{20,}/, /\bAKIA[0-9A-Z]{16}\b/, /\bAIza[0-9A-Za-z_-]{30,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, /hooks\.slack\.com\/services\/[A-Za-z0-9/]+/, /:\/\/[^/\s:@]+:[^/\s@]+@/,
];
const HIDDEN = "[hidden]";

/**
 * Removes secret values from a tool result before the model sees it. Under a key that names a secret, every value is
 * hidden except booleans, null and `{ configured, hint }` style keys; anywhere else, a string that looks like a secret
 * (an API key, a private key, a token in a URL) is hidden too.
 */
export function redactSecrets(v: unknown, depth = 0, inSecret = false): unknown {
  if (depth > 12) return "[too deep]";
  if (Array.isArray(v)) return v.map((x) => redactSecrets(x, depth + 1, inSecret));
  if (typeof v === "string") return inSecret ? (v === "" ? v : HIDDEN) : SECRET_VALUE.some((r) => r.test(v)) ? HIDDEN : v;
  if (typeof v === "number" || typeof v === "bigint") return inSecret ? HIDDEN : v;
  if (!v || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (SAFE_KEY.test(k)) out[k] = typeof x === "boolean" || x === null ? x : redactSecrets(x, depth + 1, false);
    else out[k] = redactSecrets(x, depth + 1, inSecret || SECRET_KEY.test(k));
  }
  return out;
}

/** Epoch-millisecond fields (`ends_at`, `expires_date`, `date`) as ISO 8601 UTC: models misread raw milliseconds as dates. */
function readableTimes(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(readableTimes);
  if (!x || typeof x !== "object") return x;
  return Object.fromEntries(Object.entries(x).map(([k, y]) =>
    [k, typeof y === "number" && /(_at|_date)$|^date$/.test(k) && y >= 1e12 && y < 1e13 ? new Date(y).toISOString() : readableTimes(y)]));
}

/**
 * What the model (and the tool card) sees of a tool result: secrets hidden, timestamps readable, and under `max`
 * characters of JSON (long lists are cut and say how many items were left out).
 */
export function compactResult(v: unknown, max = 12_000): unknown {
  const clean = readableTimes(redactSecrets(v));
  if (JSON.stringify(clean ?? null).length <= max) return clean;
  const cut = (x: unknown, n: number): unknown => {
    if (Array.isArray(x)) return x.length > n ? [...x.slice(0, n).map((y) => cut(y, n)), { omitted: x.length - n }] : x.map((y) => cut(y, n));
    if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, cut(y, n)]));
    if (typeof x === "string" && x.length > 2000) return `${x.slice(0, 2000)}…`;
    return x;
  };
  for (const n of [50, 20, 10, 5, 2]) {
    const c = cut(clean, n);
    if (JSON.stringify(c).length <= max) return c;
  }
  return { truncated: true, preview: JSON.stringify(clean).slice(0, max) };
}
