/**
 * A stateful fake of RevenueDot's own Stripe account, for RevenueDot Cloud billing tests (prd/cloud-billing/PRD.md):
 * customers, Checkout Sessions in subscription mode, the Customer Portal, Billing Meter events, subscriptions and invoices,
 * in Stripe's documented shapes (https://docs.stripe.com/api). `complete()` stands in for paying on Checkout; `send()`
 * signs an event with the webhook secret the way Stripe does. It never calls Stripe and accepts only its own test key.
 */
import { parseStripeForm } from "./fake-stripe.js";

export const FAKE_BILLING_KEY = "sk_test_51FakeOnlyRevenueDotCloudBilling00000000000000";
export const FAKE_BILLING_WEBHOOK_SECRET = "whsec_fake_revenuedot_cloud_billing";
export const FAKE_BILLING_PRICE = "price_test_cloud_standard_metered";

type Obj = Record<string, any>;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const err = (status: number, message: string) => json(status, { error: { type: "invalid_request_error", message } });

async function sign(secret: string, payload: string, t: number) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`))), (b) => b.toString(16).padStart(2, "0")).join("");
  return `t=${t},v1=${sig}`;
}

export class FakeBillingStripe {
  customers = new Map<string, Obj>();
  sessions = new Map<string, Obj>();
  subscriptions = new Map<string, Obj>();
  invoices = new Map<string, Obj>();
  meterEvents: Obj[] = [];
  portalSessions: Obj[] = [];
  calls: { method: string; path: string; params: Obj; idempotencyKey: string | null }[] = [];
  checkoutUrl = "https://checkout.stripe.com/c/pay/{id}";
  portalUrl = "https://billing.stripe.com/p/session/{id}";
  clock: () => Date = () => new Date();
  /** When true, reads of subscriptions and invoices fail with a 500, as during a Stripe outage. */
  failReads = false;
  private seq = 0;
  private idem = new Map<string, Response>();
  private id(prefix: string) { return `${prefix}_test_${(++this.seq).toString(36).padStart(4, "0")}`; }
  private now() { return Math.floor(this.clock().getTime() / 1000); }

  fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(url);
    if (u.host !== "api.stripe.com") throw new Error(`FakeBillingStripe does not serve ${url}`);
    const headers = new Headers(init.headers);
    const method = (init.method ?? "GET").toUpperCase();
    const params = method === "POST" ? parseStripeForm(typeof init.body === "string" ? init.body : "") : Object.fromEntries(u.searchParams);
    const idempotencyKey = headers.get("idempotency-key");
    this.calls.push({ method, path: u.pathname, params, idempotencyKey });
    if (headers.get("authorization") !== `Bearer ${FAKE_BILLING_KEY}`) return err(401, "Invalid API Key provided.");
    if (idempotencyKey && this.idem.has(idempotencyKey)) return this.idem.get(idempotencyKey)!.clone();
    const res = this.route(method, u.pathname, params);
    if (idempotencyKey && res.ok) this.idem.set(idempotencyKey, res.clone());
    return res;
  }) as typeof fetch;

  private route(method: string, path: string, p: Obj): Response {
    if (method === "POST" && path === "/v1/customers") {
      const c = { id: this.id("cus"), object: "customer", email: p.email ?? null, name: p.name ?? null, metadata: p.metadata ?? {}, created: this.now() };
      this.customers.set(c.id, c);
      return json(200, c);
    }
    if (method === "POST" && path === "/v1/checkout/sessions") {
      if (p.mode !== "subscription") return err(400, "This fake handles subscription mode only.");
      if (!this.customers.has(p.customer)) return err(400, `No such customer: '${p.customer}'`);
      if (p.line_items?.[0]?.price !== FAKE_BILLING_PRICE) return err(400, `No such price: '${p.line_items?.[0]?.price}'`);
      if (p.line_items?.[0]?.quantity !== undefined) return err(400, "Quantity cannot be set for a metered price.");
      const id = this.id("cs");
      const s = { id, object: "checkout.session", mode: "subscription", status: "open", customer: p.customer, client_reference_id: p.client_reference_id ?? null, success_url: p.success_url, cancel_url: p.cancel_url, subscription: null, subscription_data: p.subscription_data ?? {}, metadata: p.metadata ?? {}, url: this.checkoutUrl.replace("{id}", id) };
      this.sessions.set(id, s);
      return json(200, s);
    }
    if (method === "POST" && path === "/v1/billing_portal/sessions") {
      if (!this.customers.has(p.customer)) return err(400, `No such customer: '${p.customer}'`);
      const id = this.id("bps");
      const s = { id, object: "billing_portal.session", customer: p.customer, return_url: p.return_url, url: this.portalUrl.replace("{id}", id) };
      this.portalSessions.push(s);
      return json(200, s);
    }
    if (method === "POST" && path === "/v1/billing/meter_events") {
      if (!p.event_name || !p.payload?.stripe_customer_id || p.payload?.value === undefined) return err(400, "event_name, payload[stripe_customer_id] and payload[value] are required.");
      if (!/^\d+$/.test(String(p.payload.value))) return err(400, "payload[value] must be a whole number.");
      if (p.identifier && this.meterEvents.some((e) => e.identifier === p.identifier)) return err(400, `An event already exists with identifier ${p.identifier}.`);
      const ts = Number(p.timestamp ?? this.now());
      if (ts < this.now() - 35 * 86400 || ts > this.now() + 300) return err(400, "timestamp must be within the past 35 days or up to 5 minutes in the future.");
      const e = { object: "billing.meter_event", event_name: p.event_name, identifier: p.identifier ?? this.id("mev"), payload: p.payload, timestamp: ts, created: this.now() };
      this.meterEvents.push(e);
      return json(200, e);
    }
    const sub = /^\/v1\/subscriptions\/([^/]+)$/.exec(path);
    if (method === "GET" && sub) return this.subscriptions.has(sub[1]!) ? json(200, this.subscriptions.get(sub[1]!)) : err(404, `No such subscription: '${sub[1]}'`);
    if (method === "DELETE" && sub) {
      const x = this.subscriptions.get(sub[1]!);
      if (!x) return err(404, `No such subscription: '${sub[1]}'`);
      Object.assign(x, { status: "canceled", canceled_at: this.now(), ended_at: this.now(), cancel_at: null, cancel_at_period_end: false });
      return json(200, x);
    }
    if (method === "GET" && path === "/v1/subscriptions") {
      if (this.failReads) return err(500, "An error occurred with our connection to Stripe.");
      const data = [...this.subscriptions.values()].filter((x) => !p.customer || x.customer === p.customer).filter((x) => p.status === "all" || (p.status ? x.status === p.status : x.status !== "canceled")).sort((a, b) => b.created - a.created);
      return json(200, { object: "list", data, has_more: false, url: "/v1/subscriptions" });
    }
    const inv = /^\/v1\/invoices\/([^/]+)$/.exec(path);
    if (method === "GET" && inv) {
      if (this.failReads) return err(500, "An error occurred with our connection to Stripe.");
      return this.invoices.has(inv[1]!) ? json(200, this.invoices.get(inv[1]!)) : err(404, `No such invoice: '${inv[1]}'`);
    }
    if (method === "GET" && path === "/v1/checkout/sessions") {
      const data = [...this.sessions.values()].filter((x) => (!p.customer || x.customer === p.customer) && (!p.status || x.status === p.status));
      return json(200, { object: "list", data, has_more: false, url: "/v1/checkout/sessions" });
    }
    const exp = /^\/v1\/checkout\/sessions\/([^/]+)\/expire$/.exec(path);
    if (method === "POST" && exp) {
      const x = this.sessions.get(exp[1]!);
      if (!x) return err(404, `No such checkout session: '${exp[1]}'`);
      if (x.status !== "open") return err(400, "Only Checkout Sessions with a status in [\"open\"] can be expired.");
      x.status = "expired";
      return json(200, x);
    }
    return err(404, `Unrecognized request URL (${method}: ${path}).`);
  }

  /** The customer pays on Checkout: the subscription starts (anchored as asked) and checkout.session.completed is due. */
  complete(sessionId: string): { session: Obj; subscription: Obj } {
    const s = this.sessions.get(sessionId)!;
    if (s.status !== "open") throw new Error(`Checkout session ${sessionId} is ${s.status}`);
    const anchor = Number(s.subscription_data?.billing_cycle_anchor ?? this.now() + 30 * 86400);
    const subscription = {
      id: this.id("sub"), object: "subscription", customer: s.customer, status: "active", cancel_at: null, cancel_at_period_end: false,
      metadata: s.subscription_data?.metadata ?? {}, created: this.now(),
      items: { object: "list", data: [{ id: this.id("si"), price: { id: FAKE_BILLING_PRICE, recurring: { usage_type: "metered", interval: "month" } }, current_period_start: this.now(), current_period_end: anchor }] },
    };
    this.subscriptions.set(subscription.id, subscription);
    Object.assign(s, { status: "complete", subscription: subscription.id });
    return { session: s, subscription };
  }

  /** Changes an invoice the way a payment retry would (status, amount paid). */
  updateInvoice(id: string, change: Obj): Obj {
    const i = this.invoices.get(id)!;
    Object.assign(i, change);
    return i;
  }

  /** A snapshot of an object as an event would carry it (events hold the object as it was then). */
  snapshot<T>(o: T): T { return JSON.parse(JSON.stringify(o)); }

  /** Changes a subscription the way the Customer Portal or dunning would (status, cancel at period end). */
  updateSubscription(id: string, change: Obj): Obj {
    const s = this.subscriptions.get(id)!;
    Object.assign(s, change);
    return s;
  }

  invoice(customer: string, o: { amount_due: number; status: "open" | "paid" | "uncollectible"; period_start?: number; period_end?: number; subscription?: string; attempt_count?: number }): Obj {
    const id = this.id("in");
    const inv = {
      id, object: "invoice", customer, number: `RD-${String(this.invoices.size + 1).padStart(4, "0")}`, status: o.status, amount_due: o.amount_due, amount_paid: o.status === "paid" ? o.amount_due : 0,
      currency: "usd", period_start: o.period_start ?? this.now() - 30 * 86400, period_end: o.period_end ?? this.now(), hosted_invoice_url: `https://invoice.stripe.com/i/${id}`, invoice_pdf: `https://pay.stripe.com/invoice/${id}/pdf`, created: this.now(),
      attempt_count: o.attempt_count ?? (o.status === "open" ? 1 : o.status === "paid" ? 1 : 0),
      // 2025-03-31.basil: the subscription moved under parent.subscription_details.
      parent: o.subscription ? { type: "subscription_details", subscription_details: { subscription: o.subscription } } : null,
    };
    this.invoices.set(id, inv);
    return inv;
  }

  /** An event body and its Stripe-Signature header, signed with the webhook secret. */
  async event(type: string, object: Obj, secret = FAKE_BILLING_WEBHOOK_SECRET): Promise<{ body: string; signature: string }> {
    const body = JSON.stringify({ id: this.id("evt"), object: "event", type, created: this.now(), livemode: false, data: { object } });
    return { body, signature: await sign(secret, body, this.now()) };
  }
}
