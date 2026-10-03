/**
 * RevenueDot's own Stripe account (Circo), for RevenueDot Cloud billing only (prd/cloud-billing/PRD.md). Not the
 * developers' Stripe accounts (stores/stripe, services/web). Plain HTTPS with form bodies, so it runs on Workers and Node.
 * A live key is refused unless REVENUEDOT_BILLING_LIVE=true, so no development machine can charge anyone.
 */

export interface BillingConfig {
  secretKey: string;
  webhookSecret: string;
  /** The metered price of Cloud Standard ($0.01 a unit; the unit is one cent of the bill). */
  priceStandard: string;
  /** The Billing Meter's event name (aggregation "last"). */
  meterEvent: string;
  /** True only in production, with live keys. */
  live: boolean;
  /** Plan table (REVENUEDOT_BILLING_PLANS). */
  plansJson?: string;
  /** Tests point this at the fake. */
  apiBase?: string;
}

export const DEFAULT_METER_EVENT = "revenuedot_cloud_bill_cents";

export function billingConfigFromEnv(env: Record<string, string | undefined>): BillingConfig | undefined {
  const secretKey = env.REVENUEDOT_BILLING_STRIPE_SECRET_KEY?.trim();
  if (!secretKey) return env.REVENUEDOT_BILLING_PLANS ? { secretKey: "", webhookSecret: "", priceStandard: "", meterEvent: DEFAULT_METER_EVENT, live: false, plansJson: env.REVENUEDOT_BILLING_PLANS } : undefined;
  return {
    secretKey, webhookSecret: env.REVENUEDOT_BILLING_STRIPE_WEBHOOK_SECRET?.trim() ?? "", priceStandard: env.REVENUEDOT_BILLING_PRICE_STANDARD?.trim() ?? "",
    meterEvent: env.REVENUEDOT_BILLING_METER_EVENT?.trim() || DEFAULT_METER_EVENT, live: env.REVENUEDOT_BILLING_LIVE === "true", plansJson: env.REVENUEDOT_BILLING_PLANS,
  };
}

export class BillingStripeError extends Error {
  constructor(message: string, public status: number | null = null) { super(message); }
}

/** Why Stripe cannot be used now (null: ready). */
export function stripeProblem(c: BillingConfig | null | undefined): string | null {
  if (!c?.secretKey) return "Billing is not set up on this server yet (no Stripe key).";
  if (/^(sk|rk)_live_/.test(c.secretKey) && !c.live) return "A live Stripe key is set without REVENUEDOT_BILLING_LIVE=true; billing stays off so nobody is charged by accident.";
  if (!c.priceStandard) return "Billing is not set up on this server yet (no Cloud Standard price).";
  return null;
}

function form(params: Record<string, unknown>, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => { if (item && typeof item === "object") out.push(...form(item as Record<string, unknown>, `${key}[${i}]`)); else out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(item))}`); });
    else if (typeof v === "object") out.push(...form(v as Record<string, unknown>, key));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out;
}

/** The visitor and session ids DataFast's tracking script keeps in cookies; Stripe metadata names them exactly like this. */
export interface DatafastIds { datafast_visitor_id?: string; datafast_session_id?: string }
const DATAFAST_ID = /^[A-Za-z0-9-]{8,64}$/;

/** Reads the DataFast cookies from a request's Cookie header. Values that are not plain ids are dropped, so nothing else reaches Stripe. */
export function datafastIds(cookieHeader: string | null | undefined): DatafastIds | undefined {
  if (!cookieHeader) return undefined;
  const out: DatafastIds = {};
  for (const part of cookieHeader.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if ((name === "datafast_visitor_id" || name === "datafast_session_id") && DATAFAST_ID.test(value)) out[name] = value;
  }
  return out.datafast_visitor_id || out.datafast_session_id ? out : undefined;
}

export function billingStripe(c: BillingConfig, f: typeof fetch = fetch) {
  const base = (c.apiBase ?? "https://api.stripe.com").replace(/\/+$/, "");
  const call = async <T = Record<string, any>>(method: string, path: string, params?: Record<string, unknown>, idempotencyKey?: string): Promise<T> => {
    const problem = stripeProblem(c);
    if (problem) throw new BillingStripeError(problem);
    const headers: Record<string, string> = { authorization: `Bearer ${c.secretKey}`, "stripe-version": "2025-03-31.basil" };
    let url = `${base}${path}`;
    let body: string | undefined;
    if (params && (method === "GET" || method === "DELETE")) url += `?${form(params).join("&")}`;
    else if (params) { body = form(params).join("&"); headers["content-type"] = "application/x-www-form-urlencoded"; }
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    let res: Response;
    try { res = await f(url, { method, headers, body }); } catch (e) { throw new BillingStripeError(`Stripe did not answer: ${e instanceof Error ? e.message : e}`); }
    const json = await res.json().catch(() => ({})) as { error?: { message?: string } } & T;
    if (!res.ok) throw new BillingStripeError(json.error?.message ?? `Stripe answered HTTP ${res.status}.`, res.status);
    return json;
  };
  return {
    createCustomer: (o: { email: string; name?: string | null; userId: string }) =>
      call<{ id: string }>("POST", "/v1/customers", { email: o.email, name: o.name ?? undefined, metadata: { revenuedot_user_id: o.userId } }, `rd-customer-${o.userId}`),
    /** Checkout for Cloud Standard: monthly, anchored to the 1st of next month (UTC) without proration, so a Stripe period is a calendar month. */
    createCheckout: (o: { customer: string; userId: string; successUrl: string; cancelUrl: string; anchor: Date; datafast?: DatafastIds }) =>
      call<{ id: string; url: string }>("POST", "/v1/checkout/sessions", {
        mode: "subscription", customer: o.customer, client_reference_id: o.userId, success_url: o.successUrl, cancel_url: o.cancelUrl,
        line_items: [{ price: c.priceStandard }],
        // The DataFast ids on the session (and the subscription, which carries them to its invoices) let DataFast credit the
        // payment to the channel that brought the visitor (docs/analytics.md).
        subscription_data: { billing_cycle_anchor: Math.floor(o.anchor.getTime() / 1000), proration_behavior: "none", metadata: { revenuedot_user_id: o.userId, plan: "standard", ...o.datafast } },
        metadata: { revenuedot_user_id: o.userId, plan: "standard", ...o.datafast },
      }),
    createPortal: (o: { customer: string; returnUrl: string }) => call<{ id: string; url: string }>("POST", "/v1/billing_portal/sessions", { customer: o.customer, return_url: o.returnUrl }),
    /** The month's bill so far, in cents. The meter keeps the last value of the period ("last"). */
    meterEvent: (o: { customer: string; cents: number; identifier: string; timestamp: Date }) =>
      call("POST", "/v1/billing/meter_events", { event_name: c.meterEvent, payload: { stripe_customer_id: o.customer, value: String(o.cents) }, identifier: o.identifier, timestamp: Math.floor(o.timestamp.getTime() / 1000) }),
    getSubscription: (id: string) => call<Record<string, any>>("GET", `/v1/subscriptions/${encodeURIComponent(id)}`),
    /** Every subscription of a customer, in any status (newest first), so the account follows Stripe and not the event order. */
    listSubscriptions: async (customer: string) => (await call<{ data: Record<string, any>[] }>("GET", "/v1/subscriptions", { customer, status: "all", limit: 100 })).data,
    getInvoice: (id: string) => call<Record<string, any>>("GET", `/v1/invoices/${encodeURIComponent(id)}`),
    /** Ends a duplicate subscription at once, without proration or a final invoice. */
    cancelSubscription: (id: string) => call<Record<string, any>>("DELETE", `/v1/subscriptions/${encodeURIComponent(id)}`, { prorate: false, invoice_now: false }),
    listOpenCheckouts: async (customer: string) => (await call<{ data: Record<string, any>[] }>("GET", "/v1/checkout/sessions", { customer, status: "open", limit: 100 })).data,
    expireCheckout: (id: string) => call<Record<string, any>>("POST", `/v1/checkout/sessions/${encodeURIComponent(id)}/expire`),
  };
}
