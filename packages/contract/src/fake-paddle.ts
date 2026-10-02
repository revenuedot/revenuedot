/**
 * A stateful fake of one Paddle Billing account (https://developer.paddle.com/api-reference/overview): products, prices,
 * customers, subscriptions, transactions and adjustments in Paddle's documented shapes, list pagination
 * (`meta.pagination`), errors (`{ error: { type, code, detail } }`) and signed webhooks (`Paddle-Signature: ts=…;h1=…`).
 * Lifecycle helpers (`buy`, `renew`, `failRenewal`, `scheduleCancel`, `cancelNow`, `pause`, `resume`, `refund`, `changePlan`)
 * move the account the way Paddle would and return the events Paddle would send. Used by the server tests, the dashboard's
 * e2e server and the journeys. It never calls Paddle and accepts only its own keys.
 */

// Built from parts so secret scanners do not take these test-only values for real Paddle keys.
const fakeKey = (env: "sdbx" | "live", id: string, body: string) => ["pdl", env, "apikey", id, body, "abc"].join("_");
export const FAKE_PADDLE_KEY = fakeKey("sdbx", "01fakeonlyrevenuedot000000", "FakeOnlyRevenueDotKey0");
export const FAKE_PADDLE_LIVE_KEY = fakeKey("live", "01fakeonlyrevenuedot000000", "FakeOnlyRevenueDotKey0");
export const FAKE_PADDLE_SECRET = "pdl_ntfset_01fakeonlyrevenuedot_FakeOnlyNotificationSecretKey";
/** A key Paddle accepts but that may not read subscriptions (403 forbidden). */
export const FAKE_PADDLE_LIMITED_KEY = fakeKey("sdbx", "01fakeonlylimited000000000", "FakeLimitedRevenueDot0");

type Obj = Record<string, any>;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const reqId = () => crypto.randomUUID();
const err = (status: number, type: string, code: string, detail: string) =>
  json(status, { error: { type, code, detail, documentation_url: `https://developer.paddle.com/v1/errors/shared/${code}` }, meta: { request_id: reqId() } });

const ID_ALPHABET = "abcdefghjkmnpqrstvwxyz0123456789";
let seq = 0;
/** Paddle ids: a prefix and 26 lowercase characters (`sub_01h…`). */
export function paddleId(prefix: string) {
  seq++;
  const tail = Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join("");
  return `${prefix}_01${String(seq).padStart(4, "0")}${tail}`;
}

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, ".000000Z");
const DAY = 86_400_000;
export function addCycle(d: Date, c: { interval: string; frequency: number }): Date {
  const x = new Date(d);
  if (c.interval === "day") return new Date(x.getTime() + c.frequency * DAY);
  if (c.interval === "week") return new Date(x.getTime() + c.frequency * 7 * DAY);
  if (c.interval === "month") { x.setUTCMonth(x.getUTCMonth() + c.frequency); return x; }
  x.setUTCFullYear(x.getUTCFullYear() + c.frequency);
  return x;
}

async function hmac(secret: string, payload: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))), (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface PaddleWebhook { body: string; signature: string; event: Obj }

export class FakePaddleAccount {
  keys = new Set([FAKE_PADDLE_KEY]);
  limitedKeys = new Set([FAKE_PADDLE_LIMITED_KEY]);
  /** "sandbox" accounts answer on sandbox-api.paddle.com only, "live" on api.paddle.com. */
  environment: "sandbox" | "live" = "sandbox";
  secret = FAKE_PADDLE_SECRET;
  products = new Map<string, Obj>();
  prices = new Map<string, Obj>();
  customers = new Map<string, Obj>();
  subscriptions = new Map<string, Obj>();
  transactions = new Map<string, Obj>();
  adjustments = new Map<string, Obj>();
  notificationSettings = new Map<string, Obj>();
  calls: Array<{ method: string; url: string; auth: string | null }> = [];
  /** Answer every API call with this status (Paddle down, rate limited). */
  outage: number | null = null;
  now: () => Date = () => new Date();

  constructor(o: { environment?: "sandbox" | "live"; keys?: string[]; now?: () => Date } = {}) {
    if (o.environment) this.environment = o.environment;
    if (o.keys) this.keys = new Set(o.keys);
    if (o.now) this.now = o.now;
  }

  // ---- Catalog ----------------------------------------------------------------------------------------------------
  product(o: { name: string; id?: string; status?: "active" | "archived"; custom_data?: Obj | null }) {
    const p = { id: o.id ?? paddleId("pro"), name: o.name, description: null, type: "standard", tax_category: "standard", image_url: null, custom_data: o.custom_data ?? null, status: o.status ?? "active", import_meta: null, created_at: iso(this.now()), updated_at: iso(this.now()) };
    this.products.set(p.id, p);
    return p;
  }
  price(o: { product: string; amount: number; currency?: string; interval?: "day" | "week" | "month" | "year" | null; frequency?: number; trialDays?: number | null; id?: string; description?: string; status?: "active" | "archived"; name?: string | null }) {
    const recurring = o.interval !== null && o.interval !== undefined;
    const p = {
      id: o.id ?? paddleId("pri"), product_id: o.product, description: o.description ?? (recurring ? `${o.frequency ?? 1} ${o.interval}` : "One-time"), name: o.name ?? null, type: "standard",
      billing_cycle: recurring ? { interval: o.interval, frequency: o.frequency ?? 1 } : null,
      trial_period: o.trialDays ? { interval: "day", frequency: o.trialDays } : null, tax_mode: "account_setting",
      unit_price: { amount: String(o.amount), currency_code: (o.currency ?? "USD").toUpperCase() }, unit_price_overrides: [],
      quantity: { minimum: 1, maximum: 1 }, status: o.status ?? "active", custom_data: null, import_meta: null, created_at: iso(this.now()), updated_at: iso(this.now()),
    };
    this.prices.set(p.id, p);
    return p;
  }
  customer(email = "buyer@example.com") {
    const c = { id: paddleId("ctm"), name: null, email, marketing_consent: false, status: "active", custom_data: null, locale: "en", created_at: iso(this.now()), updated_at: iso(this.now()) };
    this.customers.set(c.id, c);
    return c;
  }

  // ---- Lifecycle -----------------------------------------------------------------------------------------------------
  private item(price: Obj, status: string, o: { trialEnd?: Date | null; next?: Date | null; prev?: Date | null }) {
    const { product_id } = price;
    return {
      status, quantity: 1, recurring: true, created_at: iso(this.now()), updated_at: iso(this.now()),
      previously_billed_at: o.prev ? iso(o.prev) : null, next_billed_at: o.next ? iso(o.next) : null,
      trial_dates: o.trialEnd ? { starts_at: iso(this.now()), ends_at: iso(o.trialEnd) } : null,
      price, product: this.products.get(product_id) ?? null,
    };
  }

  private txn(o: { sub?: Obj | null; price: Obj; origin: string; status: string; start?: Date; end?: Date | null; customData?: Obj | null; customer: string; amount?: number; country?: string }) {
    const amount = o.amount ?? Number(o.price.unit_price.amount);
    const tax = Math.round(amount * 0.1);
    const now = this.now();
    const t = {
      id: paddleId("txn"), status: o.status, customer_id: o.customer, address_id: paddleId("add"), business_id: null, custom_data: o.customData ?? null,
      origin: o.origin, collection_mode: "automatic", subscription_id: o.sub?.id ?? null, invoice_id: o.status === "completed" ? paddleId("inv") : null,
      invoice_number: o.status === "completed" ? `${now.getUTCFullYear()}-${String(seq).padStart(5, "0")}` : null,
      billing_details: null, billing_period: o.start && o.end ? { starts_at: iso(o.start), ends_at: iso(o.end) } : null, currency_code: o.price.unit_price.currency_code,
      discount_id: null, created_at: iso(now), updated_at: iso(now), billed_at: o.status === "completed" || o.status === "past_due" ? iso(now) : null,
      items: [{ price: o.price, quantity: 1, proration: null }],
      details: {
        tax_rates_used: [{ tax_rate: "0.1", totals: { subtotal: String(amount - tax), discount: "0", tax: String(tax), total: String(amount) } }],
        totals: { subtotal: String(amount - tax), discount: "0", tax: String(tax), total: String(amount), credit: "0", credit_to_balance: "0", balance: "0", grand_total: String(amount), fee: o.status === "completed" ? String(Math.round(amount * 0.05) + 50) : null, earnings: o.status === "completed" ? String(amount - tax - Math.round(amount * 0.05) - 50) : null, currency_code: o.price.unit_price.currency_code },
        line_items: [{ id: paddleId("txnitm"), price_id: o.price.id, quantity: 1, proration: null, tax_rate: "0.1", unit_totals: { subtotal: String(amount - tax), discount: "0", tax: String(tax), total: String(amount) }, totals: { subtotal: String(amount - tax), discount: "0", tax: String(tax), total: String(amount) }, product: this.products.get(o.price.product_id) ?? null }],
      },
      payments: o.status === "completed" ? [{ payment_attempt_id: crypto.randomUUID(), stored_payment_method_id: crypto.randomUUID(), amount: String(amount), status: "captured", error_code: null, method_details: { type: "card", card: { type: "visa", last4: "4242", expiry_month: 1, expiry_year: 2030, cardholder_name: "Test" } }, created_at: iso(now), captured_at: iso(now) }]
        : o.status === "past_due" ? [{ payment_attempt_id: crypto.randomUUID(), amount: String(amount), status: "error", error_code: "declined", method_details: { type: "card" }, created_at: iso(now), captured_at: null }] : [],
      checkout: { url: null }, address: { id: paddleId("add"), country_code: o.country ?? "US", postal_code: "10001" },
    };
    this.transactions.set(t.id, t);
    return t;
  }

  /**
   * A customer buys `priceId` in Paddle Checkout: a subscription (trialing when the price has a trial) and its first
   * transaction, or a one-time transaction. `customData` is what the checkout passed (Paddle copies it to both).
   */
  buy(priceId: string, o: { customData?: Obj | null; customer?: string; country?: string } = {}): { subscription: Obj | null; transaction: Obj; events: Obj[] } {
    const price = this.prices.get(priceId);
    if (!price) throw new Error(`no price ${priceId}`);
    const customer = o.customer ?? this.customer().id;
    const now = this.now();
    if (!price.billing_cycle) {
      const t = this.txn({ price, origin: "web", status: "completed", customData: o.customData, customer, country: o.country });
      return { subscription: null, transaction: t, events: [this.ev("transaction.paid", t), this.ev("transaction.completed", t)] };
    }
    const trialEnd = price.trial_period ? addCycle(now, price.trial_period) : null;
    const end = trialEnd ?? addCycle(now, price.billing_cycle);
    const sub: Obj = {
      id: paddleId("sub"), status: trialEnd ? "trialing" : "active", customer_id: customer, address_id: paddleId("add"), business_id: null, currency_code: price.unit_price.currency_code,
      created_at: iso(now), updated_at: iso(now), started_at: iso(now), first_billed_at: trialEnd ? null : iso(now), next_billed_at: iso(end), paused_at: null, canceled_at: null,
      collection_mode: "automatic", billing_details: null, current_billing_period: { starts_at: iso(now), ends_at: iso(end) }, billing_cycle: price.billing_cycle,
      scheduled_change: null, items: [this.item(price, trialEnd ? "trialing" : "active", { trialEnd, next: end, prev: trialEnd ? null : now })],
      custom_data: o.customData ?? null, management_urls: { update_payment_method: `https://${this.environment === "sandbox" ? "sandbox-" : ""}customer-portal.paddle.com/update`, cancel: `https://${this.environment === "sandbox" ? "sandbox-" : ""}customer-portal.paddle.com/cancel` },
      discount: null, import_meta: null,
    };
    this.subscriptions.set(sub.id, sub);
    // A trial is a zero-amount transaction; a paid start charges the first period.
    const t = this.txn({ sub, price, origin: "web", status: "completed", start: now, end, customData: o.customData, customer, amount: trialEnd ? 0 : undefined, country: o.country });
    return { subscription: sub, transaction: t, events: [this.ev("transaction.completed", t), this.ev("subscription.created", sub), this.ev(trialEnd ? "subscription.trialing" : "subscription.activated", sub)] };
  }

  private period(sub: Obj) { return { start: new Date(sub.current_billing_period.starts_at), end: new Date(sub.current_billing_period.ends_at) }; }

  /** Paddle bills the next period: a `subscription_recurring` transaction, completed (or past due when the charge fails). */
  renew(subId: string, o: { fail?: boolean } = {}): { transaction: Obj; events: Obj[] } {
    const sub = this.subscriptions.get(subId)!;
    const price = sub.items[0].price;
    const { end } = this.period(sub);
    const next = addCycle(end, sub.billing_cycle);
    if (o.fail) {
      const t = this.txn({ sub, price, origin: "subscription_recurring", status: "past_due", start: end, end: next, customData: sub.custom_data, customer: sub.customer_id });
      sub.status = "past_due";
      sub.current_billing_period = { starts_at: iso(end), ends_at: iso(next) };
      sub.next_billed_at = iso(next);
      sub.items = [this.item(price, "active", { next, prev: end })];
      sub.updated_at = iso(this.now());
      return { transaction: t, events: [this.ev("transaction.past_due", t), this.ev("transaction.payment_failed", t), this.ev("subscription.past_due", sub)] };
    }
    const t = this.txn({ sub, price, origin: "subscription_recurring", status: "completed", start: end, end: next, customData: sub.custom_data, customer: sub.customer_id });
    sub.status = "active";
    sub.first_billed_at ??= iso(end);
    sub.current_billing_period = { starts_at: iso(end), ends_at: iso(next) };
    sub.next_billed_at = iso(next);
    sub.items = [this.item(price, "active", { next, prev: end })];
    sub.updated_at = iso(this.now());
    return { transaction: t, events: [this.ev("transaction.completed", t), this.ev("subscription.updated", sub)] };
  }

  /** A past-due renewal is paid after all (Paddle's retry or the customer updated the card). */
  recover(subId: string): { transaction: Obj; events: Obj[] } {
    const sub = this.subscriptions.get(subId)!;
    const t = [...this.transactions.values()].reverse().find((x) => x.subscription_id === subId && x.status === "past_due")!;
    t.status = "completed"; t.billed_at = iso(this.now()); t.updated_at = iso(this.now());
    t.payments = [{ amount: t.details.totals.total, status: "captured", error_code: null, method_details: { type: "card" }, created_at: iso(this.now()), captured_at: iso(this.now()) }];
    sub.status = "active"; sub.updated_at = iso(this.now());
    return { transaction: t, events: [this.ev("transaction.completed", t), this.ev("subscription.updated", sub)] };
  }

  /** The customer cancels in the portal: canceled at the end of the billing period (`scheduled_change.action: cancel`). */
  scheduleCancel(subId: string): Obj[] {
    const sub = this.subscriptions.get(subId)!;
    sub.scheduled_change = { action: "cancel", effective_at: sub.current_billing_period.ends_at, resume_at: null };
    sub.next_billed_at = null;
    sub.updated_at = iso(this.now());
    return [this.ev("subscription.updated", sub)];
  }
  /** Removes a scheduled change (the customer changed their mind). */
  unscheduleChange(subId: string): Obj[] {
    const sub = this.subscriptions.get(subId)!;
    sub.scheduled_change = null;
    sub.next_billed_at = sub.current_billing_period?.ends_at ?? null;
    sub.updated_at = iso(this.now());
    return [this.ev("subscription.updated", sub)];
  }
  /** The subscription ends now (a scheduled cancellation took effect, an immediate cancel, or dunning gave up). */
  cancelNow(subId: string): Obj[] {
    const sub = this.subscriptions.get(subId)!;
    sub.status = "canceled";
    sub.canceled_at = iso(this.now());
    sub.scheduled_change = null;
    sub.next_billed_at = null;
    sub.current_billing_period = null;
    sub.items = sub.items.map((i: Obj) => ({ ...i, status: "inactive", next_billed_at: null }));
    sub.updated_at = iso(this.now());
    return [this.ev("subscription.canceled", sub)];
  }
  /** Paused now (the scheduled pause took effect); `resumeAt` when the pause has an end. */
  pause(subId: string, resumeAt: Date | null = null): Obj[] {
    const sub = this.subscriptions.get(subId)!;
    sub.status = "paused";
    sub.paused_at = iso(this.now());
    sub.current_billing_period = null;
    sub.next_billed_at = null;
    sub.scheduled_change = resumeAt ? { action: "resume", effective_at: iso(resumeAt), resume_at: iso(resumeAt) } : null;
    sub.updated_at = iso(this.now());
    return [this.ev("subscription.paused", sub)];
  }
  /** Resumed: a new billing period starts now and is charged. */
  resume(subId: string): { transaction: Obj; events: Obj[] } {
    const sub = this.subscriptions.get(subId)!;
    const price = sub.items[0].price;
    const now = this.now();
    const next = addCycle(now, sub.billing_cycle);
    const t = this.txn({ sub, price, origin: "subscription_recurring", status: "completed", start: now, end: next, customData: sub.custom_data, customer: sub.customer_id });
    sub.status = "active"; sub.paused_at = null; sub.scheduled_change = null;
    sub.current_billing_period = { starts_at: iso(now), ends_at: iso(next) }; sub.next_billed_at = iso(next);
    sub.items = [this.item(price, "active", { next, prev: now })];
    sub.updated_at = iso(now);
    return { transaction: t, events: [this.ev("transaction.completed", t), this.ev("subscription.resumed", sub)] };
  }
  /**
   * A plan change: `immediately` prorates now (a `subscription_update` transaction, same billing period), otherwise the new
   * price applies from the next renewal (Paddle has no scheduled item change; the item is replaced and billed next period).
   */
  changePlan(subId: string, priceId: string): { transaction: Obj | null; events: Obj[] } {
    const sub = this.subscriptions.get(subId)!;
    const price = this.prices.get(priceId)!;
    const { start, end } = this.period(sub);
    sub.items = [this.item(price, "active", { next: end, prev: start })];
    sub.billing_cycle = price.billing_cycle;
    sub.updated_at = iso(this.now());
    const t = this.txn({ sub, price, origin: "subscription_update", status: "completed", start, end, customData: sub.custom_data, customer: sub.customer_id, amount: Math.round(Number(price.unit_price.amount) / 3) });
    return { transaction: t, events: [this.ev("transaction.completed", t), this.ev("subscription.updated", sub)] };
  }
  /** A refund (or chargeback) of a transaction, approved by Paddle. */
  refund(transactionId: string, o: { partial?: boolean; action?: "refund" | "chargeback"; status?: "pending_approval" | "approved" | "rejected" } = {}): { adjustment: Obj; events: Obj[] } {
    const t = this.transactions.get(transactionId)!;
    const total = Number(t.details.totals.total);
    const amount = o.partial ? Math.round(total / 2) : total;
    const now = iso(this.now());
    const a = {
      id: paddleId("adj"), action: o.action ?? "refund", type: o.partial ? "partial" : "full", transaction_id: t.id, subscription_id: t.subscription_id, customer_id: t.customer_id,
      reason: "Customer asked for a refund", credit_applied_to_balance: null, currency_code: t.currency_code, status: o.status ?? "approved",
      items: [{ id: paddleId("adjitm"), item_id: t.details.line_items[0].id, type: o.partial ? "partial" : "full", amount: String(amount), proration: null, totals: { subtotal: String(amount), tax: "0", total: String(amount) } }],
      totals: { subtotal: String(amount), tax: "0", total: String(amount), fee: "0", earnings: String(-amount), currency_code: t.currency_code }, payout_totals: null, created_at: now, updated_at: now,
    };
    this.adjustments.set(a.id, a);
    return { adjustment: a, events: [this.ev("adjustment.created", a)] };
  }
  approve(adjustmentId: string): Obj[] {
    const a = this.adjustments.get(adjustmentId)!;
    a.status = "approved"; a.updated_at = iso(this.now());
    return [this.ev("adjustment.updated", a)];
  }

  // ---- Webhooks ----------------------------------------------------------------------------------------------------
  ev(type: string, data: Obj): Obj {
    return { event_id: paddleId("evt"), event_type: type, occurred_at: iso(this.now()), notification_id: paddleId("ntf"), data: structuredClone(data) };
  }
  /** The body and `Paddle-Signature` header Paddle sends for one event. */
  async sign(event: Obj, o: { secret?: string; at?: Date } = {}): Promise<PaddleWebhook> {
    const body = JSON.stringify(event);
    const ts = Math.floor((o.at ?? this.now()).getTime() / 1000);
    return { body, event, signature: `ts=${ts};h1=${await hmac(o.secret ?? this.secret, `${ts}:${body}`)}` };
  }

  // ---- API ---------------------------------------------------------------------------------------------------------
  fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init.method ?? "GET").toUpperCase();
    const auth = new Headers(init.headers).get("authorization");
    this.calls.push({ method, url, auth });
    const u = new URL(url);
    const expectedHost = this.environment === "sandbox" ? "sandbox-api.paddle.com" : "api.paddle.com";
    if (this.outage) return err(this.outage, "api_error", this.outage === 429 ? "too_many_requests" : "internal_error", "Paddle is unavailable.");
    const key = (auth ?? "").replace(/^Bearer /, "");
    if (!key) return err(403, "request_error", "authentication_missing", "Authentication header missing.");
    if (u.hostname !== expectedHost) return err(403, "request_error", "invalid_token", "Invalid or revoked API key.");
    if (!this.keys.has(key) && !this.limitedKeys.has(key)) return err(403, "request_error", "invalid_token", "Invalid or revoked API key.");
    const parts = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const q = u.searchParams;
    if (this.limitedKeys.has(key) && parts[0] !== "event-types") return err(403, "request_error", "forbidden", "You aren't permitted to perform this request.");
    const one = (map: Map<string, Obj>, id: string | undefined, what: string) => {
      const o = id ? map.get(id) : undefined;
      return o ? json(200, { data: o, meta: { request_id: reqId() } }) : err(404, "request_error", "not_found", `${what} ${id} not found.`);
    };
    const list = (all: Obj[]) => {
      const per = Math.min(Number(q.get("per_page") ?? 50), 200);
      const after = q.get("after");
      const start = after ? all.findIndex((x) => x.id === after) + 1 : 0;
      const page = all.slice(start, start + per);
      const more = start + per < all.length;
      const nq = new URLSearchParams(q); if (page.length) nq.set("after", page[page.length - 1]!.id);
      return json(200, { data: page, meta: { request_id: reqId(), pagination: { per_page: per, next: `${u.origin}${u.pathname}?${nq}`, has_more: more, estimated_total: all.length } } });
    };
    const statusIn = (x: Obj) => !q.get("status") || q.get("status")!.split(",").includes(x.status);
    if (method === "GET" && parts[0] === "event-types") return json(200, { data: [{ name: "subscription.created", description: "", group: "Subscription", available_versions: [1] }], meta: { request_id: reqId() } });
    if (method === "GET" && parts[0] === "subscriptions") {
      if (parts[1]) return one(this.subscriptions, parts[1], "Subscription");
      return list([...this.subscriptions.values()].filter(statusIn));
    }
    if (method === "GET" && parts[0] === "transactions") {
      if (parts[1]) return one(this.transactions, parts[1], "Transaction");
      const sub = q.get("subscription_id");
      let all = [...this.transactions.values()].filter((t) => (!sub || t.subscription_id === sub) && statusIn(t));
      if (q.get("order_by")?.startsWith("billed_at[DESC]")) all = all.reverse();
      return list(all);
    }
    if (method === "GET" && parts[0] === "adjustments") {
      const tx = q.get("transaction_id");
      return list([...this.adjustments.values()].filter((a) => !tx || tx.split(",").includes(a.transaction_id)));
    }
    if (method === "GET" && parts[0] === "products") {
      if (parts[1]) return one(this.products, parts[1], "Product");
      const include = q.get("include")?.split(",") ?? [];
      return list([...this.products.values()].filter(statusIn).map((p) => (include.includes("prices") ? { ...p, prices: [...this.prices.values()].filter((x) => x.product_id === p.id) } : p)));
    }
    if (method === "GET" && parts[0] === "prices") return list([...this.prices.values()].filter(statusIn).filter((p) => !q.get("product_id") || p.product_id === q.get("product_id")));
    if (method === "POST" && parts[0] === "customers" && parts[2] === "portal-sessions") {
      if (!this.customers.has(parts[1]!)) return err(404, "request_error", "not_found", `Customer ${parts[1]} not found.`);
      const body = JSON.parse(typeof init.body === "string" ? init.body : "{}") as { subscription_ids?: string[] };
      const base = `https://${this.environment === "sandbox" ? "sandbox-" : ""}customer-portal.paddle.com/cpl_01fake`;
      return json(201, { data: { id: paddleId("cpls"), customer_id: parts[1], urls: { general: { overview: `${base}?action=overview&token=pga_fake` }, subscriptions: (body.subscription_ids ?? []).map((id) => ({ id, cancel_subscription: `${base}?action=cancel_subscription&subscription_id=${id}&token=pga_fake`, update_subscription_payment_method: `${base}?action=update_subscription_payment_method&subscription_id=${id}&token=pga_fake` })) }, created_at: iso(this.now()) }, meta: { request_id: reqId() } });
    }
    if (parts[0] === "notification-settings") {
      const body = JSON.parse(typeof init.body === "string" && init.body ? init.body : "{}") as Obj;
      if (method === "GET" && !parts[1]) return json(200, { data: [...this.notificationSettings.values()], meta: { request_id: reqId() } });
      if (method === "POST" && !parts[1]) {
        if (typeof body.destination !== "string" || !Array.isArray(body.subscribed_events)) return err(400, "request_error", "bad_request", "destination and subscribed_events are required.");
        const ns = { id: paddleId("ntfset"), description: body.description ?? "", type: body.type ?? "url", destination: body.destination, active: true, api_version: body.api_version ?? 1,
          include_sensitive_fields: !!body.include_sensitive_fields, traffic_source: body.traffic_source ?? "platform", subscribed_events: body.subscribed_events.map((name: string) => ({ name, description: name, group: name.split(".")[0], available_versions: [1] })),
          endpoint_secret_key: `pdl_ntfset_01${paddleId("x").slice(4)}_${Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[b % 62]).join("")}` };
        this.notificationSettings.set(ns.id, ns);
        this.secret = ns.endpoint_secret_key;
        return json(201, { data: ns, meta: { request_id: reqId() } });
      }
      if (method === "PATCH" && parts[1]) {
        const ns = this.notificationSettings.get(parts[1]);
        if (!ns) return err(404, "request_error", "not_found", `Notification setting ${parts[1]} not found.`);
        Object.assign(ns, body.destination ? { destination: body.destination } : {}, body.active !== undefined ? { active: body.active } : {}, Array.isArray(body.subscribed_events) ? { subscribed_events: body.subscribed_events.map((name: string) => ({ name })) } : {});
        return json(200, { data: ns, meta: { request_id: reqId() } });
      }
    }
    return err(404, "request_error", "not_found", `${method} ${u.pathname} is not a Paddle endpoint this fake serves.`);
  }) as typeof fetch;
}
