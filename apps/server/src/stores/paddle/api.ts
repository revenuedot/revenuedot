import { Codes, RCError } from "../../errors.js";
import type { AppRow } from "../types.js";
import { guardedFetch, OutboundRefused } from "../../services/outbound.js";

/**
 * A small Paddle Billing client for the developer's own Paddle account (server-side API key). Reads subscriptions,
 * transactions, adjustments, products and prices, and creates customer portal sessions. https://developer.paddle.com/api-reference/overview
 *   live:    https://api.paddle.com
 *   sandbox: https://sandbox-api.paddle.com
 * The key decides the environment: `pdl_live_apikey_…` or `pdl_sdbx_apikey_…`. Keys from before that format carry no
 * environment, so `paddle_is_sandbox` decides (RevenueCat's v2 field).
 * Answers are `{ data, meta }`; errors `{ error: { type, code, detail }, meta }`. Amounts are strings in the currency's
 * lowest denomination.
 */
export const PADDLE_LIVE = "https://api.paddle.com";
export const PADDLE_SANDBOX = "https://sandbox-api.paddle.com";

export interface PaddleMoney { amount: string; currency_code: string }
export interface PaddleBillingCycle { interval: "day" | "week" | "month" | "year"; frequency: number }
export interface PaddlePrice {
  id: string; product_id: string; description?: string | null; name?: string | null; type?: string; status?: "active" | "archived";
  billing_cycle: PaddleBillingCycle | null; trial_period: PaddleBillingCycle | null; unit_price: PaddleMoney;
  unit_price_overrides?: Array<{ country_codes: string[]; unit_price: PaddleMoney }>; custom_data?: Record<string, unknown> | null;
}
export interface PaddleProduct { id: string; name: string; description?: string | null; type?: string; tax_category?: string; status: "active" | "archived"; custom_data?: Record<string, unknown> | null; prices?: PaddlePrice[] }
export interface PaddleSubscriptionItem {
  status: "active" | "inactive" | "trialing"; quantity: number; recurring: boolean; created_at?: string; updated_at?: string;
  previously_billed_at?: string | null; next_billed_at?: string | null; trial_dates?: { starts_at: string; ends_at: string } | null;
  price: PaddlePrice; product?: PaddleProduct | null;
}
export interface PaddleSubscription {
  id: string; status: "active" | "canceled" | "past_due" | "paused" | "trialing"; customer_id: string; address_id?: string; business_id?: string | null;
  currency_code: string; created_at: string; updated_at?: string; started_at: string | null; first_billed_at: string | null; next_billed_at: string | null;
  paused_at: string | null; canceled_at: string | null; collection_mode?: "automatic" | "manual";
  current_billing_period: { starts_at: string; ends_at: string } | null; billing_cycle: PaddleBillingCycle;
  scheduled_change: { action: "cancel" | "pause" | "resume"; effective_at: string; resume_at: string | null } | null;
  items: PaddleSubscriptionItem[]; custom_data: Record<string, unknown> | null; management_urls?: { update_payment_method: string | null; cancel: string } | null;
  discount?: unknown; import_meta?: unknown;
}
export interface PaddleTransactionItem { price: PaddlePrice; quantity: number; proration?: unknown }
export interface PaddleTransaction {
  id: string; status: "draft" | "ready" | "billed" | "paid" | "completed" | "canceled" | "past_due"; customer_id: string | null; address_id?: string | null;
  custom_data: Record<string, unknown> | null; currency_code: string;
  origin: "api" | "subscription_charge" | "subscription_payment_method_change" | "subscription_recurring" | "subscription_update" | "web";
  subscription_id: string | null; invoice_id?: string | null; invoice_number?: string | null; collection_mode?: string;
  billing_period: { starts_at: string; ends_at: string } | null; items: PaddleTransactionItem[];
  details?: { totals?: { subtotal: string; tax: string; total: string; grand_total?: string; discount?: string; fee?: string | null; earnings?: string | null; currency_code: string }; line_items?: Array<{ price_id: string; quantity: number; totals?: { total: string } }> } | null;
  payments?: Array<{ amount: string; status: string; created_at: string; captured_at: string | null; error_code?: string | null }>;
  address?: { country_code?: string | null } | null;
  created_at: string; updated_at?: string; billed_at: string | null;
}
export interface PaddleAdjustment {
  id: string; action: "credit" | "refund" | "chargeback" | "chargeback_reverse" | "chargeback_warning" | "credit_reverse";
  type?: "full" | "partial"; transaction_id: string; subscription_id: string | null; customer_id: string; reason?: string;
  currency_code: string; status: "pending_approval" | "approved" | "rejected" | "reversed";
  items?: Array<{ item_id: string; type: "full" | "partial" | "tax" | "proration"; amount: string }>;
  totals?: { subtotal: string; tax: string; total: string; fee?: string; earnings?: string; currency_code: string };
  created_at: string; updated_at?: string;
}
export interface PaddleEvent { event_id: string; event_type: string; occurred_at: string; notification_id?: string; data: Record<string, any> }

export class PaddleApiError extends Error {
  constructor(public kind: "not_found" | "invalid" | "credentials" | "transient", message: string, public status = 0, public code?: string) { super(message); }
}

/** Rejects with a TimeoutError after `ms`, also for fetch implementations that ignore the abort signal. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error("timed out"), { name: "TimeoutError" })), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
export interface PaddleClientOptions { fetch?: FetchFn; timeoutMs?: number }

export function paddleKeyOf(app: Pick<AppRow, "credentials">): string | null {
  const k = (app.credentials ?? {}).paddle_api_key;
  return typeof k === "string" && k.trim() ? k.trim() : null;
}

/** The environment a key belongs to: from its prefix, else the app's `paddle_is_sandbox` flag. */
export function paddleEnvOf(app: Pick<AppRow, "credentials">, key = paddleKeyOf(app)): "sandbox" | "live" {
  if (key && /^pdl_sdbx_/.test(key)) return "sandbox";
  if (key && /^pdl_live_/.test(key)) return "live";
  return (app.credentials ?? {}).paddle_is_sandbox === true ? "sandbox" : "live";
}

/** Paddle's API keys: `pdl_live_apikey_…` / `pdl_sdbx_apikey_…` (69 characters), or the 50-character keys from before 2025-05-06. Client-side tokens are not API keys. */
export const PADDLE_KEY_RE = /^(pdl_(live|sdbx)_apikey_[a-z\d]{26}_[a-zA-Z\d]{22}_[a-zA-Z\d]{3}|[a-z\d]{50})$/;

export class PaddleClient {
  readonly customFetch: boolean;
  readonly fetchImpl: FetchFn;
  readonly timeoutMs: number;
  constructor(opts: PaddleClientOptions = {}) {
    this.customFetch = !!opts.fetch;
    this.fetchImpl = opts.fetch ?? ((u, i) => fetch(u, i));
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  origin(app: Pick<AppRow, "credentials">) { return paddleEnvOf(app) === "sandbox" ? PADDLE_SANDBOX : PADDLE_LIVE; }

  async request<T>(app: Pick<AppRow, "credentials">, method: "GET" | "POST" | "PATCH", path: string, query: Record<string, string> = {}, json?: unknown): Promise<{ data: T; meta: any }> {
    const key = paddleKeyOf(app);
    if (!key) throw new RCError(500, Codes.STORE_PROBLEM, "This Paddle app has no API key yet. Add it in the app's settings.");
    const u = new URL(`${this.origin(app)}${path}`);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    const headers: Record<string, string> = { authorization: `Bearer ${key}`, accept: "application/json", "paddle-version": "1" };
    if (json !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      // Through the outbound guard, never following a redirect: the request carries the API key.
      res = await withTimeout(guardedFetch(this.fetchImpl, u.toString(), { method, headers, body: json !== undefined ? JSON.stringify(json) : undefined, signal: AbortSignal.timeout(this.timeoutMs) }), this.timeoutMs);
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      throw new PaddleApiError("transient", timedOut ? "Paddle timed out" : e instanceof OutboundRefused ? `The Paddle request was refused: ${e.message}` : "Paddle could not be reached");
    }
    const text = await res.text().catch(() => "");
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (res.ok && body && "data" in body) return body as { data: T; meta: any };
    const err = body?.error ?? {};
    const code = typeof err.code === "string" ? err.code : undefined;
    const message = typeof err.detail === "string" ? err.detail : `Paddle answered ${res.status}`;
    if (res.ok) throw new PaddleApiError("transient", "Paddle answered without data", res.status);
    if (res.status === 404) throw new PaddleApiError("not_found", message, 404, code);
    if (res.status === 401 || res.status === 403) throw new PaddleApiError("credentials", message, res.status, code);
    if (res.status === 400 || res.status === 409 || res.status === 422) throw new PaddleApiError("invalid", message, res.status, code);
    throw new PaddleApiError("transient", message, res.status, code);
  }

  async get<T>(app: Pick<AppRow, "credentials">, path: string, query: Record<string, string> = {}): Promise<T> {
    return (await this.request<T>(app, "GET", path, query)).data;
  }

  /** Every page of a list endpoint (`per_page=200`, following `meta.pagination.next`), up to `maxPages`. */
  async listAll<T>(app: Pick<AppRow, "credentials">, path: string, query: Record<string, string> = {}, maxPages = 25): Promise<{ data: T[]; truncated: boolean }> {
    const out: T[] = [];
    let next: string | null = null;
    for (let page = 0; page < maxPages; page++) {
      let r: { data: T[]; meta: any };
      if (next) {
        const u = new URL(next);
        // The next link is Paddle's own URL; only its path and query are used, with the app's origin and key.
        r = await this.request<T[]>(app, "GET", u.pathname, Object.fromEntries(u.searchParams));
      } else {
        r = await this.request<T[]>(app, "GET", path, { per_page: "200", ...query });
      }
      out.push(...(r.data ?? []));
      const p = r.meta?.pagination;
      if (!p?.has_more || !p.next || !(r.data ?? []).length) return { data: out, truncated: false };
      next = p.next;
    }
    return { data: out, truncated: true };
  }

  subscription(app: Pick<AppRow, "credentials">, id: string) {
    return this.get<PaddleSubscription>(app, `/subscriptions/${encodeURIComponent(id)}`);
  }
  transaction(app: Pick<AppRow, "credentials">, id: string) {
    return this.get<PaddleTransaction>(app, `/transactions/${encodeURIComponent(id)}`, { include: "address" });
  }
  /** A subscription's newest transactions, newest first (with the address, for the country). */
  async recentTransactions(app: Pick<AppRow, "credentials">, subscriptionId: string): Promise<PaddleTransaction[]> {
    const r = await this.request<PaddleTransaction[]>(app, "GET", "/transactions", { subscription_id: subscriptionId, status: "completed,paid,billed,past_due", order_by: "billed_at[DESC]", per_page: "10", include: "address" });
    return r.data ?? [];
  }
  /** Creates a notification destination, or updates `id`, and returns it with its secret key. */
  notificationSetting(app: Pick<AppRow, "credentials">, body: Record<string, unknown>, id?: string | null) {
    return this.request<{ id: string; endpoint_secret_key: string; destination: string; active: boolean }>(app, id ? "PATCH" : "POST", id ? `/notification-settings/${encodeURIComponent(id)}` : "/notification-settings", {}, body).then((r) => r.data);
  }
  /** Approved refunds and chargebacks against one transaction. */
  async adjustments(app: Pick<AppRow, "credentials">, transactionId: string): Promise<PaddleAdjustment[]> {
    const r = await this.request<PaddleAdjustment[]>(app, "GET", "/adjustments", { transaction_id: transactionId, per_page: "50" });
    return r.data ?? [];
  }
  /** A short-lived authenticated customer portal link for one subscription (needs Customer portal session write access). */
  async portalSession(app: Pick<AppRow, "credentials">, customerId: string, subscriptionId: string): Promise<string | null> {
    const r = await this.request<{ urls?: { general?: { overview?: string }; subscriptions?: Array<{ id: string; cancel_subscription?: string; update_subscription_payment_method?: string }> } }>(
      app, "POST", `/customers/${encodeURIComponent(customerId)}/portal-sessions`, {}, { subscription_ids: [subscriptionId] });
    return r.data?.urls?.general?.overview ?? null;
  }
}

/** Paddle failures as the receipt endpoint must answer them: never 4xx for anything that can succeed later. */
export function toRCError(e: unknown): unknown {
  if (!(e instanceof PaddleApiError)) return e;
  if (e.kind === "not_found" || e.kind === "invalid") return new RCError(400, Codes.INVALID_RECEIPT, `Paddle: ${e.message}`);
  if (e.kind === "credentials") return new RCError(500, Codes.STORE_PROBLEM, `Paddle credentials problem: ${e.message}`);
  return new RCError(503, Codes.STORE_PROBLEM, `Paddle is temporarily unavailable: ${e.message}. Try again later.`);
}
