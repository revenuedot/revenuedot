import { Codes, RCError } from "../../errors.js";
import type { AppRow } from "../types.js";
import { guardedFetch, OutboundRefused } from "../../services/outbound.js";

/**
 * A small Stripe API client for the developer's own account (restricted key). Only reads: subscriptions, Checkout
 * Sessions, invoices and invoice payments. https://docs.stripe.com/api
 * No API version is pinned: the account's default applies, the same version its webhook payloads use. Shapes from
 * before and after 2025-03-31 ("basil": period fields on subscription items, invoice links under `parent`) are both read.
 */
export const STRIPE_API = "https://api.stripe.com";

export type Expandable<T> = string | T | null;
export interface StripePrice { id: string; product: Expandable<{ id: string }>; unit_amount?: number | null; currency?: string; currency_options?: Record<string, { unit_amount?: number | null }> | null; recurring?: { interval?: string; interval_count?: number } | null; type?: string }
export interface StripeSubscriptionItem { id?: string; price: StripePrice; quantity?: number | null; current_period_start?: number; current_period_end?: number }
export interface StripeInvoice {
  id: string; object?: "invoice"; status?: string | null; paid?: boolean; amount_paid?: number; amount_due?: number; total?: number; currency?: string;
  billing_reason?: string | null; subscription?: Expandable<{ id: string }>; parent?: { subscription_details?: { subscription?: Expandable<{ id: string }> } | null } | null;
  period_start?: number; period_end?: number; next_payment_attempt?: number | null; customer_address?: { country?: string | null } | null;
  status_transitions?: { paid_at?: number | null } | null; livemode?: boolean; lines?: { data?: Array<{ period?: { start?: number; end?: number }; price?: StripePrice | null; pricing?: { price_details?: { price?: string; product?: string } } }> };
}
export interface StripeSubscription {
  id: string; object?: "subscription"; status: string; livemode: boolean; customer: Expandable<{ id: string }>;
  created?: number; start_date?: number; current_period_start?: number; current_period_end?: number;
  trial_start?: number | null; trial_end?: number | null; cancel_at_period_end?: boolean; cancel_at?: number | null; canceled_at?: number | null; ended_at?: number | null;
  cancellation_details?: { reason?: string | null } | null; pause_collection?: { behavior?: string; resumes_at?: number | null } | null;
  items: { data: StripeSubscriptionItem[] }; latest_invoice?: Expandable<StripeInvoice>; metadata?: Record<string, string> | null; currency?: string;
}
export interface StripeCheckoutSession {
  id: string; object?: "checkout.session"; mode: "payment" | "subscription" | "setup"; status?: "open" | "complete" | "expired" | null; payment_status?: string;
  livemode: boolean; customer?: Expandable<{ id: string }>; subscription?: Expandable<StripeSubscription>; payment_intent?: Expandable<{ id: string }>;
  client_reference_id?: string | null; metadata?: Record<string, string> | null; created?: number; currency?: string | null; amount_total?: number | null;
  customer_details?: { address?: { country?: string | null } | null } | null;
  line_items?: { data: Array<{ id?: string; price?: StripePrice | null; quantity?: number | null; amount_total?: number; currency?: string }> };
}
export interface StripeCharge {
  id: string; object?: "charge"; amount: number; amount_refunded: number; refunded: boolean; currency?: string; created?: number; livemode?: boolean;
  invoice?: Expandable<{ id: string }>; payment_intent?: Expandable<{ id: string }>; refunds?: { data?: Array<{ created?: number; status?: string }> };
}
export interface StripeEvent { id: string; object?: "event"; type: string; created: number; livemode: boolean; api_version?: string | null; data: { object: Record<string, any>; previous_attributes?: Record<string, unknown> } }

export class StripeApiError extends Error {
  constructor(public kind: "not_found" | "invalid" | "credentials" | "transient", message: string, public status = 0, public code?: string) { super(message); }
}

/** Rejects with a TimeoutError after `ms`, also for fetch implementations that ignore the abort signal. */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error("timed out"), { name: "TimeoutError" })), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
export interface StripeClientOptions { fetch?: FetchFn; timeoutMs?: number }

export const idOf = (v: Expandable<{ id: string }> | undefined) => (v && typeof v === "object" ? v.id : v ?? null);

export function stripeKeyOf(app: Pick<AppRow, "credentials">): string | null {
  const k = (app.credentials ?? {}).stripe_secret_key;
  return typeof k === "string" && k.trim() ? k.trim() : null;
}
/** Test-mode keys (and the keys of Stripe sandboxes) start with rk_test_ or sk_test_. */
export const isTestKey = (key: string) => /^(rk|sk)_test_/.test(key);

export class StripeClient {
  readonly customFetch: boolean;
  readonly fetchImpl: FetchFn;
  readonly timeoutMs: number;
  constructor(opts: StripeClientOptions = {}) {
    this.customFetch = !!opts.fetch;
    this.fetchImpl = opts.fetch ?? ((u, i) => fetch(u, i));
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  /** GET with the app's key. `query` values that are arrays repeat (expand[]=a&expand[]=b). */
  get<T>(app: Pick<AppRow, "credentials">, path: string, query: Record<string, string | string[]> = {}): Promise<T> {
    return this.request<T>(app, "GET", path, query);
  }

  /**
   * POST (form-encoded, Stripe's format: `a[b][0][c]=v`) or DELETE with the app's key. Web billing creates products,
   * prices, Checkout Sessions, coupons and promotion codes this way (prd/web-billing/PRD.md). `idempotencyKey` makes a
   * retried create return the first object.
   */
  post<T>(app: Pick<AppRow, "credentials">, path: string, params: Record<string, unknown> = {}, idempotencyKey?: string): Promise<T> {
    return this.request<T>(app, "POST", path, {}, stripeForm(params), idempotencyKey);
  }
  del<T>(app: Pick<AppRow, "credentials">, path: string): Promise<T> {
    return this.request<T>(app, "DELETE", path);
  }

  async request<T>(app: Pick<AppRow, "credentials">, method: "GET" | "POST" | "DELETE", path: string, query: Record<string, string | string[]> = {}, form?: string, idempotencyKey?: string): Promise<T> {
    const key = stripeKeyOf(app);
    if (!key) {
      throw new RCError(500, Codes.STORE_PROBLEM, (app.credentials ?? {}).stripe_connected === true
        ? "This app is connected with Stripe Connect, but this server has no Stripe Connect platform key for the connection's mode (REVENUEDOT_STRIPE_CONNECT_SECRET_KEY)."
        : "This Stripe app has no API key yet. Add a restricted key in the app's settings.");
    }
    const u = new URL(`${STRIPE_API}${path}`);
    for (const [k, v] of Object.entries(query)) for (const x of Array.isArray(v) ? v : [v]) u.searchParams.append(k, x);
    const headers: Record<string, string> = { authorization: `Bearer ${key}`, accept: "application/json" };
    if (form !== undefined) headers["content-type"] = "application/x-www-form-urlencoded";
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    const account = (app.credentials ?? {}).stripe_account_id;
    if (typeof account === "string" && /^acct_/.test(account.trim())) headers["stripe-account"] = account.trim();
    let res: Response;
    try {
      // Through the outbound guard, never following a redirect: the request carries the API key.
      res = await withTimeout(guardedFetch(this.fetchImpl, u.toString(), { method, headers, body: form, signal: AbortSignal.timeout(this.timeoutMs) }), this.timeoutMs);
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      throw new StripeApiError("transient", timedOut ? "Stripe timed out" : e instanceof OutboundRefused ? `The Stripe request was refused: ${e.message}` : "Stripe could not be reached");
    }
    const text = await res.text().catch(() => "");
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (res.ok && body) return body as T;
    const err = body?.error ?? {};
    const message = typeof err.message === "string" ? err.message : `Stripe answered ${res.status}`;
    // "No such subscription: 'sub_…'; a similar object exists in live mode, but a test mode key was used to make this
    // request." The purchase exists, the key is the wrong one: a credentials problem the developer must fix, not a bad receipt.
    const otherMode = res.status === 404 ? /a similar object exists in (live|test) mode/i.exec(message) : null;
    if (otherMode) {
      const has = otherMode[1]!.toLowerCase();
      throw new StripeApiError("credentials", `This purchase is in ${has} mode, but the app's Stripe key is a ${has === "live" ? "test" : "live"} mode key. Use a ${has} mode key for this app. Stripe said: ${message}`, 404, err.code);
    }
    if (res.status === 404) throw new StripeApiError("not_found", message, 404, err.code);
    if (res.status === 401 || res.status === 403) throw new StripeApiError("credentials", message, res.status, err.code);
    if (res.status === 400 || res.status === 402) throw new StripeApiError("invalid", message, res.status, err.code);
    throw new StripeApiError("transient", message, res.status, err.code);
  }

  subscription(app: Pick<AppRow, "credentials">, id: string) {
    return this.get<StripeSubscription>(app, `/v1/subscriptions/${encodeURIComponent(id)}`, { "expand[]": ["latest_invoice", "items.data.price.currency_options"] });
  }
  checkoutSession(app: Pick<AppRow, "credentials">, id: string) {
    return this.get<StripeCheckoutSession>(app, `/v1/checkout/sessions/${encodeURIComponent(id)}`, { "expand[]": ["line_items"] });
  }
  invoice(app: Pick<AppRow, "credentials">, id: string) {
    return this.get<StripeInvoice>(app, `/v1/invoices/${encodeURIComponent(id)}`);
  }
  /** The invoice a PaymentIntent paid (API 2025-03-31 and later: charges no longer name their invoice). */
  async invoiceForPaymentIntent(app: Pick<AppRow, "credentials">, paymentIntent: string): Promise<string | null> {
    try {
      const r = await this.get<{ data?: Array<{ invoice?: Expandable<{ id: string }> }> }>(app, "/v1/invoice_payments", { "payment[type]": "payment_intent", "payment[payment_intent]": paymentIntent, limit: "1" });
      return idOf(r.data?.[0]?.invoice) ?? null;
    } catch (e) {
      if (e instanceof StripeApiError && (e.kind === "not_found" || e.kind === "invalid")) return null;
      throw e;
    }
  }
}

/**
 * Stripe's form encoding: nested objects and arrays become bracketed keys (`metadata[app_user_id]`,
 * `line_items[0][price]`); null and undefined are left out; booleans are "true"/"false".
 * https://docs.stripe.com/api/request-body-encoding (application/x-www-form-urlencoded)
 */
export function stripeForm(params: Record<string, unknown>): string {
  const out = new URLSearchParams();
  const walk = (prefix: string, v: unknown) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) { v.forEach((x, i) => walk(`${prefix}[${i}]`, x)); return; }
    if (typeof v === "object") { for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(prefix ? `${prefix}[${k}]` : k, x); return; }
    out.append(prefix, String(v));
  };
  walk("", params);
  return out.toString();
}

/** Stripe failures as the receipt endpoint must answer them: never 4xx for anything that can succeed later. */
export function toRCError(e: unknown): unknown {
  if (!(e instanceof StripeApiError)) return e;
  if (e.kind === "not_found" || e.kind === "invalid") return new RCError(400, Codes.INVALID_RECEIPT, `Stripe: ${e.message}`);
  if (e.kind === "credentials") return new RCError(500, Codes.STORE_PROBLEM, `Stripe credentials problem: ${e.message}`);
  return new RCError(503, Codes.STORE_PROBLEM, `Stripe is temporarily unavailable: ${e.message}. Try again later.`);
}
